import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, route } from "../lib/http.js";
import {
  accessibleTask,
  manageableClasses,
  roles,
  taskScope,
} from "../middleware/auth.js";
import {
  buildApprovedPhotosZip,
  buildTaskWorkbook,
} from "../services/task-exports.js";
import { mailAgentStatus } from "../services/mail-agent.js";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
export const taskRouter = Router();
const taskSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    startTime: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v)),
    endTime: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v)),
    gestureImgUrl: z
      .string()
      .url()
      .max(2048)
      .refine((v) => v.startsWith("https://"), "手势图必须使用 HTTPS")
      .optional(),
    centerLat: z.number().finite().min(-90).max(90),
    centerLng: z.number().finite().min(-180).max(180),
    radius: z.number().int().min(50).max(20000).default(800),
    classIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  })
  .refine(
    (v) => v.endTime > v.startTime && v.endTime > new Date(),
    "结束时间必须晚于开始时间和当前时间",
  );
taskRouter.get(
  "/",
  route(async (req, res) => {
    const tasks = await prisma.task.findMany({
      where: taskScope(req.auth),
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ tasks });
  }),
);
taskRouter.post(
  "/",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const { classIds, ...input } = taskSchema.parse(req.body);
    await manageableClasses(req.auth, classIds);
    const targetEmail = z
      .string()
      .email()
      .parse(process.env.MAIL_TARGET || process.env.IMAP_USER);
    const task = await prisma.$transaction(async (tx) => {
      const students = await tx.user.findMany({
        where: { classId: { in: classIds }, role: "STUDENT", active: true },
        include: { class: true },
      });
      if (!students.length) throw fail(400, "所选班级没有启用的学生账号");
      if (
        process.env.LOCAL_EMAIL_MODE === "true" &&
        students.some((student) => !student.email)
      )
        throw fail(
          400,
          "本地邮箱模式下，所有学生必须先登记可信学校邮箱后才能发布任务",
        );
      return tx.task.create({
        data: {
          ...input,
          status: input.startTime <= new Date() ? "IN_PROGRESS" : "NOT_STARTED",
          targetEmail,
          ownerId: req.auth.id,
          members: {
            create: students.map((u) => ({
              userId: u.id,
              name: u.name,
              studentId: u.studentId,
              email: u.email,
              mailToken:
                process.env.LOCAL_EMAIL_MODE === "true"
                  ? randomBytes(16).toString("hex")
                  : null,
              className: u.class!.name,
            })),
          },
        },
        include: {
          members: {
            select: {
              studentId: true,
              name: true,
              email: true,
              mailToken: true,
            },
            orderBy: { studentId: "asc" },
          },
        },
      });
    });
    res.status(201).json(task);
  }),
);
taskRouter.get(
  "/:taskId",
  route(async (req, res) => {
    res.json(
      await accessibleTask(
        req.auth,
        z.string().cuid().parse(req.params.taskId),
      ),
    );
  }),
);
taskRouter.patch(
  "/:taskId/archive",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    if (task.endTime > new Date()) throw fail(409, "任务结束后才能归档");
    if (
      await prisma.checkIn.count({
        where: {
          taskId: task.id,
          status: { in: ["EMAIL_PENDING", "EMAIL_SENT", "REVIEWING"] },
        },
      })
    )
      throw fail(409, "请先处理待发送、待收件和待审核记录");
    await prisma.$transaction([
      prisma.task.update({
        where: { id: task.id },
        data: { status: "ARCHIVED" },
      }),
      prisma.auditLog.create({
        data: {
          actorId: req.auth.id,
          action: "TASK_ARCHIVED",
          targetId: task.id,
        },
      }),
    ]);
    res.json({ ok: true });
  }),
);
taskRouter.get(
  "/:taskId/dashboard",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    const [expected, checkIns, queueLength, rejectedMailCount] = await Promise.all([
      prisma.taskMember.count({ where: { taskId: task.id } }),
      prisma.checkIn.findMany({ where: { taskId: task.id } }),
      prisma.mailOutbox.count({ where: { sentAt: null, attempts: { lt: 5 } } }),
      prisma.inboundMailLog.count({
        where: { taskId: task.id, status: "REJECTED" },
      }),
    ]);
    const approved = checkIns.filter((c) => c.status === "APPROVED").length;
    try {
      const state = JSON.parse(
        await readFile(
          process.env.AGENT_STATUS_FILE ?? "./uploads/agent-status.json",
          "utf8",
        ),
      );
      Object.assign(mailAgentStatus, state);
      if (
        !state.heartbeatAt ||
        Date.now() - new Date(state.heartbeatAt).getTime() > 180_000
      )
        mailAgentStatus.lastError = "邮件服务心跳超时";
    } catch {
      mailAgentStatus.lastError = "邮件服务尚未启动";
    }
    const submitted = checkIns.filter((c) => c.submittedAt);
    const buckets = new Map<string, number>();
    for (const c of submitted) {
      const time = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
      }).format(c.submittedAt!);
      buckets.set(time, (buckets.get(time) ?? 0) + 1);
    }
    res.json({
      task,
      metrics: {
        expected,
        checkedIn: approved,
        approved,
        submitted: submitted.length,
        notChecked: expected - submitted.length,
        pending: checkIns.filter((c) =>
          ["EMAIL_PENDING", "EMAIL_SENT", "REVIEWING"].includes(c.status),
        ).length,
        abnormal: checkIns.filter((c) =>
          ["REJECTED", "EMAIL_ERROR"].includes(c.status),
        ).length,
      },
      agent: { ...mailAgentStatus, queueLength, rejectedMailCount },
      timeDistribution: [...buckets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, count]) => ({ time, count })),
    });
  }),
);
taskRouter.get(
  "/:taskId/check-ins",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    const status = z
      .enum([
        "NOT_CHECKED",
        "EMAIL_PENDING",
        "EMAIL_SENT",
        "REVIEWING",
        "APPROVED",
        "REJECTED",
        "EMAIL_ERROR",
      ])
      .optional()
      .parse(req.query.status);
    const [members, records] = await Promise.all([
      prisma.taskMember.findMany({
        where: { taskId: task.id },
        orderBy: { studentId: "asc" },
      }),
      prisma.checkIn.findMany({ where: { taskId: task.id } }),
    ]);
    const byUser = new Map(records.map((c) => [c.userId, c]));
    const rows = members
      .map((m) => {
        const record = byUser.get(m.userId);
        return {
          user: {
            id: m.userId,
            studentId: m.studentId,
            name: m.name,
            classId: m.className,
            email: m.email,
            mailToken: m.mailToken,
          },
          status: record?.status ?? "NOT_CHECKED",
          checkIn: record
            ? {
                ...record,
                photoUrl: record.photoUrl
                  ? `/api/check-ins/${record.id}/photo`
                  : null,
                createdAt: record.submittedAt ?? record.createdAt,
              }
            : null,
        };
      })
      .filter((r) => !status || r.status === status);
    res.json({ rows });
  }),
);
taskRouter.get(
  "/:taskId/export/excel",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(`check-in-${task.id}.xlsx`)
      .send(await buildTaskWorkbook(task.id));
  }),
);
taskRouter.get(
  "/:taskId/export/photos",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    const stream = await buildApprovedPhotosZip(task.id);
    res.type("application/zip").attachment(`approved-photos-${task.id}.zip`);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }),
);
