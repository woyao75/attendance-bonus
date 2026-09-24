import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { hashPassword, passwordSchema } from "../lib/password.js";
import { fail, route } from "../lib/http.js";
import { manageableClasses, publicUser, roles } from "../middleware/auth.js";
export const managementRouter = Router();
managementRouter.use(roles("ADMIN", "COUNSELOR"));
managementRouter.get(
  "/classes",
  route(async (req, res) => {
    const classes = await prisma.class.findMany({
      where:
        req.auth.role === "ADMIN"
          ? {}
          : { counselors: { some: { userId: req.auth.id } } },
      include: {
        counselors: { select: { userId: true } },
        _count: { select: { students: true } },
      },
      orderBy: { name: "asc" },
    });
    res.json({ classes });
  }),
);
managementRouter.post(
  "/classes",
  roles("ADMIN"),
  route(async (req, res) => {
    const input = z
      .object({ name: z.string().trim().min(1).max(100) })
      .parse(req.body);
    res.status(201).json(await prisma.class.create({ data: input }));
  }),
);
managementRouter.patch(
  "/classes/:id",
  roles("ADMIN"),
  route(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        active: z.boolean().optional(),
        counselorIds: z.array(z.string().cuid()).max(20).optional(),
      })
      .parse(req.body);
    const { counselorIds, ...data } = input;
    await prisma.$transaction(async (tx) => {
      if (counselorIds) {
        const ids = [...new Set(counselorIds)];
        if (
          (await tx.user.count({
            where: { id: { in: ids }, role: "COUNSELOR", active: true },
          })) !== ids.length
        )
          throw fail(400, "请选择有效的辅导员");
        await tx.counselorClass.deleteMany({
          where: { classId: req.params.id },
        });
        await tx.counselorClass.createMany({
          data: ids.map((userId) => ({ userId, classId: req.params.id })),
        });
      }
      await tx.class.update({ where: { id: req.params.id }, data });
      await tx.auditLog.create({
        data: {
          actorId: req.auth.id,
          action: "CLASS_UPDATED",
          targetId: req.params.id,
        },
      });
    });
    res.json({ ok: true });
  }),
);
managementRouter.get(
  "/users",
  route(async (req, res) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        search: z.string().max(64).default(""),
      })
      .parse(req.query);
    const where = {
      ...(req.auth.role === "ADMIN"
        ? {}
        : {
            role: "STUDENT" as const,
            class: { counselors: { some: { userId: req.auth.id } } },
          }),
      OR: [
        { name: { contains: query.search } },
        { studentId: { contains: query.search } },
        { email: { contains: query.search } },
      ],
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { ...publicUser, class: { select: { name: true } } },
        orderBy: { studentId: "asc" },
        take: 100,
        skip: (query.page - 1) * 100,
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ users, total });
  }),
);
const newUser = z.object({
  studentId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/, "账号只能包含字母、数字和连字符"),
  name: z.string().trim().min(1).max(100),
  email: z
    .string()
    .trim()
    .email("邮箱格式不正确")
    .max(320)
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
  password: passwordSchema,
  role: z.enum(["STUDENT", "COUNSELOR", "ADMIN"]).default("STUDENT"),
  classId: z.string().max(100).nullable().optional(),
});
function requireTrustedStudentEmail(input: z.infer<typeof newUser>) {
  if (
    process.env.LOCAL_EMAIL_MODE === "true" &&
    input.role === "STUDENT" &&
    !input.email
  )
    throw fail(400, "本地邮箱模式下，学生必须登记可信学校邮箱");
}
managementRouter.post(
  "/users",
  roles("ADMIN"),
  route(async (req, res) => {
    const input = newUser.parse(req.body);
    if (input.role === "STUDENT" && !input.classId)
      throw fail(400, "学生必须选择班级");
    requireTrustedStudentEmail(input);
    if (input.classId) await manageableClasses(req.auth, [input.classId]);
    const { password, ...data } = input;
    const user = await prisma.user.create({
      data: { ...data, passwordHash: await hashPassword(password) },
      select: publicUser,
    });
    res.status(201).json({ user });
  }),
);
managementRouter.post(
  "/users/import",
  roles("ADMIN"),
  route(async (req, res) => {
    const inputs = z
      .array(
        newUser.extend({
          role: z.literal("STUDENT").default("STUDENT"),
          classId: z.string().min(1).max(100),
        }),
      )
      .min(1)
      .max(100)
      .parse(req.body.rows);
    if (
      new Set(inputs.map((u) => u.studentId.toLowerCase())).size !==
      inputs.length
    )
      throw fail(400, "导入文件包含重复学号");
    if (
      process.env.LOCAL_EMAIL_MODE === "true" &&
      new Set(
        inputs
          .map((u) => u.email?.toLowerCase())
          .filter((email): email is string => Boolean(email)),
      ).size !== inputs.length
    )
      throw fail(400, "导入文件包含重复或缺失邮箱");
    inputs.forEach(requireTrustedStudentEmail);
    await manageableClasses(req.auth, [
      ...new Set(inputs.map((u) => u.classId)),
    ]);
    const data: Prisma.UserCreateManyInput[] = [];
    for (const { password, ...user } of inputs)
      data.push({ ...user, passwordHash: await hashPassword(password) });
    await prisma.$transaction(async (tx) => {
      await tx.user.createMany({ data });
      await tx.auditLog.create({
        data: {
          actorId: req.auth.id,
          action: "STUDENTS_IMPORTED",
          targetId: String(data.length),
        },
      });
    });
    res.status(201).json({ count: data.length });
  }),
);
managementRouter.patch(
  "/users/:id",
  roles("ADMIN"),
  route(async (req, res) => {
    if (req.params.id === req.auth.id)
      throw fail(400, "不能在此修改当前管理员账号");
    const input = z
      .object({
        active: z.boolean().optional(),
        classId: z.string().min(1).max(100).optional(),
        email: z
          .string()
          .trim()
          .email("邮箱格式不正确")
          .max(320)
          .transform((value) => value.toLowerCase())
          .nullable()
          .optional(),
        password: passwordSchema.optional(),
      })
      .parse(req.body);
    if (input.classId) await manageableClasses(req.auth, [input.classId]);
    const target = await prisma.user.findUniqueOrThrow({
      where: { id: req.params.id },
      select: { role: true, email: true },
    });
    if (
      process.env.LOCAL_EMAIL_MODE === "true" &&
      target.role === "STUDENT" &&
      input.email === null
    )
      throw fail(400, "本地邮箱模式下不能清空学生可信邮箱");
    const { password, ...data } = input;
    const passwordHash = password ? await hashPassword(password) : undefined;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: req.params.id },
        data: {
          ...data,
          ...(passwordHash
            ? {
                passwordHash,
                mustChangePassword: true,
                loginFailures: 0,
                lockedUntil: null,
              }
            : {}),
        },
      });
      await tx.session.deleteMany({ where: { userId: req.params.id } });
      await tx.auditLog.create({
        data: {
          actorId: req.auth.id,
          action: password ? "PASSWORD_RESET" : "USER_UPDATED",
          targetId: req.params.id,
        },
      });
    });
    res.json({ ok: true });
  }),
);
