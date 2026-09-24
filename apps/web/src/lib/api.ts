export interface Account {
  id: string;
  studentId: string;
  email: string | null;
  name: string;
  role: "STUDENT" | "COUNSELOR" | "ADMIN";
  mustChangePassword: boolean;
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers:
      body === undefined
        ? {}
        : {
            "X-Attendance-Request": "1",
            ...(body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ message: "服务响应异常" }));
  if (!response.ok) throw new Error(result.message ?? "请求失败");
  return result as T;
}
