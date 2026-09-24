import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";

const statusLabel: Record<string, string> = {
  NOT_CHECKED: "未打卡",
  EMAIL_SENT: "邮件已发送",
  EMAIL_PENDING: "邮件待发送",
  REVIEWING: "审核中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  EMAIL_ERROR: "邮件异常",
};

// Excel 日期不包含时区，导出明确使用北京时间，避免服务器 UTC 导致少 8 小时。
function beijingTime(value: Date | null | undefined) {
  return value
    ? new Date(value.getTime() + 8 * 3600_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ")
    : "";
}

export async function buildTaskWorkbook(taskId: string): Promise<Buffer> {
  const [task, students, checkIns] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId } }),
    prisma.taskMember.findMany({
      where: { taskId },
      orderBy: { studentId: "asc" },
    }),
    prisma.checkIn.findMany({ where: { taskId }, include: { user: true } }),
  ]);
  if (!task)
    throw Object.assign(new Error("打卡任务不存在"), { statusCode: 404 });

  const checkInByUserId = new Map(
    checkIns.map((checkIn) => [checkIn.userId, checkIn]),
  );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "返校手势打卡系统";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("打卡统计", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = [
    { header: "学号", key: "studentId", width: 18 },
    { header: "姓名", key: "name", width: 14 },
    { header: "班级", key: "classId", width: 16 },
    { header: "打卡时间（北京时间）", key: "createdAt", width: 26 },
    { header: "状态", key: "status", width: 14 },
    { header: "邮件接收时间（北京时间）", key: "emailReceivedAt", width: 28 },
    { header: "驳回原因", key: "rejectReason", width: 30 },
  ];
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0F766E" },
  };

  students.forEach((student) => {
    const checkIn = checkInByUserId.get(student.userId);
    worksheet.addRow({
      studentId: student.studentId,
      name: student.name,
      classId: student.className,
      createdAt: beijingTime(checkIn?.submittedAt ?? checkIn?.createdAt),
      status: statusLabel[checkIn?.status ?? "NOT_CHECKED"],
      emailReceivedAt: beijingTime(checkIn?.emailReceivedAt),
      rejectReason: checkIn?.rejectReason,
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "unknown";
}

export async function buildApprovedPhotosZip(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true },
  });
  if (!task)
    throw Object.assign(new Error("打卡任务不存在"), { statusCode: 404 });

  const checkIns = await prisma.checkIn.findMany({
    where: { taskId, status: "APPROVED", photoUrl: { not: null } },
    include: { user: { select: { studentId: true, name: true } } },
    orderBy: { user: { studentId: "asc" } },
  });
  const archive = new JSZip();
  const missing: string[] = [];
  const members = await prisma.taskMember.findMany({ where: { taskId } });
  const byId = new Map(members.map((m) => [m.userId, m]));
  for (const checkIn of checkIns) {
    if (!checkIn.photoUrl) continue;
    try {
      const filePath = photoStorage.resolvePublicUrl(checkIn.photoUrl);
      await access(filePath);
      const extension = path.extname(checkIn.photoUrl) || ".jpg";
      const member = byId.get(checkIn.userId);
      archive.file(
        `${safeFilename(member?.studentId ?? checkIn.user.studentId)}_${safeFilename(member?.name ?? checkIn.user.name)}_${checkIn.id}${extension}`,
        createReadStream(filePath),
      );
    } catch (error) {
      missing.push(checkIn.user.studentId);
    }
  }
  if (missing.length) archive.file("缺失照片清单.txt", missing.join("\n"));
  return new Readable().wrap(
    archive.generateNodeStream({ streamFiles: true, compression: "STORE" }),
  );
}
