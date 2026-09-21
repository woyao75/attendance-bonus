import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { buildApprovedPhotosZip, buildTaskWorkbook } from "../services/task-exports.js";
import { mailAgentStatus } from "../services/mail-agent.js";

const taskSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    targetEmail: z.string().trim().email(),
    gestureImgUrl: z.string().url().optional(),
    centerLat: z.number().gte(-90).lte(90),
    centerLng: z.number().gte(-180).lte(180),
    radius: z.number().int().min(50).max(20_000).default(800)
  })
  .refine((task) => task.endTime > task.startTime, {
    message: "结束时间必须晚于开始时间",
    path: ["endTime"]
  });

export const taskRouter = Router();

taskRouter.get("/", async (_request, response, next) => {
  try {
    const tasks = await prisma.task.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    response.json({ tasks });
  } catch (error) {
    next(error);
  }
});

taskRouter.post("/", async (request, response, next) => {
  try {
    const payload = taskSchema.parse(request.body);
    const task = await prisma.task.create({ data: payload });
    response.status(201).json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "任务参数不合法", issues: error.flatten() });
      return;
    }
    next(error);
  }
});

taskRouter.get("/:taskId", async (request, response, next) => {
  try {
    const taskId = z.string().cuid().parse(request.params.taskId);
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        startTime: true,
        endTime: true,
        gestureImgUrl: true,
        centerLat: true,
        centerLng: true,
        radius: true
      }
    });
    if (!task) {
      response.status(404).json({ message: "打卡任务不存在" });
      return;
    }
    response.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "任务 ID 不合法" });
      return;
    }
    next(error);
  }
});

taskRouter.get("/:taskId/dashboard", async (request, response, next) => {
  try {
    const taskId = z.string().cuid().parse(request.params.taskId);
    const [task, students, checkIns] = await Promise.all([
      prisma.task.findUnique({ where: { id: taskId } }),
      prisma.user.findMany({ where: { role: "student" }, select: { id: true } }),
      prisma.checkIn.findMany({ where: { taskId }, select: { status: true, createdAt: true } })
    ]);
    if (!task) {
      response.status(404).json({ message: "打卡任务不存在" });
      return;
    }
    const completed = checkIns.filter((checkIn) => checkIn.status === "APPROVED").length;
    const unapproved = checkIns.filter((checkIn) => checkIn.status === "REJECTED" || checkIn.status === "EMAIL_ERROR").length;
    const pending = checkIns.filter((checkIn) => checkIn.status === "REVIEWING" || checkIn.status === "EMAIL_SENT").length;
    const distribution = new Map<string, number>();
    checkIns.forEach((checkIn) => {
      const hour = new Date(checkIn.createdAt);
      const label = `${String(hour.getHours()).padStart(2, "0")}:00`;
      distribution.set(label, (distribution.get(label) ?? 0) + 1);
    });
    response.json({
      task,
      metrics: {
        expected: students.length,
        checkedIn: completed,
        notChecked: Math.max(0, students.length - checkIns.length),
        pending,
        approved: completed,
        abnormal: unapproved
      },
      agent: mailAgentStatus,
      timeDistribution: [...distribution.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, count]) => ({ time, count }))
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "任务 ID 不合法" });
      return;
    }
    next(error);
  }
});

taskRouter.get("/:taskId/check-ins", async (request, response, next) => {
  try {
    const taskId = z.string().cuid().parse(request.params.taskId);
    const status = z.string().optional().parse(request.query.status);
    const allowedStatuses = ["NOT_CHECKED", "EMAIL_SENT", "REVIEWING", "APPROVED", "REJECTED", "EMAIL_ERROR"] as const;
    if (status && !allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
      response.status(400).json({ message: "不支持的状态筛选" });
      return;
    }
    const students = await prisma.user.findMany({
      where: { role: "student" },
      orderBy: { studentId: "asc" },
      include: { checkIns: { where: { taskId } } }
    });
    const rows = students
      .map((student) => {
        const checkIn = student.checkIns[0];
        return {
          user: { id: student.id, studentId: student.studentId, name: student.name, classId: student.classId },
          checkIn: checkIn ?? null,
          status: checkIn?.status ?? "NOT_CHECKED"
        };
      })
      .filter((row) => !status || row.status === status);
    response.json({ rows });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "任务 ID 不合法" });
      return;
    }
    next(error);
  }
});

taskRouter.get("/:taskId/export/excel", async (request, response, next) => {
  try {
    const taskId = z.string().cuid().parse(request.params.taskId);
    const file = await buildTaskWorkbook(taskId);
    response
      .status(200)
      .setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .setHeader("Content-Disposition", `attachment; filename="check-in-${taskId}.xlsx"`)
      .send(file);
  } catch (error) {
    next(error);
  }
});

taskRouter.get("/:taskId/export/photos", async (request, response, next) => {
  try {
    const taskId = z.string().cuid().parse(request.params.taskId);
    const file = await buildApprovedPhotosZip(taskId);
    response
      .status(200)
      .setHeader("Content-Type", "application/zip")
      .setHeader("Content-Disposition", `attachment; filename="approved-photos-${taskId}.zip"`)
      .send(file);
  } catch (error) {
    next(error);
  }
});
