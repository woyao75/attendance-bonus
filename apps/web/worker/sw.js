const CACHE = "attendance-pwa-__VERSION__";
const STATIC = "__PRECACHE__";
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("attendance-pwa-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/uploads/")
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE).then((cache) => cache.match("/index.html")),
      ),
    );
  } else if (STATIC.includes(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) => (await cache.match(url.pathname)) || fetch(request),
        ),
    );
  }
});
self.addEventListener("push", (event) => {
  // 推送仅显示通用提示，不在锁屏泄露姓名、定位、审核原因。
  event.waitUntil(
    self.registration.showNotification("返校打卡", {
      body: "有新的状态更新，请登录查看。",
      icon: "/icon-192.png",
      data: { url: "/" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const current = clients.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        if (current) {
          await current.navigate("/");
          return current.focus();
        }
        return self.clients.openWindow("/");
      }),
  );
});
