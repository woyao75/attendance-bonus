import type { Request, RequestHandler } from "express";
import type { UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { tokenHash } from "../lib/password.js";
import { fail } from "../lib/http.js";

export const publicUser = {
  id: true,
  studentId: true,
  email: true,
  name: true,
  role: true,
  classId: true,
  active: true,
  mustChangePassword: true,
} as const;
export type Identity = {
  id: string;
  studentId: string;
  email: string | null;
  name: string;
  role: UserRole;
  classId: string | null;
  active: boolean;
  mustChangePassword: boolean;
};
declare global {
  namespace Express {
    interface Request {
      auth: Identity;
      sessionHash: string;
    }
  }
}
export const cookieName = "attendance_session";
export function sessionToken(req: Request) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? ""
  );
}
export const authenticate: RequestHandler = (req, res, next) => {
  (async () => {
    const token = sessionToken(req);
    if (!/^[a-f0-9]{64}$/.test(token)) throw fail(401, "请先登录");
    const hash = tokenHash(token);
    const session = await prisma.session.findUnique({
      where: { tokenHash: hash },
      include: { user: { select: publicUser } },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.active)
      throw fail(401, "登录已过期，请重新登录");
    req.auth = session.user;
    req.sessionHash = hash;
    next();
  })().catch(next);
};
export const passwordChanged: RequestHandler = (req, _res, next) =>
  next(req.auth.mustChangePassword ? fail(403, "请先修改初始密码") : undefined);
export const roles =
  (...allowed: UserRole[]): RequestHandler =>
  (req, _res, next) =>
    next(
      allowed.includes(req.auth.role) ? undefined : fail(403, "没有操作权限"),
    );

export function taskScope(user: Identity) {
  return user.role === "ADMIN"
    ? {}
    : user.role === "COUNSELOR"
      ? { ownerId: user.id }
      : { members: { some: { userId: user.id } } };
}
export async function accessibleTask(
  user: Identity,
  taskId: string,
  manage = false,
) {
  if (manage && user.role === "STUDENT") throw fail(403, "没有管理权限");
  const task = await prisma.task.findFirst({
    where: { id: taskId, ...taskScope(user) },
  });
  if (!task) throw fail(404, "任务不存在或无权访问");
  return task;
}
export async function manageableClasses(user: Identity, ids: string[]) {
  const classes = await prisma.class.findMany({
    where: {
      id: { in: ids },
      active: true,
      ...(user.role === "ADMIN"
        ? {}
        : { counselors: { some: { userId: user.id } } }),
    },
  });
  if (user.role === "STUDENT" || classes.length !== new Set(ids).size)
    throw fail(403, "班级不存在、已停用或无权管理");
  return classes;
}
