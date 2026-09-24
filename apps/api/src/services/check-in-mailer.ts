import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";
export const mailMetadata = z
  .object({
    taskId: z.string().cuid(),
    userId: z.string().cuid(),
    attemptId: z.string().uuid(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    time: z.string().datetime(),
    photoHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MailMetadata = z.infer<typeof mailMetadata>;
function secret() {
  const value = process.env.MAIL_SIGNING_SECRET;
  if (!value || value.length < 32)
    throw new Error("MAIL_SIGNING_SECRET 至少需要 32 位");
  return value;
}
export function createMailBody(metadata: MailMetadata) {
  const payload = JSON.stringify(mailMetadata.parse(metadata));
  return JSON.stringify({
    payload,
    signature: createHmac("sha256", secret()).update(payload).digest("hex"),
  });
}
export function parseSignedMail(text: string) {
  const envelope = z
    .object({
      payload: z.string().max(4000),
      signature: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(JSON.parse(text));
  const expected = createHmac("sha256", secret())
    .update(envelope.payload)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex")))
    throw new Error("邮件签名无效");
  return mailMetadata.parse(JSON.parse(envelope.payload));
}
let running = false;
// 仅在单个 worker 进程执行。部署配置固定 worker 副本数为 1。
export async function drainOutbox() {
  if (running) return;
  running = true;
  try {
    const jobs = await prisma.mailOutbox.findMany({
      where: {
        sentAt: null,
        attempts: { lt: 5 },
        nextAttemptAt: { lte: new Date() },
      },
      take: 20,
      orderBy: { nextAttemptAt: "asc" },
    });
    for (const job of jobs) {
      const current = await prisma.checkIn.findUnique({
        where: { id: job.checkInId },
      });
      if (
        current?.attemptId !== job.id ||
        current.status === "REVIEWING" ||
        current.status === "APPROVED" ||
        current.status === "REJECTED"
      ) {
        await prisma.mailOutbox.update({
          where: { id: job.id },
          data: { sentAt: new Date() },
        });
        continue;
      }
      try {
        if (
          !process.env.SMTP_HOST ||
          !process.env.SMTP_USER ||
          !process.env.SMTP_PASS
        )
          throw new Error("SMTP 未配置");
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 465),
          secure: process.env.SMTP_SECURE !== "false",
          requireTLS: process.env.SMTP_SECURE === "false",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          connectionTimeout: 15000,
          socketTimeout: 30000,
          logger: false,
        });
        const result = await transport.sendMail({
          from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
          to: job.targetEmail,
          messageId: `<${job.id}@attendance.local>`,
          subject: job.subject,
          text: job.body,
          attachments: [
            {
              filename: "check-in.jpg",
              contentType: "image/jpeg",
              path: photoStorage.resolvePublicUrl(job.photoUrl),
            },
          ],
        });
        if (!result.accepted.length || result.rejected.length)
          throw new Error("收件邮箱拒绝邮件");
        await prisma.$transaction([
          prisma.mailOutbox.update({
            where: { id: job.id },
            data: { sentAt: new Date(), error: null },
          }),
          prisma.checkIn.updateMany({
            where: {
              id: job.checkInId,
              attemptId: job.id,
              status: { in: ["EMAIL_PENDING", "EMAIL_ERROR"] },
            },
            data: { status: "EMAIL_SENT" },
          }),
        ]);
      } catch {
        // 不保存 SMTP 异常原文，避免服务器错误回显凭据。
        await prisma.$transaction([
          prisma.mailOutbox.update({
            where: { id: job.id },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** job.attempts),
              error: "发送失败，请检查 SMTP 连接及邮箱配置",
            },
          }),
          prisma.checkIn.updateMany({
            where: {
              id: job.checkInId,
              attemptId: job.id,
              status: "EMAIL_PENDING",
            },
            data: {
              status: job.attempts >= 4 ? "EMAIL_ERROR" : "EMAIL_PENDING",
            },
          }),
        ]);
      }
    }
  } finally {
    running = false;
  }
}
