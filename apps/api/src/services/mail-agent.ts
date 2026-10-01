import { createHash, randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { Prisma } from "@prisma/client";
import { simpleParser } from "mailparser";
import sharp from "sharp";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";
import { parseSignedMail } from "./check-in-mailer.js";
import { lockTaskForUpdate } from "./task-lifecycle.js";

export const mailAgentStatus: {
  running: boolean;
  enabled: boolean;
  lastSuccessAt?: Date;
  lastScanAt?: Date;
  lastError?: string;
  processedCount: number;
  failedCount: number;
  queueLength?: number;
} = { running: false, enabled: false, processedCount: 0, failedCount: 0 };

export const parseCheckInMetadata = (text: string | undefined) => {
  if (!text) throw new Error("Mail body is empty");
  return parseSignedMail(text);
};

const localMailMetadata = z.object({
  taskId: z.string().cuid(),
  studentId: z.string().trim().min(1).max(64),
  time: z.string().datetime({ offset: true }).optional(),
  lat: z.number().finite().min(-90).max(90).optional(),
  lng: z.number().finite().min(-180).max(180).optional(),
});

export function parseLocalSubject(subject: string | undefined) {
  const match =
    /^\[返校打卡\]\s*([^_\s]+)_([^_]+)_([a-z0-9]{20,32})_([a-f0-9]{32})\s*$/i.exec(
      subject ?? "",
    );
  if (!match)
    throw new Error("Subject must be: [返校打卡] studentId_name_taskId_mailToken");
  return { studentId: match[1], name: match[2], taskId: match[3], token: match[4] };
}

export function parseLocalBody(text: string | undefined, subject: string | undefined) {
  const subjectData = parseLocalSubject(subject);
  const value = (text ?? "").trim();
  let body: Record<string, unknown> = {};
  if (value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {
      for (const line of value.split(/\r?\n/)) {
        const match = /^\s*(taskId|studentId|time|lat|lng)\s*[:：]\s*(.+?)\s*$/.exec(line);
        if (match) body[match[1]] = ["lat", "lng"].includes(match[1]) ? Number(match[2]) : match[2];
      }
    }
  }
  const metadata = localMailMetadata.parse({ ...subjectData, ...body });
  if (metadata.taskId !== subjectData.taskId || metadata.studentId !== subjectData.studentId)
    throw new Error("Body identity does not match the subject");
  return { ...metadata, name: subjectData.name, token: subjectData.token };
}

function senderAddress(parsed: Awaited<ReturnType<typeof simpleParser>>) {
  return parsed.from?.value[0]?.address?.trim().toLowerCase() ?? null;
}
function messageSubject(parsed: Awaited<ReturnType<typeof simpleParser>>) {
  return (parsed.subject ?? "(no subject)").slice(0, 320);
}
async function rejectLocalMail(input: { messageId: string; taskId?: string; sender: string | null; subject: string; error: string }) {
  await prisma.inboundMailLog.create({
    data: { messageId: input.messageId, taskId: input.taskId, sender: input.sender, subject: input.subject, status: "REJECTED", errorMsg: input.error.slice(0, 500) },
  });
}

class InvalidLocalMail extends Error {}

export function isWithinMailWindow(receivedAt: Date, startTime: Date, endTime: Date) {
  return Number.isFinite(receivedAt.getTime()) && receivedAt >= startTime && receivedAt <= endTime;
}

export function imapFallbackId(account: string, uidValidity: bigint, uid: number) {
  return `imap:${createHash("sha256").update(`${account}\0${uidValidity}\0${uid}`).digest("hex")}`;
}

type MailContext = { receivedAt?: Date; fallbackId?: string };

async function ingestLocalMail(parsed: Awaited<ReturnType<typeof simpleParser>>, context: MailContext) {
  const rawMessageId = parsed.messageId?.trim();
  const messageId = rawMessageId
    ? rawMessageId.length <= 320 ? rawMessageId : `msg:${createHash("sha256").update(rawMessageId).digest("hex")}`
    : context.fallbackId;
  if (!messageId) throw new Error("IMAP message has no stable identity");
  const receivedAt = context.receivedAt;
  if (!receivedAt || !Number.isFinite(receivedAt.getTime())) throw new Error("IMAP internalDate is unavailable");
  if (await prisma.inboundMailLog.findUnique({ where: { messageId } })) return true;
  const sender = senderAddress(parsed);
  const subject = messageSubject(parsed);
  let metadata: ReturnType<typeof parseLocalBody> | undefined;
  let subjectTaskId: string | undefined;
  try {
    subjectTaskId = parseLocalSubject(parsed.subject).taskId;
    metadata = parseLocalBody(parsed.text, parsed.subject);
  } catch (error) {
    await rejectLocalMail({ messageId, taskId: subjectTaskId, sender, subject, error: error instanceof Error ? error.message : "Invalid mail format" });
    return true;
  }
  try {
    const localMetadata = metadata;
    const member = await prisma.taskMember.findFirst({
      where: { taskId: metadata.taskId, studentId: metadata.studentId },
      include: { task: true, user: true },
    });
    if (!member) throw new InvalidLocalMail("No matching task member");
    if (!sender || member.email?.toLowerCase() !== sender) throw new InvalidLocalMail("Sender does not match the registered email");
    if (!member.mailToken || member.mailToken !== metadata.token) throw new InvalidLocalMail("Invalid per-student mail token");
    if (member.name !== metadata.name) throw new InvalidLocalMail("Name does not match roster");
    if (!member.user.active) throw new InvalidLocalMail("Student account is disabled");
    if (member.task.status === "ARCHIVED" || !isWithinMailWindow(receivedAt, member.task.startTime, member.task.endTime))
      throw new InvalidLocalMail("Task is outside its active time window");
    const existing = await prisma.checkIn.findUnique({ where: { taskId_userId: { taskId: member.taskId, userId: member.userId } } });
    if (existing && !["NOT_CHECKED", "REJECTED", "EMAIL_ERROR"].includes(existing.status))
      throw new InvalidLocalMail("A check-in is already being reviewed or completed");
    const attachment = parsed.attachments.find((item) => ["image/jpeg", "image/png", "image/webp"].includes(item.contentType));
    if (!attachment) throw new InvalidLocalMail("No supported image attachment");
    if (attachment.content.length > 8 * 1024 * 1024) throw new InvalidLocalMail("Image attachment exceeds 8MB");
    let photo: Buffer;
    try {
      photo = await sharp(attachment.content, { limitInputPixels: 20_000_000, failOn: "error" }).rotate().jpeg({ quality: 92 }).toBuffer();
    } catch { throw new InvalidLocalMail("Image attachment is invalid"); }
    const photoHash = createHash("sha256").update(photo).digest("hex");
    const photoUrl = await photoStorage.saveCheckInPhoto(member.taskId, member.userId, { buffer: photo, mimetype: "image/jpeg" });
    let committed = false;
    let previousPhotoUrl: string | null = null;
    try {
      await prisma.$transaction(async (tx) => {
        const task = await lockTaskForUpdate(tx, member.taskId);
        if (!task || task.status === "ARCHIVED" || !isWithinMailWindow(receivedAt, task.startTime, task.endTime))
          throw new InvalidLocalMail("Task is outside its active time window");
        const credential = await tx.taskMember.updateMany({
          where: { taskId: member.taskId, userId: member.userId, email: sender, mailToken: localMetadata.token },
          data: { mailToken: localMetadata.token },
        });
        if (!credential.count) throw new InvalidLocalMail("Mail credential was rotated before processing");
        const current = await tx.checkIn.findUnique({ where: { taskId_userId: { taskId: member.taskId, userId: member.userId } } });
        if (current && !["NOT_CHECKED", "REJECTED", "EMAIL_ERROR"].includes(current.status))
          throw new InvalidLocalMail("A check-in is already being reviewed or completed");
        await tx.inboundMailLog.create({ data: { messageId, taskId: member.taskId, sender, subject, status: "ACCEPTED" } });
        await tx.emailLog.create({ data: { taskId: member.taskId, messageId, subject, parseStatus: "success" } });
        // Local mail has no trusted capture timestamp or GPS proof; server receipt time is authoritative.
        const data = { status: "REVIEWING" as const, photoUrl, photoHash, lat: localMetadata.lat ?? null, lng: localMetadata.lng ?? null, capturedAt: receivedAt, submittedAt: receivedAt, emailSubject: subject, emailReceivedAt: receivedAt, rejectReason: null, attemptId: randomUUID() };
        if (current) await tx.checkIn.update({ where: { id: current.id }, data });
        else await tx.checkIn.create({ data: { ...data, taskId: member.taskId, userId: member.userId } });
        previousPhotoUrl = current?.photoUrl ?? null;
      });
      committed = true;
      if (previousPhotoUrl && previousPhotoUrl !== photoUrl)
        await photoStorage.removeByPublicUrl(previousPhotoUrl).catch(() => console.error("Unable to remove replaced local check-in photo"));
      return true;
    } finally {
      if (!committed) await photoStorage.removeByPublicUrl(photoUrl).catch(() => undefined);
    }
  } catch (error) {
    if (!(error instanceof InvalidLocalMail)) throw error;
    try {
      await rejectLocalMail({ messageId, taskId: metadata?.taskId ?? subjectTaskId, sender, subject, error: error.message });
    } catch (logError) {
      if (!(logError instanceof Prisma.PrismaClientKnownRequestError && logError.code === "P2002")) throw logError;
    }
    return true;
  }
}

// Signed messages are generated by this application in hosted mode only.
export async function ingestMail(source: Buffer, context: MailContext = {}) {
  const parsed = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true });
  if (process.env.LOCAL_EMAIL_MODE === "true") return ingestLocalMail(parsed, context);
  let metadata;
  try { metadata = parseCheckInMetadata(parsed.text); } catch { return false; }
  const job = await prisma.mailOutbox.findUnique({ where: { id: metadata.attemptId }, include: { checkIn: { include: { task: true } } } });
  if (!job || job.checkIn.taskId !== metadata.taskId || job.checkIn.userId !== metadata.userId || job.body !== JSON.stringify({ payload: JSON.stringify(metadata), signature: JSON.parse(job.body).signature })) return false;
  const messageId = parsed.messageId;
  if (!messageId || messageId !== `<${job.id}@attendance.local>`) return false;
  if (await prisma.emailLog.findUnique({ where: { messageId } })) return true;
  const attachment = parsed.attachments.find((item) => item.contentType === "image/jpeg");
  const valid = parsed.subject === job.subject && Boolean(attachment) && createHash("sha256").update(attachment?.content ?? Buffer.alloc(0)).digest("hex") === metadata.photoHash;
  await prisma.$transaction(async (tx) => {
    await tx.emailLog.create({ data: { taskId: metadata.taskId, messageId, subject: messageSubject(parsed), parseStatus: valid ? "success" : "failed", errorMsg: valid ? null : "Subject or attachment validation failed" } });
    if (valid) {
      await tx.checkIn.updateMany({ where: { id: job.checkInId, attemptId: metadata.attemptId, status: { in: ["EMAIL_PENDING", "EMAIL_SENT", "EMAIL_ERROR"] }, task: { status: { not: "ARCHIVED" } } }, data: { status: "REVIEWING", emailReceivedAt: new Date() } });
      await tx.mailOutbox.update({ where: { id: job.id }, data: { sentAt: new Date(), error: null } });
    } else {
      await tx.checkIn.updateMany({ where: { id: job.checkInId, attemptId: metadata.attemptId, status: { in: ["EMAIL_PENDING", "EMAIL_SENT"] } }, data: { status: "EMAIL_ERROR" } });
    }
  });
  return true;
}

let scanOffset = 0;
async function markHandled(client: ImapFlow, uid: number) {
  const processedMailbox = process.env.IMAP_PROCESSED_MAILBOX?.trim();
  if (processedMailbox) {
    try { if (await client.messageMove(uid, processedMailbox, { uid: true })) return; }
    catch { /* Folder may not exist; marking it seen is the safe fallback. */ }
  }
  if (!(await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }))) throw new Error("Unable to mark mail as seen");
}
export async function runMailAgent() {
  if (mailAgentStatus.running) return;
  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) { mailAgentStatus.enabled = false; mailAgentStatus.lastError = "IMAP is not configured"; return; }
  mailAgentStatus.running = true;
  mailAgentStatus.enabled = true;
  const client = new ImapFlow({ host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT ?? 993), secure: process.env.IMAP_SECURE !== "false", auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS }, logger: false, socketTimeout: 60000 });
  client.on("error", () => { mailAgentStatus.lastError = "IMAP connection error"; });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      if (!client.mailbox) throw new Error("INBOX is unavailable");
      const uidValidity = client.mailbox.uidValidity;
      const subject = process.env.LOCAL_EMAIL_MODE === "true" ? "[返校打卡]" : "[打卡]";
      const uids = await client.search({ seen: false, subject }, { uid: true });
      if (uids === false) throw new Error("IMAP search failed");
      mailAgentStatus.queueLength = uids.length;
      if (scanOffset >= uids.length) scanOffset = 0;
      const batch = uids.slice(scanOffset, scanOffset + 50);
      scanOffset += batch.length;
      let handled = 0;
      let failures = 0;
      for (const uid of batch) {
        try {
          const info = await client.fetchOne(uid, { size: true, internalDate: true }, { uid: true });
          if (!info || !info.size) throw new Error("IMAP message size is unavailable");
          const fallbackId = imapFallbackId(process.env.IMAP_USER!, uidValidity, uid);
          if (info.size > 15 * 1024 * 1024) {
            if (!(await prisma.inboundMailLog.findUnique({ where: { messageId: fallbackId } })))
              await rejectLocalMail({ messageId: fallbackId, sender: null, subject: "(oversized mail)", error: "Message exceeds 15MB" });
            await markHandled(client, uid);
            handled++;
            continue;
          }
          const message = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!message || !message.source) throw new Error("IMAP message source is unavailable");
          const receivedAt = info.internalDate ? new Date(info.internalDate) : undefined;
          if (await ingestMail(message.source, { receivedAt, fallbackId })) {
            await markHandled(client, uid);
            mailAgentStatus.processedCount++;
            handled++;
          } else {
            // Unknown hosted-mode messages are left unread for manual inspection.
            failures++;
          }
        } catch (error) {
          failures++;
          console.error("Mail scan item failed; retaining unread UID", uid, error instanceof Error ? error.name : "UnknownError");
        }
      }
      mailAgentStatus.queueLength = uids.length - handled;
      mailAgentStatus.failedCount += failures;
      mailAgentStatus.lastScanAt = new Date();
      if (failures) throw new Error(`${failures} mail item(s) failed; unread messages will be retried`);
    } finally { lock.release(); }
    mailAgentStatus.lastSuccessAt = new Date();
    mailAgentStatus.lastError = undefined;
  } catch { mailAgentStatus.lastError = "Mail scan failed; unread messages will be retried"; }
  finally { mailAgentStatus.running = false; await client.logout().catch(() => client.close()); }
}
