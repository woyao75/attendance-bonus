import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
const root = path.resolve("apps/web/dist");
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/") || pathname.startsWith("/uploads/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "test private response" }));
      return;
    }
    const file =
      pathname === "/" || pathname === "/dashboard" ? "/index.html" : pathname;
    const target = path.resolve(root, "." + file);
    if (!target.startsWith(root + path.sep)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/manifest+json",
      ".png": "image/png",
    };
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] ?? "application/octet-stream",
    );
    res.end(await readFile(target));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
server.listen(5192, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
let browser;
try {
  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" && existsSync(edge)
      ? { executablePath: edge }
      : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5192/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.evaluate(async () => {
    await fetch("/api/private-test");
    await fetch("/uploads/private.jpg");
    await fetch("/api/check-ins", { method: "POST", body: "test" });
  });
  const cached = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        paths.push(new URL(request.url).pathname);
    return paths;
  });
  expect(
    cached.some((p) => p.startsWith("/assets/") && p.endsWith(".js")),
  ).toBe(true);
  expect(
    cached.some((p) => p.startsWith("/api/") || p.startsWith("/uploads/")),
  ).toBe(false);
  await context.setOffline(true);
  await page.goto("http://127.0.0.1:5192/dashboard");
  await expect(page.getByRole("status")).toContainText("当前离线");
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  console.log(
    "PWA passed: production registration, precache, offline navigation, no API/photo/POST caching.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
