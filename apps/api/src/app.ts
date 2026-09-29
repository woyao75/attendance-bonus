import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import multer from "multer";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./lib/prisma.js";
import { authRouter } from "./routes/auth.js";
import { taskRouter } from "./routes/tasks.js";
import { checkInRouter } from "./routes/check-ins.js";
import { managementRouter } from "./routes/management.js";
import { authenticate, passwordChanged } from "./middleware/auth.js";
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  app.use(helmet());
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/ready", (_req, res) => {
    prisma.$queryRaw`SELECT 1`
      .then(() => res.json({ status: "ok" }))
      .catch(() => res.status(503).json({ status: "unavailable" }));
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      // 校园 NAT 下多人共用出口；细粒度配额在认证后按账号计算。
      limit: 3000,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { message: "请求过于频繁" },
    }),
  );
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const allowed = (
      process.env.APP_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",");
    if (process.env.LOCAL_EMAIL_MODE === "true" && process.env.NODE_ENV === "production") {
      const port = Number(process.env.PORT ?? 3000);
      allowed.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
    }
    if (
      !allowed.includes(req.headers.origin ?? "") ||
      req.headers["x-attendance-request"] !== "1"
    ) {
      res.status(403).json({ message: "请求来源校验失败，请从本站页面操作" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/auth", authRouter);
  app.use("/api", authenticate, passwordChanged);
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 180,
      keyGenerator: (req) => req.auth.id,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { message: "当前账号请求过于频繁，请稍后再试" },
    }),
  );
  app.use("/api/tasks", taskRouter);
  app.use("/api/check-ins", checkInRouter);
  app.use("/api/manage", managementRouter);
  if (process.env.LOCAL_EMAIL_MODE === "true" && process.env.NODE_ENV === "production") {
    const dist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
    const index = path.join(dist, "index.html");
    if (!existsSync(index)) throw new Error("缺少前端构建产物，请先运行 npm run build");
    app.use(express.static(dist, { index: false }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || path.extname(req.path) || !req.accepts("html")) return next();
      res.sendFile(index, (error) => { if (error) next(error); });
    });
  }
  app.use((_req, res) => {
    res.status(404).json({ message: "接口不存在" });
  });
  app.use(
    (
      error: Error & { statusCode?: number; status?: number },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) return next(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({
          message: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        res.status(400).json({ message: "上传超过限制（单张 8MB）或字段无效" });
        return;
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2002", "P2025", "P2003", "P2034"].includes(error.code)
      ) {
        res
          .status(409)
          .json({ message: "记录重复、已变更或关联不存在，请刷新后重试" });
        return;
      }
      const status =
        error.statusCode ??
        (error.status === 400 || error.status === 413 ? error.status : 500);
      if (status === 500) console.error("API request failed", error.name);
      res.status(status).json({
        message: status >= 500 ? "服务暂时不可用，请稍后重试" : error.message,
      });
    },
  );
  return app;
}
