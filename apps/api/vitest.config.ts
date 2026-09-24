import { defineConfig } from "vitest/config";
if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.startsWith("/attendance_test")
  )
    throw new Error("Tests only allow a local attendance_test database");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
