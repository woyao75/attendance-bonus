import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import {
  hashPassword,
  passwordSchema,
  tokenHash,
  verifyPassword,
} from "../lib/password.js";
import {
  authenticate,
  cookieName,
  publicUser,
  sessionToken,
} from "../middleware/auth.js";
import { fail, route } from "../lib/http.js";
export const authRouter = Router();
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
});
authRouter.post(
  "/login",
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? "127.0.0.1")}:${typeof req.body?.account === "string" ? req.body.account.trim().toLowerCase().slice(0, 64) : "invalid"}`,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "尝试过多，请 15 分钟后再试" },
  }),
  route(async (req, res) => {
    const input = z
      .object({
        account: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(128),
      })
      .parse(req.body);
    const user = await prisma.user.findUnique({
      where: { studentId: input.account },
    });
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? null,
    );
    if (
      !user ||
      !valid ||
      !user.active ||
      (user.lockedUntil && user.lockedUntil > new Date())
    ) {
      if (user && !valid) {
        const updated = await prisma.user.update({
          where: { id: user.id },
          data: { loginFailures: { increment: 1 } },
        });
        if (updated.loginFailures >= 5)
          await prisma.user.update({
            where: { id: user.id },
            data: {
              lockedUntil: new Date(Date.now() + 15 * 60_000),
              loginFailures: 0,
            },
          });
      }
      throw fail(401, "账号或密码错误，或账号已被停用/暂时锁定");
    }
    const token = randomBytes(32).toString("hex");
    await prisma.$transaction(async (tx) => {
      const unchanged = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordHash: user.passwordHash,
          active: true,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
        },
        data: { loginFailures: 0, lockedUntil: null },
      });
      if (!unchanged.count) throw fail(401, "账号状态已变化，请重新登录");
      await tx.session.deleteMany({
        where: {
          OR: [
            { tokenHash: tokenHash(sessionToken(req)) },
            { expiresAt: { lt: new Date() } },
          ],
        },
      });
      await tx.session.create({
        data: {
          tokenHash: tokenHash(token),
          userId: user.id,
          expiresAt: new Date(Date.now() + 8 * 3600_000),
        },
      });
      await tx.auditLog.create({
        data: { actorId: user.id, action: "LOGIN", targetId: user.id },
      });
    });
    res.cookie(cookieName, token, { ...cookieOptions(), maxAge: 8 * 3600_000 });
    res.json({
      user: await prisma.user.findUnique({
        where: { id: user.id },
        select: publicUser,
      }),
    });
  }),
);
authRouter.get("/me", authenticate, (req, res) => {
  res.json({ user: req.auth });
});
authRouter.post(
  "/logout",
  route(async (req, res) => {
    await prisma.session.deleteMany({
      where: { tokenHash: tokenHash(sessionToken(req)) },
    });
    res.clearCookie(cookieName, cookieOptions()).json({ ok: true });
  }),
);
authRouter.post(
  "/change-password",
  authenticate,
  route(async (req, res) => {
    const body = z
      .object({ oldPassword: z.string().max(128), password: passwordSchema })
      .parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.auth.id },
    });
    if (!(await verifyPassword(body.oldPassword, user.passwordHash)))
      throw fail(400, "原密码错误");
    if (body.oldPassword === body.password)
      throw fail(400, "新密码不能与原密码相同");
    const passwordHash = await hashPassword(body.password);
    await prisma.$transaction(async (tx) => {
      const unchanged = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash, active: true },
        data: { passwordHash, mustChangePassword: false },
      });
      if (!unchanged.count) throw fail(409, "账号状态已变化，请重新登录");
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: "PASSWORD_CHANGED",
          targetId: user.id,
        },
      });
    });
    res.clearCookie(cookieName, cookieOptions()).json({ ok: true });
  }),
);
