import "dotenv/config";
import { prisma } from "./lib/prisma.js";
const keys = [
  "DATABASE_URL",
  "MAIL_TARGET",
  "MAIL_SIGNING_SECRET",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "IMAP_HOST",
  "IMAP_USER",
  "IMAP_PASS",
];
const localEmailMode = process.env.LOCAL_EMAIL_MODE === "true";
let problems = 0;
for (const key of keys) {
  const value = process.env[key];
  const optionalInLocalMode =
    localEmailMode &&
    [
      "MAIL_TARGET",
      "MAIL_SIGNING_SECRET",
      "SMTP_HOST",
      "SMTP_USER",
      "SMTP_PASS",
    ].includes(key);
  const valid =
    optionalInLocalMode ||
    Boolean(
      value &&
      !/replace|example\.com|your-provider|your-school/i.test(value) &&
      (key !== "MAIL_SIGNING_SECRET" || value.length >= 32),
    );
  console.log(`${key}: ${valid ? "已配置（不显示内容）" : "需要配置"}`);
  if (!valid) problems++;
}
if (localEmailMode)
  console.log("邮件模式：本地直收（SMTP 和签名密钥无需配置）");
try {
  await prisma.$queryRaw`SELECT 1`;
  console.log("数据库连接：成功");
  await prisma.session.count();
  await prisma.taskMember.count();
  console.log("新版数据表：可访问");
  console.log(
    `可登录管理员：${(await prisma.user.count({ where: { role: "ADMIN", active: true, passwordHash: { not: null } } })) > 0 ? "存在" : "需要运行 admin:create"}`,
  );
} catch {
  problems++;
  console.log("数据库连接/新版数据表：未就绪，请先备份再运行 db:deploy");
} finally {
  await prisma.$disconnect();
}
process.exitCode = problems ? 1 : 0;
