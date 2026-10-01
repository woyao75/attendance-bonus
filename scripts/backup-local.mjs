import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const api = path.join(root, "apps", "api");
const backupRoot = path.join(root, "backups");
const files = ["database.sql", "photos.tar.gz"];

function run(program, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(0, 1000); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${program} failed (${code}): ${errorText.trim()}`)));
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function verify(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  for (const name of files) {
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256?.[name]) ||
        (await stat(path.join(directory, name))).size === 0 ||
        await sha256(path.join(directory, name)) !== manifest.sha256[name])
      throw new Error(`${name} checksum mismatch`);
  }
  console.log(`Backup checksum verified: ${directory}`);
}

const [mode, argument] = process.argv.slice(2);
if (mode === "--verify") {
  if (!argument) throw new Error("Usage: npm run backup:verify -- <backup-directory>");
  await verify(path.resolve(argument));
} else {
  if (!existsSync(path.join(api, ".env"))) throw new Error("apps/api/.env is missing");
  const requireFromApi = createRequire(path.join(api, "package.json"));
  const config = { ...requireFromApi("dotenv").parse(readFileSync(path.join(api, ".env"))), ...process.env };
  if (config.LOCAL_EMAIL_MODE !== "true") throw new Error("This command is for LOCAL_EMAIL_MODE=true");
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  const databaseUrl = new URL(config.DATABASE_URL);
  if (databaseUrl.protocol !== "mysql:" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname))
    throw new Error("Local backup requires a MySQL database on this computer");
  const database = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!database || !databaseUrl.username) throw new Error("DATABASE_URL must include a database and user");
  const uploadDir = path.resolve(api, config.UPLOAD_DIR ?? "./uploads");
  if ([path.parse(uploadDir).root, root, api].includes(uploadDir))
    throw new Error("UPLOAD_DIR is too broad to archive safely");
  if (!(await stat(uploadDir)).isDirectory()) throw new Error("UPLOAD_DIR is not a directory");
  const dump = config.MYSQLDUMP_PATH || "mysqldump";
  await run(dump, ["--version"]);
  await run("tar", ["--version"]);
  if (mode === "--check") {
    console.log("Local backup prerequisites are available. Stop the API and Agent before backing up.");
  } else if (mode === "--stopped") {
    const port = Number(config.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
    if (await portIsOpen(port)) throw new Error("API port is active; stop local:start before backing up");
    const heartbeat = path.resolve(api, config.AGENT_STATUS_FILE ?? "./uploads/agent-status.json");
    const heartbeatStat = await stat(heartbeat).catch(() => null);
    if (heartbeatStat && Date.now() - heartbeatStat.mtimeMs < 90_000)
      throw new Error("Agent heartbeat is recent; stop it and wait 90 seconds before backing up");
    await mkdir(backupRoot, { recursive: true });
    const destination = path.join(backupRoot, `local-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    await mkdir(destination);
    try {
      await run(dump, [
        `--host=${databaseUrl.hostname}`,
        `--port=${databaseUrl.port || 3306}`,
        `--user=${decodeURIComponent(databaseUrl.username)}`,
        "--single-transaction", "--quick", "--no-tablespaces",
        "--set-gtid-purged=OFF", "--default-character-set=utf8mb4",
        `--result-file=${path.join(destination, "database.sql")}`,
        database,
      ], { ...process.env, MYSQL_PWD: decodeURIComponent(databaseUrl.password) });
      await run("tar", ["-czf", path.join(destination, "photos.tar.gz"), "-C", path.dirname(uploadDir), path.basename(uploadDir)]);
      for (const name of files)
        if ((await stat(path.join(destination, name))).size === 0) throw new Error(`${name} is empty`);
      const checksums = Object.fromEntries(await Promise.all(files.map(async (name) => [name, await sha256(path.join(destination, name))])));
      await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), database, uploadDirectory: uploadDir, sha256: checksums }, null, 2));
      await verify(destination);
    } catch (error) {
      console.error(`Backup incomplete; inspect without treating it as a valid backup: ${destination}`);
      throw error;
    }
  } else {
    throw new Error("Usage: npm run backup:local -- --check | --stopped");
  }
}
