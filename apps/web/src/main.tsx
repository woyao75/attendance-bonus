import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { api, type Account } from "./lib/api";
import { StudentHome } from "./student";
import { CounselorDashboard } from "./dashboard";
import { Management } from "./management";
import { registerServiceWorker } from "./register-service-worker";
import "./styles.css";
function App() {
  const [user, setUser] = useState<Account>();
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("tasks");
  const [change, setChange] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState("");
  useEffect(() => {
    localStorage.removeItem("attendance-student-profile");
    api<{ user: Account }>("/api/auth/me")
      .then((v) => setUser(v.user))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  async function logout() {
    try {
      await api("/api/auth/logout", {});
      setUser(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (loading) return <main className="portal">正在检查登录状态…</main>;
  return (
    <>
      {!online && (
        <div role="status" className="offline-banner">
          当前离线，请联网后登录或提交打卡。审核状态可能尚未更新。
        </div>
      )}
      {!user ? (
        <Login
          onLogin={(u) => {
            setUser(u);
            setChange(false);
          }}
        />
      ) : (
        <>
          <header className="account-bar">
            <span>
              {user.name} · {user.studentId}
            </span>
            <nav>
              {user.role !== "STUDENT" && (
                <>
                  <button onClick={() => setSection("tasks")}>任务审核</button>
                  <button onClick={() => setSection("manage")}>
                    人员与任务管理
                  </button>
                </>
              )}
              <button onClick={() => setChange(true)}>修改密码</button>
              <button onClick={() => void logout()}>退出登录</button>
            </nav>
          </header>
          {error && <p role="alert">{error}</p>}
          {user.mustChangePassword || change ? (
            <PasswordChange
              onDone={() => {
                setUser(undefined);
                setChange(false);
              }}
            />
          ) : user.role === "STUDENT" ? (
            <StudentHome user={user} />
          ) : section === "manage" ? (
            <Management user={user} />
          ) : (
            <CounselorDashboard key={user.id} user={user} />
          )}
        </>
      )}
    </>
  );
}
function Login({ onLogin }: { onLogin: (u: Account) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      const result = await api<{ user: Account }>("/api/auth/login", {
        account: data.get("account"),
        password: data.get("password"),
      });
      onLogin(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="portal login-panel">
      <h1>返校打卡</h1>
      <p>使用管理员分配的账号登录。学生账号通常为学号。</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          账号
          <input
            name="account"
            required
            maxLength={64}
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
          />
        </label>
        <p role="alert">{error}</p>
        <button className="command-button" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
function PasswordChange({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (form.get("password") !== form.get("confirm"))
        throw new Error("两次新密码不一致");
      await api("/api/auth/change-password", {
        oldPassword: form.get("oldPassword"),
        password: form.get("password"),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="portal login-panel">
      <h1>设置个人密码</h1>
      <p>首次登录必须修改初始密码。修改成功后请重新登录。</p>
      <form onSubmit={(e) => void submit(e)}>
        <label>
          原密码
          <input
            name="oldPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          新密码（至少 12 位）
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <label>
          确认新密码
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
          />
        </label>
        <p role="alert">{error}</p>
        <button className="command-button" disabled={busy}>
          保存密码并退出
        </button>
      </form>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void registerServiceWorker();
