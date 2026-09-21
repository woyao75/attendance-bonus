import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";

const statusLabel: Record<string, string> = {
  NOT_CHECKED: "未打卡",
  EMAIL_SENT: "邮件已发送",
  REVIEWING: "审核中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  EMAIL_ERROR: "邮件异常"
};

export async function buildTaskWorkbook(taskId: string): Promise<Buffer> {
  const [task, students, checkIns] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId } }),
    prisma.user.findMany({ where: { role: "student" }, orderBy: { studentId: "asc" } }),
    prisma.checkIn.findMany({ where: { taskId }, include: { user: true } })
  ]);
  if (!task) throw Object.assign(new Error("打卡任务不存在"), { statusCode: 404 });

  const checkInByUserId = new Map(checkIns.map((checkIn) => [checkIn.userId, checkIn]));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "返校手势打卡系统";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("打卡统计", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.columns = [
    { header: "学号", key: "studentId", width: 18 },
    { header: "姓名", key: "name", width: 14 },
    { header: "班级", key: "classId", width: 16 },
    { header: "打卡时间", key: "createdAt", width: 22 },
    { header: "状态", key: "status", width: 14 },
    { header: "邮件接收时间", key: "emailReceivedAt", width: 22 },
    { header: "驳回原因", key: "rejectReason", width: 30 }
  ];
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };

  students.forEach((student) => {
    const checkIn = checkInByUserId.get(student.id);
    worksheet.addRow({
      studentId: student.studentId,
      name: student.name,
      classId: student.classId,
      createdAt: checkIn?.createdAt,
      status: statusLabel[checkIn?.status ?? "NOT_CHECKED"],
      emailReceivedAt: checkIn?.emailReceivedAt,
      rejectReason: checkIn?.rejectReason
    });
  });
  ["createdAt", "emailReceivedAt"].forEach((key) => {
    worksheet.getColumn(key).numFmt = "yyyy-mm-dd hh:mm:ss";
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "unknown";
}

export async function buildApprovedPhotosZip(taskId: string): Promise<Buffer> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw Object.assign(new Error("打卡任务不存在"), { statusCode: 404 });

  const checkIns = await prisma.checkIn.findMany({
    where: { taskId, status: "APPROVED", photoUrl: { not: null } },
    include: { user: { select: { studentId: true, name: true } } },
    orderBy: { user: { studentId: "asc" } }
  });
  const archive = new JSZip();
  for (const checkIn of checkIns) {
    if (!checkIn.photoUrl) continue;
    try {
      const file = await readFile(photoStorage.resolvePublicUrl(checkIn.photoUrl));
      const extension = path.extname(checkIn.photoUrl) || ".jpg";
      archive.file(`${safeFilename(checkIn.user.studentId)}_${safeFilename(checkIn.user.name)}${extension}`, file);
    } catch (error) {
      console.warn(`跳过缺失照片: ${checkIn.id}`, error);
    }
  }
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
