import { prisma } from "../lib/prisma.js";

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
