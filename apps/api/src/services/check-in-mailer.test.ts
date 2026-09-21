import { describe, expect, it } from "vitest";
import { buildCheckInMail } from "./check-in-mailer.js";

describe("buildCheckInMail", () => {
  it("uses the required machine-readable subject and JSON body", () => {
    expect(() =>
      buildCheckInMail({
        task: { id: "ckz1234567890123456789012", title: "返校", targetEmail: "archive@example.com" },
        user: { id: "ckz1234567890123456789013", studentId: "20240001", name: "张三" },
        checkIn: { id: "ckz1234567890123456789014", photoUrl: null, lat: 30, lng: 120, address: null }
      })
    ).toThrow("打卡信息不完整");
  });
});
