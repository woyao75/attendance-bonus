import type { Request } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { isWithinGeofence } from "../lib/geo.js";
import { prisma } from "../lib/prisma.js";
import { photoStorage } from "../lib/storage.js";
import { sendCheckInMail } from "../services/check-in-mailer.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    callback(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  }
});

const checkInSchema = z.object({
  taskId: z.string().cuid(),
  userId: z.string().cuid(),
  lat: z.coerce.number().gte(-90).lte(90),
  lng: z.coerce.number().gte(-180).lte(180),
  address: z.string().trim().max(300).optional()
});

function requirePhoto(request: Request): Express.Multer.File {
  if (!request.file) {
    throw Object.assign(new Error("必须使用相机拍摄并提交照片"), { statusCode: 400 });
  }
  return request.file;
}

export const checkInRouter = Router();

checkInRouter.get("/", async (request, response, next) => {
  try {
    const query = z.object({ taskId: z.string().cuid(), userId: z.string().cuid() }).parse(request.query);
    const checkIn = await prisma.checkIn.findUnique({
      where: { taskId_userId: query },
      select: {
        id: true,
        status: true,
        photoUrl: true,
        lat: true,
        lng: true,
        address: true,
        rejectReason: true,
        createdAt: true
      }
    });
    response.json({ checkIn });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "查询参数不合法" });
      return;
    }
    next(error);
  }
});

checkInRouter.patch("/:checkInId/review", async (request, response, next) => {
  try {
    const checkInId = z.string().cuid().parse(request.params.checkInId);
    const payload = z
      .object({
        status: z.enum(["APPROVED", "REJECTED"]),
        rejectReason: z.string().trim().min(1).max(300).optional()
      })
      .superRefine((value, context) => {
        if (value.status === "REJECTED" && !value.rejectReason) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "驳回必须填写原因", path: ["rejectReason"] });
        }
      })
      .parse(request.body);
    const checkIn = await prisma.checkIn.findUnique({ where: { id: checkInId } });
    if (!checkIn) {
      response.status(404).json({ message: "打卡记录不存在" });
      return;
    }
    if (checkIn.status !== "REVIEWING") {
      response.status(409).json({ message: "仅审核中的打卡可以审批" });
      return;
    }
    const updated = await prisma.checkIn.update({
      where: { id: checkInId },
      data: {
        status: payload.status,
        rejectReason: payload.status === "REJECTED" ? payload.rejectReason : null
      }
    });
    response.json({ checkIn: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "审核参数不合法", issues: error.flatten() });
      return;
    }
    next(error);
  }
});

checkInRouter.post("/", upload.single("photo"), async (request, response, next) => {
  let savedPhotoUrl: string | undefined;
  try {
    const payload = checkInSchema.parse(request.body);
    const photo = requirePhoto(request);
    const [task, user] = await Promise.all([
      prisma.task.findUnique({ where: { id: payload.taskId } }),
      prisma.user.findUnique({ where: { id: payload.userId } })
    ]);

    if (!task) {
      response.status(404).json({ message: "打卡任务不存在" });
      return;
    }
    if (!user || user.role !== "student") {
      response.status(403).json({ message: "仅学生账户可以提交打卡" });
      return;
    }

    const now = new Date();
    if (task.status === "ARCHIVED" || task.status === "COMPLETED" || now < task.startTime || now > task.endTime) {
      response.status(409).json({ message: "当前不在任务打卡时间内" });
      return;
    }

    const geofence = isWithinGeofence(payload.lat, payload.lng, task.centerLat, task.centerLng, task.radius);
    if (!geofence.withinFence) {
      response.status(422).json({
        message: "不在学校打卡范围内",
        distanceMeters: Math.round(geofence.distanceMeters),
        radiusMeters: task.radius
      });
      return;
    }

    savedPhotoUrl = await photoStorage.saveCheckInPhoto(task.id, user.id, photo);
    const existing = await prisma.checkIn.findUnique({
      where: { taskId_userId: { taskId: task.id, userId: user.id } }
    });
    const checkIn = await prisma.checkIn.upsert({
      where: { taskId_userId: { taskId: task.id, userId: user.id } },
      create: {
        taskId: task.id,
        userId: user.id,
        photoUrl: savedPhotoUrl,
        lat: payload.lat,
        lng: payload.lng,
        address: payload.address
      },
      update: {
        photoUrl: savedPhotoUrl,
        lat: payload.lat,
        lng: payload.lng,
        address: payload.address,
        rejectReason: null,
        status: "NOT_CHECKED"
      }
    });

    if (existing?.photoUrl) await photoStorage.removeByPublicUrl(existing.photoUrl);
    try {
      const sent = await sendCheckInMail({ task, user, checkIn });
      const emailSentCheckIn = await prisma.checkIn.update({
        where: { id: checkIn.id },
        data: { status: "EMAIL_SENT", emailSubject: sent.subject }
      });
      response.status(201).json({
        checkIn: emailSentCheckIn,
        distanceMeters: Math.round(geofence.distanceMeters),
        message: "打卡邮件已发送，等待系统审核"
      });
    } catch (error) {
      const failedCheckIn = await prisma.checkIn.update({
        where: { id: checkIn.id },
        data: { status: "EMAIL_ERROR" }
      });
      response.status(502).json({
        checkIn: failedCheckIn,
        distanceMeters: Math.round(geofence.distanceMeters),
        message: "照片已保存，但打卡邮件发送失败，请稍后重新提交"
      });
    }
  } catch (error) {
    if (savedPhotoUrl) await photoStorage.removeByPublicUrl(savedPhotoUrl);
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "打卡参数不合法", issues: error.flatten() });
      return;
    }
    next(error);
  }
});

checkInRouter.use(
  (error: Error, _request: Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof multer.MulterError) {
      response.status(400).json({ message: "照片大小不能超过 10MB" });
      return;
    }
    next(error);
  }
);
