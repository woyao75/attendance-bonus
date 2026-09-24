import { useEffect, useState, type FormEvent } from "react";
import { api, type Account } from "./lib/api";
type ClassRow = {
  id: string;
  name: string;
  active: boolean;
  counselors: { userId: string }[];
  _count: { students: number };
};
type UserRow = Account & {
  active: boolean;
  classId: string | null;
  class?: { name: string };
};
type LocalTaskMember = {
  studentId: string;
  name: string;
  email: string | null;
  mailToken: string | null;
};
type CreatedTask = { id: string; title: string; members: LocalTaskMember[] };
export function Management({ user }: { user: Account }) {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishedTask, setPublishedTask] = useState<CreatedTask>();
  async function refresh() {
    const [a, b] = await Promise.all([
      api<{ classes: ClassRow[] }>("/api/manage/classes"),
      api<{ users: UserRow[]; total: number }>(
        `/api/manage/users?page=${page}&search=${encodeURIComponent(search)}`,
      ),
    ]);
    setClasses(a.classes);
    setUsers(b.users);
    setTotal(b.total);
  }
  useEffect(() => {
    void refresh().catch((e) => setMessage(e.message));
  }, [page, search]);
  async function action<T>(fn: () => Promise<T>) {
    setBusy(true);
    setMessage("");
    try {
      const result = await fn();
      await refresh();
      setMessage("操作成功");
      return result;
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function formAction(
    e: FormEvent<HTMLFormElement>,
    fn: (data: FormData) => Promise<unknown>,
  ) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void action(async () => {
      await fn(data);
      form.reset();
    });
  }
  const classSelect = (name = "classId") => (
    <select name={name} required>
      <option value="">选择班级</option>
      {classes
        .filter((c) => c.active)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
  return (
    <main className="portal management">
      <h1>人员与任务管理</h1>
      <p role="status">{message}</p>
      <fieldset disabled={busy}>
        {user.role === "ADMIN" && (
          <>
            <section className="panel">
              <h2>创建班级</h2>
              <form
                onSubmit={(e) =>
                  formAction(e, (f) =>
                    api("/api/manage/classes", { name: f.get("name") }),
                  )
                }
              >
                <label>
                  班级名称
                  <input name="name" required maxLength={100} />
                </label>
                <button className="command-button">创建</button>
              </form>
            </section>
            <section className="panel">
              <h2>创建账号</h2>
              <form
                onSubmit={(e) =>
                  formAction(e, (f) =>
                    api("/api/manage/users", {
                      studentId: f.get("studentId"),
                      name: f.get("name"),
                      email: f.get("email") || null,
                      role: f.get("role"),
                      password: f.get("password"),
                      classId: f.get("classId") || null,
                    }),
                  )
                }
              >
                <label>
                  学号 / 登录账号
                  <input
                    name="studentId"
                    required
                    pattern="[A-Za-z0-9-]+"
                    maxLength={64}
                  />
                </label>
                <label>
                  姓名
                  <input name="name" required maxLength={100} />
                </label>
                <label>
                  可信学校邮箱（学生本地直收必填）
                  <input name="email" type="email" maxLength={320} />
                </label>
                <label>
                  角色
                  <select name="role">
                    <option value="STUDENT">学生</option>
                    <option value="COUNSELOR">辅导员</option>
                    <option value="ADMIN">管理员</option>
                  </select>
                </label>
                <label>
                  所属班级（学生必选）
                  <select name="classId">
                    <option value="">无</option>
                    {classes
                      .filter((c) => c.active)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  临时密码
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button className="command-button">创建账号</button>
              </form>
            </section>
            <section className="panel">
              <h2>批量导入学生</h2>
              <p>
                从 Excel 另存为 UTF-8 CSV，每批最多 100
                人。表头：studentId,name,email,password。密码至少 12
                位，首次登录强制修改。
              </p>
              <form
                onSubmit={(e) =>
                  formAction(e, async (f) => {
                    const file = f.get("file") as File;
                    if (file.size > 128000)
                      throw new Error("CSV 文件不能超过 128KB");
                    const rows = parseCsv(await file.text());
                    await api("/api/manage/users/import", {
                      rows: rows.map((r) => ({
                        ...r,
                        classId: f.get("classId"),
                      })),
                    });
                  })
                }
              >
                <label>班级{classSelect()}</label>
                <label>
                  CSV 文件
                  <input
                    type="file"
                    name="file"
                    accept=".csv,text/csv"
                    required
                  />
                </label>
                <button className="command-button">校验并导入</button>
              </form>
            </section>
          </>
        )}
        <section className="panel">
          <h2>班级与辅导员</h2>
          {classes.map((c) => (
            <div className="management-row" key={c.id}>
              <strong>{c.name}</strong>
              <span>
                {c._count.students} 人 · {c.active ? "启用" : "停用"}
              </span>
              {user.role === "ADMIN" && (
                <>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void action(() =>
                        api(
                          `/api/manage/classes/${c.id}`,
                          { active: !c.active },
                          "PATCH",
                        ),
                      )
                    }
                  >
                    {c.active ? "停用" : "启用"}
                  </button>
                  <form
                    onSubmit={(e) =>
                      formAction(e, async (f) => {
                        const result = await api<{ users: UserRow[] }>(
                          `/api/manage/users?search=${encodeURIComponent(String(f.get("account")))}`,
                        );
                        const counselor = result.users.find(
                          (u) =>
                            u.studentId === f.get("account") &&
                            u.role === "COUNSELOR",
                        );
                        if (!counselor) throw new Error("找不到该辅导员账号");
                        await api(
                          `/api/manage/classes/${c.id}`,
                          {
                            counselorIds: [
                              ...new Set([
                                ...c.counselors.map((x) => x.userId),
                                counselor.id,
                              ]),
                            ],
                          },
                          "PATCH",
                        );
                      })
                    }
                  >
                    <label>
                      添加辅导员账号
                      <input name="account" required />
                    </label>
                    <button className="secondary-button">分配</button>
                  </form>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      if (
                        confirm(
                          `移除 ${c.name} 的全部辅导员分配？已有任务仍归原发布人管理。`,
                        )
                      )
                        void action(() =>
                          api(
                            `/api/manage/classes/${c.id}`,
                            { counselorIds: [] },
                            "PATCH",
                          ),
                        );
                    }}
                  >
                    清空分配（{c.counselors.length}）
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
        <section className="panel">
          <h2>发布返校任务</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              void action(() =>
                api<CreatedTask>("/api/tasks", {
                  title: data.get("title"),
                  startTime: new Date(String(data.get("startTime"))).toISOString(),
                  endTime: new Date(String(data.get("endTime"))).toISOString(),
                  centerLat: Number(data.get("lat")),
                  centerLng: Number(data.get("lng")),
                  radius: Number(data.get("radius")),
                  classIds: data.getAll("classIds"),
                  ...(data.get("gesture") ? { gestureImgUrl: data.get("gesture") } : {}),
                }),
              ).then((task) => {
                if (task) setPublishedTask(task);
                form.reset();
              });
            }}
          >
            <label>
              任务名称
              <input name="title" required maxLength={100} />
            </label>
            <label>
              开始时间
              <input name="startTime" type="datetime-local" required />
            </label>
            <label>
              结束时间
              <input name="endTime" type="datetime-local" required />
            </label>
            <label>
              学校中心纬度
              <input
                name="lat"
                type="number"
                step="any"
                min={-90}
                max={90}
                required
              />
            </label>
            <label>
              学校中心经度
              <input
                name="lng"
                type="number"
                step="any"
                min={-180}
                max={180}
                required
              />
            </label>
            <label>
              允许半径（米）
              <input
                name="radius"
                type="number"
                min={50}
                max={20000}
                defaultValue={800}
                required
              />
            </label>
            <label>
              手势图 HTTPS 地址
              <input name="gesture" type="url" />
            </label>
            <div>
              <p>参与班级（发布时固定名单）</p>
              {classes
                .filter((c) => c.active)
                .map((c) => (
                  <label className="checkbox-label" key={c.id}>
                    <input name="classIds" type="checkbox" value={c.id} />
                    {c.name}
                  </label>
                ))}
            </div>
            <button className="command-button">发布任务</button>
          </form>
          {publishedTask && publishedTask.members.some((member) => member.mailToken) && (
            <div className="mt-5 border border-amber-300 bg-amber-50 p-4 text-sm">
              <p className="font-semibold">本地直收邮件凭据：{publishedTask.title}</p>
              <p className="mt-1 break-all">任务 ID：{publishedTask.id}</p>
              <p className="mt-2 text-amber-800">
                请将每一行仅私发给对应学生。专属验证码等同于该任务的打卡凭据，不可群发。
              </p>
              <div className="mt-3 space-y-3">
                {publishedTask.members.map((member) => (
                  <div className="border border-amber-200 bg-white p-3" key={member.studentId}>
                    <p>{member.name} · {member.studentId} · {member.email ?? "未登记邮箱"}</p>
                    <p className="mt-1 break-all font-mono text-xs">
                      [返校打卡] {member.studentId}_{member.name}_{publishedTask.id}_{member.mailToken ?? "无验证码"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <h2>账号列表</h2>
          <label>
            按姓名或账号搜索
            <input
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
            />
          </label>
          {users.map((u) => (
            <div className="management-row" key={u.id}>
              <strong>
                {u.name} · {u.studentId}
              </strong>
              <span>
                {u.role} · {u.class?.name ?? "无班级"} ·{" "}
                {u.active ? "启用" : "停用"} · {u.email ?? "未登记邮箱"}
              </span>
              {user.role === "ADMIN" && u.id !== user.id && (
                <>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void action(() =>
                        api(
                          `/api/manage/users/${u.id}`,
                          { active: !u.active },
                          "PATCH",
                        ),
                      )
                    }
                  >
                    {u.active ? "停用账号" : "启用账号"}
                  </button>
                  <form
                    onSubmit={(e) =>
                      formAction(e, (f) =>
                        api(
                          `/api/manage/users/${u.id}`,
                          { password: f.get("password") },
                          "PATCH",
                        ),
                      )
                    }
                  >
                    <label>
                      新临时密码
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                    <button className="secondary-button">重置密码</button>
                  </form>
                  {u.role === "STUDENT" && (
                    <form
                      onSubmit={(e) =>
                        formAction(e, (f) =>
                          api(
                            `/api/manage/users/${u.id}`,
                            { classId: f.get("classId") },
                            "PATCH",
                          ),
                        )
                      }
                    >
                      {classSelect()}
                      <button className="secondary-button">调班</button>
                    </form>
                  )}
                  {u.role === "STUDENT" && (
                    <form
                      onSubmit={(e) =>
                        formAction(e, (f) =>
                          api(
                            `/api/manage/users/${u.id}`,
                            { email: f.get("email") || null },
                            "PATCH",
                          ),
                        )
                      }
                    >
                      <label>
                        可信学校邮箱
                        <input name="email" type="email" defaultValue={u.email ?? ""} required />
                      </label>
                      <button className="secondary-button">更新邮箱</button>
                    </form>
                  )}
                </>
              )}
            </div>
          ))}
          <div className="capture-actions">
            <button
              className="secondary-button"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <span>
              第 {page} 页 · 共 {total} 人
            </span>
            <button
              className="secondary-button"
              disabled={page * 100 >= total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </section>
      </fieldset>
    </main>
  );
}
export function parseCsv(
  text: string,
): { studentId: string; name: string; email: string; password: string }[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      row.push(field);
      field = "";
      if (char === "\n") {
        records.push(row);
        row = [];
      }
    } else if (char !== "\r") field += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合");
  row.push(field);
  if (row.some(Boolean)) records.push(row);
  const header = records.shift()?.map((s) => s.replace(/^\uFEFF/, "").trim());
  if (header?.join(",") !== "studentId,name,email,password")
    throw new Error("CSV 表头必须为 studentId,name,email,password");
  return records
    .filter((r) => r.some(Boolean))
    .map((r) => {
      if (r.length !== 4) throw new Error("CSV 每行应为四列");
      return {
        studentId: r[0].trim(),
        name: r[1].trim(),
        email: r[2].trim(),
        password: r[3],
      };
    });
}
