import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated local attendance_test database.",
  );
const parsed = new URL(dbUrl);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  !parsed.pathname.startsWith("/attendance_test")
)
  throw new Error("Refusing non-test database");
process.env.DATABASE_URL = dbUrl;
process.env.APP_ORIGINS = "http://127.0.0.1:5191";
process.env.MAIL_TARGET = "archive@example.test";
process.env.MAIL_SIGNING_SECRET = "browser-test-only-secret".repeat(3);
process.env.LOCAL_EMAIL_MODE = "false";
process.env.UPLOAD_DIR = path.resolve(".local/browser-uploads");
const { createApp } = await import("../apps/api/dist/app.js");
const { prisma } = await import("../apps/api/dist/lib/prisma.js");
const { hashPassword } = await import("../apps/api/dist/lib/password.js");
const suffix = randomUUID().slice(0, 8);
const password = "Browser-test-password-2026";
const errors = [];
const projectRoot = process.cwd();
let browser, vite, server;
try {
  const classroom = await prisma.class.create({
    data: { name: `浏览器测试班-${suffix}` },
  });
  const passwordHash = await hashPassword(password);
  const admin = await prisma.user.create({
    data: {
      studentId: `admin-${suffix}`,
      name: "测试管理员",
      role: "ADMIN",
      passwordHash,
      mustChangePassword: false,
    },
  });
  const student = await prisma.user.create({
    data: {
      studentId: `student-${suffix}`,
      name: "测试学生",
      role: "STUDENT",
      classId: classroom.id,
      passwordHash,
      mustChangePassword: true,
    },
  });
  const task = await prisma.task.create({
    data: {
      title: `浏览器返校任务-${suffix}`,
      ownerId: admin.id,
      startTime: new Date(Date.now() - 60000),
      endTime: new Date(Date.now() + 3600000),
      targetEmail: "archive@example.test",
      centerLat: 30,
      centerLng: 120,
      members: {
        create: {
          userId: student.id,
          studentId: student.studentId,
          name: student.name,
          className: classroom.name,
        },
      },
    },
  });
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const apiPort = server.address().port;
  process.chdir(path.join(projectRoot, "apps/web"));
  vite = await createServer({
    root: process.cwd(),
    configFile: path.join(process.cwd(), "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: 5191,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${apiPort}` },
    },
  });
  await vite.listen();
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" && existsSync(edge)
      ? { executablePath: edge }
      : {}),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: 30, longitude: 120, accuracy: 10 },
    permissions: ["camera", "geolocation"],
  });
  // Desktop fake cameras have no facingMode; actual permission and video-frame capture remain real browser APIs.
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints.video && typeof constraints.video === "object")
        delete constraints.video.facingMode;
      return original(constraints);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5191/");
  await page.getByLabel("账号", { exact: true }).fill(student.studentId);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设置个人密码" }),
  ).toBeVisible();
  await page.getByLabel("原密码", { exact: true }).fill(password);
  await page
    .getByLabel("新密码（至少 12 位）", { exact: true })
    .fill(password + "-changed");
  await page
    .getByLabel("确认新密码", { exact: true })
    .fill(password + "-changed");
  await page.getByRole("button", { name: "保存密码并退出" }).click();
  await page.getByLabel("账号", { exact: true }).fill(student.studentId);
  await page.getByLabel("密码", { exact: true }).fill(password + "-changed");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(task.title) }).click();
  const shutter = page.getByRole("button", { name: "拍照", exact: true });
  await expect(shutter).toBeEnabled({ timeout: 20000 });
  await shutter.click();
  await expect(page.getByAltText("待提交的带水印照片")).toBeVisible();
  await page.getByRole("button", { name: "重新拍摄" }).click();
  await shutter.click();
  await context.setGeolocation({ latitude: 31, longitude: 121, accuracy: 10 });
  await page.getByRole("button", { name: "确认并提交" }).click();
  await expect(
    page.getByRole("heading", { name: "已保存，邮件排队发送中" }),
  ).toBeVisible();
  const record = await prisma.checkIn.findUniqueOrThrow({
    where: { taskId_userId: { taskId: task.id, userId: student.id } },
  });
  expect(record.lat).toBe(30);
  expect(record.lng).toBe(120);
  await mkdir(path.join(projectRoot, ".local/browser-results"), {
    recursive: true,
  });
  await page.screenshot({
    path: path.join(projectRoot, ".local/browser-results/student.png"),
    fullPage: true,
  });
  const adminContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const manager = await adminContext.newPage();
  manager.on("pageerror", (error) => errors.push(error.message));
  await manager.goto("http://127.0.0.1:5191/");
  await manager.getByLabel("账号", { exact: true }).fill(admin.studentId);
  await manager.getByLabel("密码", { exact: true }).fill(password);
  await manager.getByRole("button", { name: "登录", exact: true }).click();
  // 邮件解析另有集成测试；这里准备审核状态，验证后台审核与归档的区别。
  await prisma.checkIn.update({
    where: { id: record.id },
    data: { status: "REVIEWING" },
  });
  await manager.getByRole("combobox").first().selectOption(task.id);
  await manager.getByRole("button", { name: "刷新数据" }).click();
  await manager.getByRole("button", { name: "查看详情" }).click();
  await manager.getByRole("button", { name: "通过", exact: true }).click();
  await expect(manager.getByRole("dialog")).toHaveCount(0);
  expect(
    (await prisma.checkIn.findUniqueOrThrow({ where: { id: record.id } }))
      .status,
  ).toBe("APPROVED");
  await manager.getByRole("button", { name: "材料中心", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: task.title, exact: true }),
  ).toHaveCount(0);
  await prisma.task.update({
    where: { id: task.id },
    data: { endTime: new Date(Date.now() - 1000) },
  });
  await manager.getByRole("button", { name: "归档任务", exact: true }).click();
  await expect(
    manager.getByRole("button", { name: task.title, exact: true }),
  ).toBeVisible();
  expect(
    (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status,
  ).toBe("ARCHIVED");
  await manager.getByRole("button", { name: "人员与任务管理" }).click();
  await manager
    .getByLabel("班级名称", { exact: true })
    .fill(`界面创建班级-${suffix}`);
  await manager.getByRole("button", { name: "创建", exact: true }).click();
  await expect(manager.getByRole("status")).toHaveText("操作成功");
  expect(
    await prisma.class.count({ where: { name: `界面创建班级-${suffix}` } }),
  ).toBe(1);
  await manager.screenshot({
    path: path.join(projectRoot, ".local/browser-results/management.png"),
    fullPage: true,
  });
  await manager.getByRole("button", { name: "退出登录" }).click();
  await expect(
    manager.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "Browser passed: login, forced password change, camera readiness, retake, capture-time coordinates, submit, review, archive, class creation, logout.",
  );
} finally {
  await browser?.close();
  await vite?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  process.chdir(projectRoot);
}
