import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "retire-development-service-worker",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use("/sw.js", (_req, res) => {
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('attendance-pwa-'))await caches.delete(k);await self.registration.unregister();for(const c of await self.clients.matchAll({type:'window'}))await c.navigate(c.url)})()));",
          );
        });
      },
    },
    {
      name: "attendance-service-worker",
      apply: "build",
      generateBundle(_options, bundle) {
        const files = [
          "/index.html",
          "/manifest.json",
          "/icon-192.png",
          "/icon-512.png",
          ...Object.keys(bundle)
            .filter((name) => name.startsWith("assets/"))
            .map((name) => `/${name}`),
        ];
        const template = readFileSync(
          new URL("./worker/sw.js", import.meta.url),
          "utf8",
        );
        const version = createHash("sha256")
          .update(template + JSON.stringify(files))
          .digest("hex")
          .slice(0, 16);
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: template
            .replace("__VERSION__", version)
            .replace(/["']__PRECACHE__["']/, JSON.stringify(files)),
        });
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
