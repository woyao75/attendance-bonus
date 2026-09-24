import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const url = new URL(process.env.TEST_DATABASE_URL ?? "");
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.startsWith("/attendance_test")
)
  throw new Error("Only a local attendance_test connection is allowed");
const base = new PrismaClient({ datasourceUrl: url.href });
const name = `attendance_test_upgrade_${Date.now()}`;
let upgraded;
try {
  await base.$executeRawUnsafe(
    `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  url.pathname = "/" + name;
  upgraded = new PrismaClient({ datasourceUrl: url.href });
  const sql = await readFile(
    "apps/api/prisma/migrations/20260920100542_init/migration.sql",
    "utf8",
  );
  for (const statement of sql.split(";").filter((s) => s.trim()))
    await upgraded.$executeRawUnsafe(statement);
  await upgraded.$executeRawUnsafe(
    "INSERT INTO User (id,studentId,name,role,classId,updatedAt) VALUES ('ckz1234567890123456789013','00001','旧学生','student','旧班级',NOW()), ('ckz1234567890123456789014','teacher','旧辅导员','counselor','',NOW())",
  );
  await upgraded.$executeRawUnsafe(
    "INSERT INTO Task (id,title,startTime,endTime,targetEmail,centerLat,centerLng,updatedAt) VALUES ('ckz1234567890123456789012','历史任务',NOW(),NOW(),'archive@example.test',30,120,NOW())",
  );
  await upgraded.$executeRawUnsafe(
    "INSERT INTO CheckIn (id,taskId,userId,status,photoUrl,updatedAt) VALUES ('ckz1234567890123456789015','ckz1234567890123456789012','ckz1234567890123456789013','APPROVED','/uploads/legacy.jpg',NOW())",
  );
  const options = {
    env: { ...process.env, DATABASE_URL: url.href },
    stdio: "pipe",
  };
  execFileSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "resolve",
      "--applied",
      "20260920100542_init",
      "--schema",
      "apps/api/prisma/schema.prisma",
    ],
    options,
  );
  execFileSync(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
      "--schema",
      "apps/api/prisma/schema.prisma",
    ],
    options,
  );
  const user = await upgraded.user.findUniqueOrThrow({
    where: { studentId: "00001" },
    include: { class: true },
  });
  const record = await upgraded.checkIn.findFirstOrThrow();
  if (
    user.role !== "STUDENT" ||
    user.class.name !== "旧班级" ||
    user.passwordHash !== null ||
    record.status !== "APPROVED" ||
    !record.submittedAt ||
    (await upgraded.taskMember.count()) !== 1
  )
    throw new Error("Upgrade did not preserve legacy data");
  console.log(
    "Legacy MySQL upgrade passed: roles, classes, approved record, timestamp and roster retained.",
  );
} finally {
  await upgraded?.$disconnect();
  await base.$disconnect();
}
