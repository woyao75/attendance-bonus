import "dotenv/config";
import { prisma } from "./lib/prisma.js";
import { hashPassword, passwordSchema } from "./lib/password.js";
import { z } from "zod";
try {
  const account = z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .parse(process.env.ADMIN_ACCOUNT);
  const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);
  if (await prisma.user.findUnique({ where: { studentId: account } }))
    throw new Error("账号已存在；初始化脚本不会覆盖已有账号或密码");
  await prisma.user.create({
    data: {
      studentId: account,
      name: "系统管理员",
      role: "ADMIN",
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    },
  });
  console.log(
    "管理员已创建，首次登录需修改密码。请移除 ADMIN_PASSWORD 环境变量。",
  );
} finally {
  await prisma.$disconnect();
}
