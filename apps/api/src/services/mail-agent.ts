import cron, { type ScheduledTask } from "node-cron";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";

const metadataSchema = z.object({
  taskId: z.string().cuid(),
  userId: z.string().cuid(),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  address: z.string().max(300).nullable().optional(),
  time: z.string().optional()
});

const subjectPattern = /^\[打卡\]([^_]+)_(.+)_([a-z0-9]+)$/u;
const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface MailAgentStatus {
  running: boolean;
  lastRunAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  processedCount: number;
}

export const mailAgentStatus: MailAgentStatus = {
  running: false,
  processedCount: 0
};

function getImapConfig() {
  const { IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS } = process.env;
  if (!IMAP_HOST || !IMAP_PORT || !IMAP_USER || !IMAP_PASS) return null;
  return {
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: process.env.IMAP_SECURE?.toLowerCase() === "true",
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false as const
  };
}

function parseSubject(subject: string) {
  const match = subjectPattern.exec(subject);
  if (!match) throw new Error("邮件主题不符合打卡格式");
  return { studentId: match[1], studentName: match[2], taskId: match[3] };
}

export function parseCheckInMetadata(text: string | undefined) {
  if (!text) throw new Error("邮件正文为空");
  try {
    return metadataSchema.parse(JSON.parse(text.trim()));
  } catch {
    throw new Error("邮件正文不是有效的打卡 JSON");
  }
}

async function parseMessageSource(source: Buffer | undefined): Promise<ParsedMail> {
  if (!source) throw new Error("邮件原文为空");
  return simpleParser(source, {});
}

async function archiveMessage(client: ImapFlow, uid: number): Promise<void> {
  const processedMailbox = process.env.IMAP_PROCESSED_MAILBOX;
  try {
    if (processedMailbox) {
      await client.messageMove(uid, processedMailbox, { uid: true });
      return;
    }
  } catch (error) {
    console.warn("移动已处理邮件失败，改为标记已读", error);
  }
  await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
}

async function recordFailure(taskId: string | undefined, messageId: string, subject: string, error: unknown) {
  if (!taskId) return;
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) return;
  await prisma.emailLog.upsert({
    where: { messageId },
    create: {
      taskId,
      messageId,
      subject,
      parseStatus: "failed",
      errorMsg: error instanceof Error ? error.message.slice(0, 1000) : "未知解析错误"
    },
    update: {}
  });
}

async function processMessage(client: ImapFlow, message: { uid: number; source?: Buffer; envelope?: { subject?: string } }) {
  const parsed = await parseMessageSource(message.source);
  const subject = parsed.subject ?? message.envelope?.subject ?? "";
  const messageId = parsed.messageId ?? `imap-${process.env.IMAP_USER}-${message.uid}`;
  const parsedSubject = parseSubject(subject);

  const duplicate = await prisma.emailLog.findUnique({ where: { messageId }, select: { id: true } });
  if (duplicate) return;

  const metadata = parseCheckInMetadata(parsed.text);
  if (metadata.taskId !== parsedSubject.taskId) {
    throw new Error("主题与正文的任务 ID 不一致");
  }

  const [task, user] = await Promise.all([
    prisma.task.findUnique({ where: { id: metadata.taskId } }),
    prisma.user.findUnique({ where: { id: metadata.userId } })
  ]);
  if (!task || !user || user.role !== "student" || user.studentId !== parsedSubject.studentId) {
    throw new Error("邮件中的任务或学生信息无效");
  }

  const attachment = parsed.attachments.find((item) => imageMimeTypes.has(item.contentType));
  let incomingPhotoUrl: string | undefined;
  if (attachment) {
    incomingPhotoUrl = await photoStorage.saveCheckInPhoto(task.id, user.id, {
      buffer: attachment.content,
      mimetype: attachment.contentType
    });
  }

  const existing = await prisma.checkIn.findUnique({
    where: { taskId_userId: { taskId: task.id, userId: user.id } }
  });
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.emailLog.create({
        data: { taskId: task.id, messageId, subject, parseStatus: "success" }
      });
      await transaction.checkIn.upsert({
        where: { taskId_userId: { taskId: task.id, userId: user.id } },
        create: {
          taskId: task.id,
          userId: user.id,
          status: "REVIEWING",
          photoUrl: incomingPhotoUrl,
          lat: metadata.lat,
          lng: metadata.lng,
          address: metadata.address ?? null,
          emailSubject: subject,
          emailReceivedAt: new Date()
        },
        update: {
          status: "REVIEWING",
          ...(incomingPhotoUrl ? { photoUrl: incomingPhotoUrl } : {}),
          lat: metadata.lat,
          lng: metadata.lng,
          address: metadata.address ?? null,
          emailSubject: subject,
          emailReceivedAt: new Date()
        }
      });
    });
  } catch (error) {
    if (incomingPhotoUrl) await photoStorage.removeByPublicUrl(incomingPhotoUrl);
    throw error;
  }

  if (incomingPhotoUrl && existing?.photoUrl && existing.photoUrl !== incomingPhotoUrl) {
    await photoStorage.removeByPublicUrl(existing.photoUrl);
  }
}

export async function runMailAgent(): Promise<void> {
  if (mailAgentStatus.running) return;
  const config = getImapConfig();
  if (!config) {
    mailAgentStatus.lastError = "IMAP 配置不完整";
    return;
  }

  mailAgentStatus.running = true;
  mailAgentStatus.lastRunAt = new Date();
  const client = new ImapFlow(config);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const message of client.fetch({ seen: false }, { uid: true, source: true, envelope: true })) {
        let taskId: string | undefined;
        let messageId = `imap-${process.env.IMAP_USER}-${message.uid}`;
        let subject = message.envelope?.subject ?? "";
        try {
          const parsed = await parseMessageSource(message.source);
          subject = parsed.subject ?? subject;
          messageId = parsed.messageId ?? messageId;
          taskId = parseSubject(subject).taskId;
          await processMessage(client, message);
          mailAgentStatus.processedCount += 1;
        } catch (error) {
          console.error("解析打卡邮件失败", error);
          await recordFailure(taskId, messageId, subject, error);
        } finally {
          await archiveMessage(client, message.uid);
        }
      }
    } finally {
      lock.release();
    }
    mailAgentStatus.lastSuccessAt = new Date();
    mailAgentStatus.lastError = undefined;
  } catch (error) {
    mailAgentStatus.lastError = error instanceof Error ? error.message : "IMAP Agent 运行失败";
    console.error("IMAP Agent 运行失败", error);
  } finally {
    mailAgentStatus.running = false;
    await client.logout().catch(() => undefined);
  }
}

export function startMailAgent(): ScheduledTask | undefined {
  if (!getImapConfig()) {
    console.warn("IMAP 未配置，邮件 Agent 未启动");
    return undefined;
  }
  void runMailAgent();
  return cron.schedule("* * * * *", () => void runMailAgent());
}
