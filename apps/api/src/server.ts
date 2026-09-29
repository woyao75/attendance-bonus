import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
const localMode = process.env.LOCAL_EMAIL_MODE === "true";
if (process.env.NODE_ENV === "production") {
  if (localMode) {
    const origins = (process.env.APP_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",");
    if (origins.some((origin) => {
      try {
        const value = new URL(origin.trim());
        return !["http:", "https:"].includes(value.protocol) || !["localhost", "127.0.0.1"].includes(value.hostname);
      }
      catch { return true; }
    })) throw new Error("本地直收模式的 APP_ORIGINS 只能使用本机回环地址");
    if (process.env.HOST && !["localhost", "127.0.0.1"].includes(process.env.HOST))
      throw new Error("本地直收模式只能监听本机回环地址");
  } else if (!process.env.APP_ORIGINS?.split(",").every((origin) => origin.trim().startsWith("https://")) ||
    !process.env.MAIL_SIGNING_SECRET || process.env.MAIL_SIGNING_SECRET.length < 32) {
    throw new Error("生产环境必须配置 HTTPS APP_ORIGINS 和 MAIL_SIGNING_SECRET");
  }
}
const host =
  process.env.HOST ??
  (process.env.NODE_ENV === "production" && !localMode ? "0.0.0.0" : "127.0.0.1");
const server = createApp().listen(Number(process.env.PORT ?? 3000), host, () =>
  console.log(`API ready on ${host}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
