import "dotenv/config";
import cron from "node-cron";
import { writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { drainOutbox } from "./services/check-in-mailer.js";
import { runMailAgent, mailAgentStatus } from "./services/mail-agent.js";
import { prisma } from "./lib/prisma.js";
import { syncTaskStatuses } from "./services/task-lifecycle.js";
let running = false;
let writingHeartbeat = false;
async function heartbeat() {
  if (writingHeartbeat) return;
  writingHeartbeat = true;
  try {
    const file = process.env.AGENT_STATUS_FILE ?? "./uploads/agent-status.json";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({ ...mailAgentStatus, running, heartbeatAt: new Date() }),
    );
    await rename(`${file}.tmp`, file);
  } finally {
    writingHeartbeat = false;
  }
}
const heartbeatTimer = setInterval(() => {
  void heartbeat().catch(() => console.error("无法写入邮件服务心跳"));
}, 30000);
async function tick() {
  if (running) return;
  running = true;
  try {
    await syncTaskStatuses();
    if (process.env.LOCAL_EMAIL_MODE !== "true") await drainOutbox();
    await runMailAgent();
  } catch {
    mailAgentStatus.lastError = "邮件服务本轮失败，请检查数据库和存储";
    console.error("邮件工作进程本轮失败，将在下轮重试");
  } finally {
    running = false;
    await heartbeat().catch(() => console.error("无法写入邮件服务心跳"));
  }
}
const timer = cron.schedule("* * * * *", () => void tick());
void tick();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    clearInterval(heartbeatTimer);
    await timer.stop();
    await prisma.$disconnect();
    process.exit(0);
  });
