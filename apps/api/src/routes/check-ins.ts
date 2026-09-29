import { Router } from "express";
import type { CheckIn } from "@prisma/client";
import multer from "multer";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isWithinGeofence } from "../lib/geo.js";
import { photoStorage } from "../lib/storage.js";
import { accessibleTask, roles } from "../middleware/auth.js";
import { fail, route } from "../lib/http.js";
import { createMailBody } from "../services/check-in-mailer.js";
export const checkInRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8, parts: 9 },
});
const numberField = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().finite());
const inputSchema = z.object({
  taskId: z.string().cuid(),
  lat: numberField.pipe(z.number().min(-90).max(90)),
  lng: numberField.pipe(z.number().min(-180).max(180)),
  accuracy: numberField.pipe(z.number().min(0).max(200)),
  capturedAt: z.string().datetime(),
  address: z.string().trim().max(300).optional(),
});
const view = (c: CheckIn | null) =>
  c
    ? { ...c, photoUrl: c.photoUrl ? `/api/check-ins/${c.id}/photo` : null }
    : null;
checkInRouter.get(
  "/",
  roles("STUDENT"),
  route(async (req, res) => {
    const taskId = z.string().cuid().parse(req.query.taskId);
    await accessibleTask(req.auth, taskId);
    res.json({
      checkIn: view(
        await prisma.checkIn.findUnique({
          where: { taskId_userId: { taskId, userId: req.auth.id } },
        }),
      ),
    });
  }),
);
checkInRouter.get(
  "/:id/photo",
  route(async (req, res) => {
    const c = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
    if (
      !c?.photoUrl ||
      (req.auth.role === "STUDENT" && c.userId !== req.auth.id)
    )
      throw fail(404, "照片不存在或无权访问");
    await accessibleTask(req.auth, c.taskId);
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(photoStorage.resolvePublicUrl(c.photoUrl));
  }),
);
checkInRouter.patch(
  "/:id/review",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const input = z
      .object({
        status: z.enum(["APPROVED", "REJECTED"]),
        rejectReason: z.string().trim().max(300).optional(),
      })
      .refine(
        (v) => v.status !== "REJECTED" || Boolean(v.rejectReason),
        "驳回必须填写原因",
      )
      .parse(req.body);
    const c = await prisma.checkIn.findUnique({ where: { id: req.params.id } });
    if (!c) throw fail(404, "记录不存在");
    const task = await accessibleTask(req.auth, c.taskId, true);
    if (task.status === "ARCHIVED") throw fail(409, "归档任务不能修改");
    await prisma.$transaction(async (tx) => {
      const result = await tx.checkIn.updateMany({
        where: { id: c.id, status: "REVIEWING", attemptId: c.attemptId },
        data: {
          status: input.status,
          rejectReason: input.status === "REJECTED" ? input.rejectReason : null,
        },
      });
      if (!result.count) throw fail(409, "记录已更新，请刷新后再审核");
      await tx.auditLog.create({
        data: { actorId: req.auth.id, action: input.status, targetId: c.id },
      });
    });
    res.json({ ok: true });
  }),
);
checkInRouter.post(
  "/",
  roles("STUDENT"),
  upload.single("photo"),
  route(async (req, res) => {
    if (process.env.LOCAL_EMAIL_MODE === "true")
      throw fail(409, "本地直收模式请按任务专属主题直接发送邮件，网页拍照提交已停用");
    const input = inputSchema.parse(req.body);
    const task = await accessibleTask(req.auth, input.taskId);
    const now = new Date();
    if (
      task.status === "ARCHIVED" ||
      task.status === "COMPLETED" ||
      now < task.startTime ||
      now > task.endTime
    )
      throw fail(409, "当前不在任务打卡时间内");
    const capturedAt = new Date(input.capturedAt);
    if (
      capturedAt.getTime() > Date.now() + 30_000 ||
      capturedAt.getTime() < Date.now() - 5 * 60_000
    )
      throw fail(400, "照片已超过 5 分钟，请重新拍摄并确认设备时间");
    const fence = isWithinGeofence(
      input.lat,
      input.lng,
      task.centerLat,
      task.centerLng,
      task.radius,
    );
    if (!fence.withinFence) throw fail(422, "不在学校打卡范围内");
    if (!req.file) throw fail(400, "请提交相机照片");
    let buffer: Buffer;
    try {
      const image = sharp(req.file.buffer, {
        limitInputPixels: 20_000_000,
        failOn: "error",
      });
      const meta = await image.metadata();
      if (
        !["jpeg", "png", "webp"].includes(meta.format ?? "") ||
        (meta.pages ?? 1) > 1
      )
        throw new Error("format");
      buffer = await image.rotate().jpeg({ quality: 92 }).toBuffer();
    } catch {
      throw fail(400, "照片损坏、像素过大或格式不支持");
    }
    const member = await prisma.taskMember.findUniqueOrThrow({
      where: { taskId_userId: { taskId: task.id, userId: req.auth.id } },
    });
    const attemptId = randomUUID();
    const photoHash = createHash("sha256").update(buffer).digest("hex");
    const subject = `[打卡]${member.studentId}_${member.name}_${task.id}`;
    const body = createMailBody({
      taskId: task.id,
      userId: req.auth.id,
      attemptId,
      lat: input.lat,
      lng: input.lng,
      time: capturedAt.toISOString(),
      photoHash,
    });
    const photoUrl = await photoStorage.saveCheckInPhoto(task.id, req.auth.id, {
      buffer,
      mimetype: "image/jpeg",
    });
    let committed = false;
    try {
      const checkIn = await prisma.$transaction(async (tx) => {
        const existing = await tx.checkIn.findUnique({
          where: { taskId_userId: { taskId: task.id, userId: req.auth.id } },
        });
        const data = {
          photoUrl,
          lat: input.lat,
          lng: input.lng,
          address: input.address ?? null,
          accuracy: input.accuracy,
          capturedAt,
          submittedAt: now,
          attemptId,
          photoHash,
          status: "EMAIL_PENDING" as const,
          rejectReason: null,
          emailSubject: subject,
          emailReceivedAt: null,
        };
        let id: string;
        if (existing) {
          const updated = await tx.checkIn.updateMany({
            where: {
              id: existing.id,
              status: { in: ["NOT_CHECKED", "REJECTED", "EMAIL_ERROR"] },
              attemptId: existing.attemptId,
            },
            data,
          });
          if (!updated.count) throw fail(409, "打卡已提交，请查看当前状态");
          id = existing.id;
        } else {
          id = (
            await tx.checkIn.create({
              data: { ...data, taskId: task.id, userId: req.auth.id },
            })
          ).id;
        }
        await tx.mailOutbox.create({
          data: {
            id: attemptId,
            checkInId: id,
            subject,
            body,
            photoUrl,
            targetEmail: task.targetEmail,
          },
        });
        return tx.checkIn.findUniqueOrThrow({ where: { id } });
      });
      committed = true;
      res
        .status(202)
        .json({
          checkIn: view(checkIn),
          distanceMeters: Math.round(fence.distanceMeters),
          message: "打卡已保存，正在排队发送邮件",
        });
    } finally {
      if (!committed)
        await photoStorage.removeByPublicUrl(photoUrl).catch(() => undefined);
    }
  }),
);
