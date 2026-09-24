import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";
import {
  createMailBody,
  parseSignedMail,
} from "../services/check-in-mailer.js";
describe("credentials and mail integrity", () => {
  beforeAll(() => {
    process.env.MAIL_SIGNING_SECRET = "test-only-secret".repeat(4);
  });
  it("salts passwords and rejects wrong credentials", async () => {
    const first = await hashPassword("my-unique-password");
    const second = await hashPassword("my-unique-password");
    expect(first).not.toBe(second);
    expect(await verifyPassword("my-unique-password", first)).toBe(true);
    expect(await verifyPassword("incorrect", first)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
  });
  it("rejects unsigned or tampered mail", () => {
    const data = {
      taskId: "ckz1234567890123456789012",
      userId: "ckz1234567890123456789013",
      attemptId: "31aa6848-251a-411a-803f-0c6b7e953f20",
      lat: 30,
      lng: 120,
      time: new Date().toISOString(),
      photoHash: "a".repeat(64),
    };
    const signed = createMailBody(data);
    expect(parseSignedMail(signed)).toEqual(data);
    expect(() => parseSignedMail(signed.replace("120", "121"))).toThrow();
    expect(() => parseSignedMail(JSON.stringify(data))).toThrow();
  });
});
