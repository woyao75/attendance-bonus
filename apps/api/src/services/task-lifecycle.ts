import { prisma } from "../lib/prisma.js";
import { fail } from "../lib/http.js";
import type { Prisma, TaskStatus } from "@prisma/client";

type LockedTask = {
  id: string;
  status: TaskStatus;
  startTime: Date;
  endTime: Date;
};

export async function lockTaskForUpdate(tx: Prisma.TransactionClient, taskId: string) {
  const rows = await tx.$queryRaw<LockedTask[]>`
    SELECT id, status, startTime, endTime
    FROM Task
    WHERE id = ${taskId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function archiveTask(taskId: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const task = await lockTaskForUpdate(tx, taskId);
    if (!task || task.status === "ARCHIVED") throw fail(409, "任务已归档或不存在");
    if (task.endTime > new Date()) throw fail(409, "任务结束后才能归档");
    const pending = await tx.checkIn.count({
      where: { taskId, status: { in: ["EMAIL_PENDING", "EMAIL_SENT", "REVIEWING"] } },
    });
    if (pending) throw fail(409, "请先处理待发送、待收件和待审核记录");
    await tx.task.update({ where: { id: taskId }, data: { status: "ARCHIVED" } });
    await tx.auditLog.create({ data: { actorId, action: "TASK_ARCHIVED", targetId: taskId } });
  });
}

// 时间推进只向前转换；已归档任务永远不重新开放。
export async function syncTaskStatuses(now = new Date()) {
  await prisma.task.updateMany({
    where: {
      status: "NOT_STARTED",
      startTime: { lte: now },
      endTime: { gt: now },
    },
    data: { status: "IN_PROGRESS" },
  });
  await prisma.task.updateMany({
    where: {
      status: { in: ["NOT_STARTED", "IN_PROGRESS"] },
      endTime: { lte: now },
    },
    data: { status: "COMPLETED" },
  });
}
