import { describe, expect, it } from "vitest";
import { parseLocalBody, parseLocalSubject } from "./mail-agent.js";

const taskId = "cm12345678901234567890123";
const token = "0123456789abcdef0123456789abcdef";

describe("local direct email format", () => {
  it("parses the subject and JSON body", () => {
    expect(parseLocalSubject(`[返校打卡] 20240101_张三_${taskId}_${token}`)).toEqual({
      studentId: "20240101",
      name: "张三",
      taskId,
      token,
    });
    expect(
      parseLocalBody(
        JSON.stringify({
          time: "2026-09-23T18:30:00+08:00",
          lat: 30,
          lng: 120,
        }),
        `[返校打卡] 20240101_张三_${taskId}_${token}`,
      ),
    ).toMatchObject({ studentId: "20240101", taskId, lat: 30, lng: 120 });
  });

  it("rejects a body that changes the subject identity", () => {
    expect(() =>
      parseLocalBody(
        JSON.stringify({ studentId: "20240102" }),
        `[返校打卡] 20240101_张三_${taskId}_${token}`,
      ),
    ).toThrow("Body identity does not match the subject");
  });

  it("requires a per-student 32-character mail token", () => {
    expect(() =>
      parseLocalSubject(`[返校打卡] 20240101_张三_${taskId}`),
    ).toThrow("mailToken");
  });
});
