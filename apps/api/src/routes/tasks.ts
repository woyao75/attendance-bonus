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
async function agentSnapshot() {
  try {
    const state = JSON.parse(await readFile(process.env.AGENT_STATUS_FILE ?? "./uploads/agent-status.json", "utf8")) as typeof mailAgentStatus & { heartbeatAt?: string };
    if (!state.heartbeatAt || !Number.isFinite(new Date(state.heartbeatAt).getTime()) || Date.now() - new Date(state.heartbeatAt).getTime() > 180_000)
      return { ...state, lastError: "邮件服务心跳超时" };
    return state;
  } catch {
    return { ...mailAgentStatus, lastError: "邮件服务尚未启动" };
  }
}
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
    res.json({ tasks, localEmailMode: process.env.LOCAL_EMAIL_MODE === "true" });
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
      .parse(process.env.LOCAL_EMAIL_MODE === "true" ? process.env.IMAP_USER : process.env.MAIL_TARGET);
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
              userId: true,
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
taskRouter.get(
  "/:taskId/credentials",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    if (process.env.LOCAL_EMAIL_MODE !== "true") throw fail(409, "当前未启用本地直收邮件模式");
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    const members = await prisma.taskMember.findMany({
      where: { taskId: task.id },
      select: { userId: true, studentId: true, name: true, email: true, mailToken: true },
      orderBy: { studentId: "asc" },
    });
    await prisma.auditLog.create({ data: { actorId: req.auth.id, action: "MAIL_CREDENTIALS_VIEWED", targetId: task.id } });
    res.json({ id: task.id, title: task.title, members });
  }),
);
taskRouter.patch(
  "/:taskId/members/:userId/mail-credential",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    if (process.env.LOCAL_EMAIL_MODE !== "true") throw fail(409, "当前未启用本地直收邮件模式");
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    if (task.status === "ARCHIVED" || task.endTime <= new Date()) throw fail(409, "已结束或归档的任务不能更改邮件凭据");
    const input = z.object({
      email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()).optional(),
      rotateToken: z.boolean().optional(),
    }).strict().parse(req.body);
    if (!input.email && !input.rotateToken) throw fail(400, "请输入新邮箱或选择轮换验证码");
    const member = await prisma.taskMember.findUnique({ where: { taskId_userId: { taskId: task.id, userId: req.params.userId } } });
    if (!member) throw fail(404, "任务成员不存在");
    const email = input.email ?? member.email;
    if (!email) throw fail(409, "请先为该任务成员登记可信邮箱");
    if (email && await prisma.taskMember.findFirst({ where: { taskId: task.id, email, userId: { not: member.userId } } }))
      throw fail(409, "该邮箱已分配给本任务其他学生");
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.taskMember.updateMany({
        where: { taskId: task.id, userId: member.userId, mailToken: member.mailToken },
        data: { email, mailToken: randomBytes(16).toString("hex") },
      });
      if (!changed.count) throw fail(409, "邮件凭据已变化，请刷新后重试");
      const checkIn = await tx.checkIn.findUnique({ where: { taskId_userId: { taskId: task.id, userId: member.userId } } });
      if (checkIn && !["NOT_CHECKED", "REJECTED", "EMAIL_ERROR"].includes(checkIn.status))
        throw fail(409, "该学生已提交有效邮件或正在审核，不能更改凭据");
      await tx.auditLog.create({ data: { actorId: req.auth.id, action: "MAIL_CREDENTIAL_ROTATED", targetId: `${task.id}:${member.userId}` } });
      return tx.taskMember.findUniqueOrThrow({ where: { taskId_userId: { taskId: task.id, userId: member.userId } }, select: { userId: true, studentId: true, name: true, email: true, mailToken: true } });
    });
    res.json({ member: updated });
  }),
);
taskRouter.patch(
  "/:taskId/archive",
  roles("ADMIN", "COUNSELOR"),
  route(async (req, res) => {
    const task = await accessibleTask(req.auth, req.params.taskId, true);
    if (task.endTime > new Date()) throw fail(409, "任务结束后才能归档");
    if (process.env.LOCAL_EMAIL_MODE === "true") {
      const agent = await agentSnapshot();
      if (agent.lastError || agent.queueLength !== 0 || !agent.lastSuccessAt || new Date(agent.lastSuccessAt) <= task.endTime)
        throw fail(409, "请等待任务结束后的邮件服务完整扫描，并清理待处理邮件后再归档");
    }
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
    const [expected, checkIns, outboxQueueLength, rejectedMailCount, agent] = await Promise.all([
      prisma.taskMember.count({ where: { taskId: task.id } }),
      prisma.checkIn.findMany({ where: { taskId: task.id } }),
      prisma.mailOutbox.count({ where: { sentAt: null, attempts: { lt: 5 } } }),
      prisma.inboundMailLog.count({
        where: { taskId: task.id, status: "REJECTED" },
      }),
      agentSnapshot(),
    ]);
    const approved = checkIns.filter((c) => c.status === "APPROVED").length;
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
      agent: { ...agent, outboxQueueLength, rejectedMailCount },
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
