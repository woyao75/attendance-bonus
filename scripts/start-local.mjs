import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const api = path.join(root, "apps", "api");
const envFile = path.join(api, ".env");
const requireFromApi = createRequire(path.join(api, "package.json"));

if (!existsSync(envFile)) throw new Error("缺少 apps/api/.env，请先按部署手册配置数据库和邮箱");
const { parse } = requireFromApi("dotenv");
const config = { ...parse(readFileSync(envFile)), ...process.env };
if (config.LOCAL_EMAIL_MODE !== "true")
  throw new Error("此命令只适用于本地直收模式：请在 apps/api/.env 设置 LOCAL_EMAIL_MODE=true");
for (const key of ["DATABASE_URL", "IMAP_HOST", "IMAP_USER", "IMAP_PASS"])
  if (!config[key]) throw new Error(`缺少 ${key}，请在 apps/api/.env 中配置`);
for (const file of [path.join(api, "dist", "server.js"), path.join(api, "dist", "worker.js"), path.join(root, "apps", "web", "dist", "index.html")])
  if (!existsSync(file)) throw new Error("缺少构建产物，请先运行 npm.cmd run build");

const port = Number(config.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT 必须是 1 到 65535 之间的整数");

const childEnv = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1" };
const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());

function launch(name, file) {
  const child = spawn(process.execPath, [file], { cwd: api, env: childEnv, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${name} 启动失败：${error.message}`);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${name} 已退出（代码 ${code ?? "未知"}），正在停止其他进程`);
      stop(code || 1);
    }
  });
  return child;
}

launch("API", path.join(api, "dist", "server.js"));
const url = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 20_000;
let ready = false;
while (!stopping && Date.now() < deadline) {
  try {
    const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) { ready = true; break; }
  } catch { /* Wait for the API and database to become ready. */ }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) {
  if (!stopping) console.error("API 未在 20 秒内就绪，请检查端口、数据库与上方错误");
  stop(1);
} else {
  launch("邮件 Agent", path.join(api, "dist", "worker.js"));
  console.log(`本地系统已启动：${url}（关闭此窗口将停止 API 和邮件 Agent）`);
}
