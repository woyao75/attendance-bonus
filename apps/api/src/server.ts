import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.APP_ORIGINS?.startsWith("https://") ||
    !process.env.MAIL_SIGNING_SECRET ||
    process.env.MAIL_SIGNING_SECRET.length < 32)
)
  throw new Error("生产环境必须配置 HTTPS APP_ORIGINS 和 MAIL_SIGNING_SECRET");
const host =
  process.env.HOST ??
  (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
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
