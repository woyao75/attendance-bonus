import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

export const passwordSchema = z.string().min(12, "密码至少 12 位").max(128);
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string | null) {
  const [scheme, salt, encoded] = (hash ?? "").split("$");
  const valid =
    scheme === "scrypt" &&
    /^[a-f0-9]{32}$/.test(salt ?? "") &&
    /^[a-f0-9]{128}$/.test(encoded ?? "");
  const actual = await derive(password, valid ? salt : "0".repeat(32));
  return valid && timingSafeEqual(actual, Buffer.from(encoded, "hex"));
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
