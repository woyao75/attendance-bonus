import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import sharp from "sharp";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { hashPassword } from "./lib/password.js";
import { ingestMail } from "./services/mail-agent.js";
import { drainOutbox } from "./services/check-in-mailer.js";
import { syncTaskStatuses } from "./services/task-lifecycle.js";
import { photoStorage } from "./lib/storage.js";
import {
  buildTaskWorkbook,
  buildApprovedPhotosZip,
} from "./services/task-exports.js";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const url = process.env.TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !parsed.pathname.startsWith("/attendance_test")
  )
    throw new Error(
      "Integration tests require a local attendance_test database",
    );
  process.env.DATABASE_URL = url;
}
describe.skipIf(!url)("MySQL API and signed email workflow", () => {
  const app = createApp();
  const origin = "http://localhost:5173";
  const password = "Test-password-2026!";
  const prefix = randomUUID().slice(0, 8);
  let admin: ReturnType<typeof request.agent>,
    counselor: ReturnType<typeof request.agent>,
    student: ReturnType<typeof request.agent>,
    outsider: ReturnType<typeof request.agent>;
  let classId: string,
    otherClass: string,
    taskId: string,
    userId: string,
    recordId: string,
    originalMail: Buffer;
  let image: Buffer;
  const post = (agent: ReturnType<typeof request.agent>, path: string) =>
    agent.post(path).set("Origin", origin).set("X-Attendance-Request", "1");
  const patch = (agent: ReturnType<typeof request.agent>, path: string) =>
    agent.patch(path).set("Origin", origin).set("X-Attendance-Request", "1");
  beforeAll(async () => {
    process.env.MAIL_TARGET = "archive@example.test";
    process.env.MAIL_SIGNING_SECRET = "test-secret-only".repeat(4);
    process.env.LOCAL_EMAIL_MODE = "false";
    process.env.UPLOAD_DIR = `../../.local/test-uploads-${prefix}`;
    const hash = await hashPassword(password);
    const c = await prisma.class.create({ data: { name: `班级-${prefix}` } });
    classId = c.id;
    otherClass = (
      await prisma.class.create({ data: { name: `其他班-${prefix}` } })
    ).id;
    for (const [name, role, cls] of [
      ["admin", "ADMIN", null],
      ["counselor", "COUNSELOR", null],
      ["student", "STUDENT", classId],
      ["outsider", "STUDENT", otherClass],
    ] as const) {
      const u = await prisma.user.create({
        data: {
          studentId: `${prefix}-${name}`,
          name,
          role,
          classId: cls,
          passwordHash: hash,
          mustChangePassword: false,
        },
      });
      if (name === "student") userId = u.id;
      if (name === "counselor")
        await prisma.counselorClass.create({ data: { userId: u.id, classId } });
    }
    [admin, counselor, student, outsider] = Array.from({ length: 4 }, () =>
      request.agent(app),
    );
    for (const [agent, name] of [
      [admin, "admin"],
      [counselor, "counselor"],
      [student, "student"],
      [outsider, "outsider"],
    ] as const) {
      const login = await post(agent, "/api/auth/login")
        .send({ account: `${prefix}-${name}`, password })
        .expect(200);
      // 同一校园出口的不同账号各自拥有登录配额。
      expect(login.headers.ratelimit).toContain("remaining=29");
    }
    image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#229988" },
    })
      .jpeg()
      .toBuffer();
  }, 30000);
  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("requires sessions and a same-origin write header", async () => {
    await request(app).get("/api/tasks").expect(401);
    await student.post("/api/tasks").send({}).expect(403);
    await post(student, "/api/tasks").send({}).expect(403);
    await admin
      .post("/api/manage/classes")
      .set("Origin", "https://attacker.test")
      .set("X-Attendance-Request", "1")
      .send({ name: "forged" })
      .expect(403);
  });
  it("publishes a fixed roster only from assigned classes", async () => {
    const data = {
      title: "返校测试",
      startTime: new Date(Date.now() - 60000).toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
      centerLat: 30,
      centerLng: 120,
      classIds: [otherClass],
    };
    await post(counselor, "/api/tasks").send(data).expect(403);
    const response = await post(counselor, "/api/tasks")
      .send({ ...data, classIds: [classId] })
      .expect(201);
    taskId = response.body.id;
    await prisma.user.update({
      where: { id: userId },
      data: { classId: otherClass },
    });
    const stats = await counselor
      .get(`/api/tasks/${taskId}/dashboard`)
      .expect(200);
    expect(stats.body.metrics.expected).toBe(1);
    await outsider.get(`/api/tasks/${taskId}`).expect(404);
    await student.get(`/api/tasks/${taskId}/export/excel`).expect(403);
  });
  const submit = (
    agent: ReturnType<typeof request.agent>,
    bytes = image,
    latitude = "30",
  ) =>
    post(agent, "/api/check-ins")
      .field("taskId", taskId)
      .field("lat", latitude)
      .field("lng", "120")
      .field("accuracy", "10")
      .field("capturedAt", new Date().toISOString())
      .attach("photo", bytes, {
        filename: "camera.jpg",
        contentType: "image/jpeg",
      });
  it("rejects non-members, out-of-fence coordinates and fake images", async () => {
    await submit(outsider).expect(404);
    await submit(student, image, "0").expect(422);
    await submit(student, Buffer.from("<script>fake jpeg</script>")).expect(
      400,
    );
  });
  it("disables browser photo submission in local direct-mail mode", async () => {
    process.env.LOCAL_EMAIL_MODE = "true";
    try {
      await submit(student).expect(409);
      expect(await prisma.mailOutbox.count({ where: { checkIn: { taskId } } })).toBe(0);
    } finally {
      process.env.LOCAL_EMAIL_MODE = "false";
    }
  });
  it("enqueues a submission atomically and protects its photo", async () => {
    const response = await submit(student)
      .field("userId", "forged-user")
      .expect(202);
    recordId = response.body.checkIn.id;
    expect(response.body.checkIn.userId).toBe(userId);
    expect(response.body.checkIn.status).toBe("EMAIL_PENDING");
    expect(
      await prisma.mailOutbox.count({ where: { checkInId: recordId } }),
    ).toBe(1);
    await submit(student).expect(409);
    await outsider.get(`/api/check-ins/${recordId}/photo`).expect(404);
    await request(app).get(`/api/check-ins/${recordId}/photo`).expect(401);
    await student
      .get(`/api/check-ins/${recordId}/photo`)
      .expect(200)
      .expect("Cache-Control", "private, no-store");
  });
  it("retries SMTP failures without deleting the durable photo", async () => {
    process.env.SMTP_HOST = "";
    for (let i = 0; i < 5; i++) {
      await prisma.mailOutbox.updateMany({
        where: { checkInId: recordId },
        data: { nextAttemptAt: new Date(0) },
      });
      await drainOutbox();
    }
    const record = await prisma.checkIn.findUniqueOrThrow({
      where: { id: recordId },
    });
    expect(record.status).toBe("EMAIL_ERROR");
    expect(
      (await readFile(photoStorage.resolvePublicUrl(record.photoUrl!))).length,
    ).toBeGreaterThan(0);
  });
  it("accepts signed MIME mail exactly once and moves to review", async () => {
    const job = await prisma.mailOutbox.findFirstOrThrow({
      where: { checkInId: recordId },
    });
    const message = await nodemailer
      .createTransport({ streamTransport: true, buffer: true })
      .sendMail({
        from: "sender@example.test",
        to: job.targetEmail,
        subject: job.subject,
        text: job.body,
        messageId: `<${job.id}@attendance.local>`,
        attachments: [
          {
            filename: "check-in.jpg",
            contentType: "image/jpeg",
            path: photoStorage.resolvePublicUrl(job.photoUrl),
          },
        ],
      });
    originalMail = message.message as Buffer;
    expect(await ingestMail(originalMail)).toBe(true);
    expect(await ingestMail(originalMail)).toBe(true);
    expect(await prisma.emailLog.count({ where: { taskId } })).toBe(1);
    expect(
      (await prisma.checkIn.findUniqueOrThrow({ where: { id: recordId } }))
        .status,
    ).toBe("REVIEWING");
  });
  it("requires rejection reasons and prevents stale mail reverting a new submission", async () => {
    await patch(counselor, `/api/check-ins/${recordId}/review`)
      .send({ status: "REJECTED" })
      .expect(400);
    await patch(counselor, `/api/check-ins/${recordId}/review`)
      .send({ status: "REJECTED", rejectReason: "手势不清晰" })
      .expect(200);
    await submit(student).expect(202);
    expect(await ingestMail(originalMail)).toBe(true);
    expect(
      (await prisma.checkIn.findUniqueOrThrow({ where: { id: recordId } }))
        .status,
    ).toBe("EMAIL_PENDING");
    const current = await prisma.checkIn.findUniqueOrThrow({
      where: { id: recordId },
    });
    const job = await prisma.mailOutbox.findUniqueOrThrow({
      where: { id: current.attemptId! },
    });
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
    });
    const message = await transport.sendMail({
      from: "sender@example.test",
      to: job.targetEmail,
      subject: job.subject,
      text: job.body,
      messageId: `<${job.id}@attendance.local>`,
      attachments: [
        {
          filename: "check-in.jpg",
          contentType: "image/jpeg",
          path: photoStorage.resolvePublicUrl(job.photoUrl),
        },
      ],
    });
    await ingestMail(message.message as Buffer);
    const results = await Promise.all([
      patch(counselor, `/api/check-ins/${recordId}/review`).send({
        status: "APPROVED",
      }),
      patch(counselor, `/api/check-ins/${recordId}/review`).send({
        status: "APPROVED",
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await ingestMail(message.message as Buffer);
    expect(
      (await prisma.checkIn.findUniqueOrThrow({ where: { id: recordId } }))
        .status,
    ).toBe("APPROVED");
  });
  it("exports the roster and approved photo without using the current class", async () => {
    await prisma.checkIn.update({
      where: { id: recordId },
      data: { submittedAt: new Date("2026-09-23T12:34:56.000Z") },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTaskWorkbook(taskId)) as never);
    expect(workbook.worksheets[0].rowCount).toBe(2);
    expect(workbook.worksheets[0].getCell("C2").text).toBe(`班级-${prefix}`);
    expect(workbook.worksheets[0].getCell("D2").text).toBe(
      "2026-09-23 20:34:56",
    );
    const stream = await buildApprovedPhotosZip(taskId);
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.from(part));
    const archive = await JSZip.loadAsync(Buffer.concat(parts));
    expect(
      Object.keys(archive.files).filter((name) => name.endsWith(".jpg")),
    ).toHaveLength(1);
  });
  it("invalidates sessions on logout, reset and account disable", async () => {
    await post(outsider, "/api/auth/logout").send({}).expect(200);
    await outsider.get("/api/auth/me").expect(401);
    await patch(admin, `/api/manage/users/${userId}`)
      .send({ password: "new-temporary-password" })
      .expect(200);
    await student.get("/api/tasks").expect(401);
    await post(student, "/api/auth/login")
      .send({
        account: `${prefix}-student`,
        password: "new-temporary-password",
      })
      .expect(200);
    await student.get("/api/tasks").expect(403);
    await post(student, "/api/auth/change-password")
      .send({
        oldPassword: "new-temporary-password",
        password: "final-personal-password",
      })
      .expect(200);
    await student.get("/api/auth/me").expect(401);
    await post(student, "/api/auth/login")
      .send({
        account: `${prefix}-student`,
        password: "final-personal-password",
      })
      .expect(200);
    await patch(admin, `/api/manage/users/${userId}`)
      .send({ active: false })
      .expect(200);
    await student.get("/api/tasks").expect(401);
  });
  it("advances task times without reopening archived tasks", async () => {
    const now = new Date();
    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: "NOT_STARTED",
        startTime: new Date(now.getTime() - 60000),
        endTime: new Date(now.getTime() + 60000),
      },
    });
    await syncTaskStatuses(now);
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    ).toBe("IN_PROGRESS");
    await syncTaskStatuses(new Date(now.getTime() + 60001));
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    ).toBe("COMPLETED");
    await patch(counselor, `/api/tasks/${taskId}/archive`).send({}).expect(409);
    await prisma.task.update({
      where: { id: taskId },
      data: { endTime: new Date(now.getTime() - 1) },
    });
    await patch(counselor, `/api/tasks/${taskId}/archive`).send({}).expect(200);
    await syncTaskStatuses(now);
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    ).toBe("ARCHIVED");
  });
});
