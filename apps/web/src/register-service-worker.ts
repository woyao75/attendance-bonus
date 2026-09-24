export async function registerServiceWorker(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (!("serviceWorker" in navigator)) return undefined;
  if (import.meta.env.DEV) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map((registration) => registration.unregister()),
    );
    await Promise.all(
      (await caches.keys())
        .filter((key) => key.startsWith("attendance-pwa-"))
        .map((key) => caches.delete(key)),
    );
    if (
      navigator.serviceWorker.controller &&
      !sessionStorage.getItem("attendance-sw-reset")
    ) {
      sessionStorage.setItem("attendance-sw-reset", "1");
      location.reload();
    }
    return undefined;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    void registration.update();
    return registration;
  } catch (error) {
    console.warn("PWA Service Worker 注册失败", error);
    return undefined;
  }
}
