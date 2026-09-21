import { describe, expect, it } from "vitest";
import { parseCheckInMetadata } from "./mail-agent.js";

describe("parseCheckInMetadata", () => {
  it("accepts a valid check-in JSON body", () => {
    const metadata = parseCheckInMetadata(
      JSON.stringify({
        taskId: "ckz1234567890123456789012",
        userId: "ckz1234567890123456789013",
        lat: 30.2741,
        lng: 120.1551,
        address: "浙江省杭州市"
      })
    );
    expect(metadata.lat).toBe(30.2741);
  });

  it("rejects malformed mail content", () => {
    expect(() => parseCheckInMetadata("not-json")).toThrow("邮件正文不是有效的打卡 JSON");
  });
});
