import nodemailer from "nodemailer";
import { photoStorage } from "../lib/storage.js";

export interface CheckInMailPayload {
  task: { id: string; title: string; targetEmail: string };
  user: { id: string; studentId: string; name: string };
  checkIn: { id: string; photoUrl: string | null; lat: number | null; lng: number | null; address: string | null };
}

function isEnabled(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP 配置不完整，无法发送打卡邮件");
  }
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: isEnabled(process.env.SMTP_SECURE),
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  };
}

export function buildCheckInMail(payload: CheckInMailPayload) {
  if (!payload.checkIn.photoUrl || payload.checkIn.lat === null || payload.checkIn.lng === null) {
    throw new Error("打卡信息不完整，无法发送邮件");
  }

  const subject = `[打卡]${payload.user.studentId}_${payload.user.name}_${payload.task.id}`;
  const metadata = {
    lat: payload.checkIn.lat,
    lng: payload.checkIn.lng,
    address: payload.checkIn.address,
    time: new Date().toISOString(),
    userId: payload.user.id,
    taskId: payload.task.id
  };

  return {
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: payload.task.targetEmail,
    subject,
    text: JSON.stringify(metadata),
    attachments: [
      {
        filename: `${payload.user.studentId}_${payload.user.name}.jpg`,
        path: photoStorage.resolvePublicUrl(payload.checkIn.photoUrl)
      }
    ]
  };
}

export async function sendCheckInMail(payload: CheckInMailPayload): Promise<{ subject: string; messageId: string }> {
  const mail = buildCheckInMail(payload);
  const transport = nodemailer.createTransport(smtpConfig());
  const result = await transport.sendMail(mail);
  return { subject: mail.subject, messageId: result.messageId };
}
