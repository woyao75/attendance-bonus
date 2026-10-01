import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import nodemailer from "nodemailer";
import sharp from "sharp";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";
import { ingestMail } from "./mail-agent.js";
import { archiveTask } from "./task-lifecycle.js";

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  const parsed = new URL(testUrl);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.startsWith("/attendance_test"))
    throw new Error("Local mail integration tests require a local attendance_test database");
  process.env.DATABASE_URL = testUrl;
}

describe.skipIf(!testUrl)("local IMAP mail transaction", () => {
  const suffix = randomUUID().slice(0, 8);
  const token = "0123456789abcdef0123456789abcdef";
  const receivedAt = new Date(Date.now() - 90 * 60_000);
  const messageId = `<local-${suffix}@example.test>`;
  let classId: string;
  let userId: string;
  let taskId: string;
  let archivedTaskId: string;
  let source: Buffer;

  beforeAll(async () => {
    process.env.LOCAL_EMAIL_MODE = "true";
    process.env.UPLOAD_DIR = `../../.local/local-mail-test-${suffix}`;
    classId = (await prisma.class.create({ data: { name: `Local mail ${suffix}` } })).id;
    userId = (await prisma.user.create({ data: {
      studentId: `local-${suffix}`, name: "测试学生", role: "STUDENT", classId,
      email: `local-${suffix}@example.test`, active: true,
    } })).id;
    taskId = (await prisma.task.create({ data: {
      title: "Delayed mailbox scan", targetEmail: "archive@example.test",
      centerLat: 30, centerLng: 120, radius: 800, status: "COMPLETED",
      startTime: new Date(Date.now() - 2 * 60 * 60_000),
      endTime: new Date(Date.now() - 60 * 60_000),
      members: { create: { userId, studentId: `local-${suffix}`, name: "测试学生", className: `Local mail ${suffix}`, email: `local-${suffix}@example.test`, mailToken: token } },
    } })).id;
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#229988" } }).png().toBuffer();
    const message = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: `local-${suffix}@example.test`, to: "archive@example.test", messageId,
      subject: `[返校打卡] local-${suffix}_测试学生_${taskId}_${token}`,
      text: JSON.stringify({ taskId, studentId: `local-${suffix}` }),
      attachments: [{ filename: "photo.png", contentType: "image/png", content: photo }],
    });
    source = message.message as Buffer;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (taskId) {
      const checkIn = await prisma.checkIn.findUnique({ where: { taskId_userId: { taskId, userId } } });
      if (checkIn?.photoUrl) await photoStorage.removeByPublicUrl(checkIn.photoUrl);
      await prisma.inboundMailLog.deleteMany({ where: { taskId } });
      await prisma.emailLog.deleteMany({ where: { taskId } });
      await prisma.checkIn.deleteMany({ where: { taskId } });
      await prisma.taskMember.deleteMany({ where: { taskId } });
      await prisma.task.delete({ where: { id: taskId } });
    }
    if (archivedTaskId) {
      await prisma.inboundMailLog.deleteMany({ where: { taskId: archivedTaskId } });
      await prisma.auditLog.deleteMany({ where: { targetId: archivedTaskId } });
      await prisma.taskMember.deleteMany({ where: { taskId: archivedTaskId } });
      await prisma.task.delete({ where: { id: archivedTaskId } });
    }
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (classId) await prisma.class.delete({ where: { id: classId } });
    await prisma.$disconnect();
  });

  it("retries storage failure, then accepts pre-deadline mail after task completion exactly once", async () => {
    const save = vi.spyOn(photoStorage, "saveCheckInPhoto").mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(ingestMail(source, { receivedAt })).rejects.toThrow("Disk unavailable");
    expect(await prisma.inboundMailLog.findUnique({ where: { messageId } })).toBeNull();
    save.mockRestore();

    expect(await ingestMail(source, { receivedAt })).toBe(true);
    expect(await ingestMail(source, { receivedAt })).toBe(true);
    const checkIn = await prisma.checkIn.findUniqueOrThrow({ where: { taskId_userId: { taskId, userId } } });
    expect(checkIn.status).toBe("REVIEWING");
    expect(checkIn.emailReceivedAt).toEqual(receivedAt);
    expect(checkIn.submittedAt).toEqual(receivedAt);
    expect(await prisma.inboundMailLog.count({ where: { taskId, status: "ACCEPTED" } })).toBe(1);
  });

  it("removes the replaced photo after an accepted retry", async () => {
    const previous = await prisma.checkIn.findUniqueOrThrow({ where: { taskId_userId: { taskId, userId } } });
    await prisma.checkIn.update({ where: { id: previous.id }, data: { status: "REJECTED" } });
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#338855" } }).jpeg().toBuffer();
    const retry = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: `local-${suffix}@example.test`, to: "archive@example.test",
      messageId: `<retry-${suffix}@example.test>`,
      subject: `[返校打卡] local-${suffix}_测试学生_${taskId}_${token}`,
      text: JSON.stringify({ taskId, studentId: `local-${suffix}` }),
      attachments: [{ filename: "retry.jpg", contentType: "image/jpeg", content: photo }],
    });
    expect(await ingestMail(retry.message as Buffer, { receivedAt })).toBe(true);
    const current = await prisma.checkIn.findUniqueOrThrow({ where: { id: previous.id } });
    expect(current.status).toBe("REVIEWING");
    expect(current.photoUrl).not.toBe(previous.photoUrl);
    expect(existsSync(photoStorage.resolvePublicUrl(previous.photoUrl!))).toBe(false);
    expect(existsSync(photoStorage.resolvePublicUrl(current.photoUrl!))).toBe(true);
    await expect(archiveTask(taskId, "test-actor")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never leaves a pending review inside an archived task", async () => {
    const newToken = randomUUID().replaceAll("-", "");
    archivedTaskId = (await prisma.task.create({ data: {
      title: "Archive race", targetEmail: "archive@example.test", centerLat: 30, centerLng: 120,
      status: "COMPLETED", startTime: new Date(Date.now() - 2 * 60 * 60_000),
      endTime: new Date(Date.now() - 60 * 60_000),
      members: { create: { userId, studentId: `local-${suffix}`, name: "测试学生", className: `Local mail ${suffix}`, email: `local-${suffix}@example.test`, mailToken: newToken } },
    } })).id;
    const photo = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#228888" } }).jpeg().toBuffer();
    const message = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: `local-${suffix}@example.test`, to: "archive@example.test",
      messageId: `<archive-race-${suffix}@example.test>`,
      subject: `[返校打卡] local-${suffix}_测试学生_${archivedTaskId}_${newToken}`,
      text: JSON.stringify({ taskId: archivedTaskId, studentId: `local-${suffix}` }),
      attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", content: photo }],
    });
    let entered!: () => void;
    let release!: () => void;
    const enteredStorage = new Promise<void>((resolve) => { entered = resolve; });
    const resumeStorage = new Promise<void>((resolve) => { release = resolve; });
    const save = photoStorage.saveCheckInPhoto.bind(photoStorage);
    let savedPhotoUrl: string | undefined;
    const spy = vi.spyOn(photoStorage, "saveCheckInPhoto").mockImplementationOnce(async (...args) => {
      entered();
      await resumeStorage;
      savedPhotoUrl = await save(...args);
      return savedPhotoUrl;
    });
    const processing = ingestMail(message.message as Buffer, { receivedAt });
    try {
      await enteredStorage;
      await archiveTask(archivedTaskId, "test-actor");
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await processing).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: archivedTaskId } })).status).toBe("ARCHIVED");
    expect(await prisma.checkIn.count({ where: { taskId: archivedTaskId } })).toBe(0);
    expect(await prisma.inboundMailLog.count({ where: { taskId: archivedTaskId, status: "REJECTED" } })).toBe(1);
    expect(existsSync(photoStorage.resolvePublicUrl(savedPhotoUrl!))).toBe(false);
  }, 15000);
});
