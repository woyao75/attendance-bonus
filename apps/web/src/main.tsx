import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AlertCircle, Camera, Check, Clock3, LocateFixed, MapPin, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { useCamera } from "./hooks/use-camera";
import { useGeolocation } from "./hooks/use-geolocation";
import { useWatermarkPreview } from "./hooks/use-watermark-preview";
import { distanceMeters } from "./lib/geo";
import { captureWatermarkedPhoto } from "./lib/watermark";
import { useCheckInStore } from "./store/check-in-store";
import type { CheckIn, CheckInStatus, Task } from "./types";
import { CounselorDashboard } from "./dashboard";
import { registerServiceWorker } from "./register-service-worker";
import "./styles.css";

const statusText: Record<CheckInStatus, string> = {
  NOT_CHECKED: "待提交",
  EMAIL_SENT: "邮件已发送",
  REVIEWING: "审核中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  EMAIL_ERROR: "发送异常"
};

function formatRemaining(endTime: string, now: number): string {
  const remaining = new Date(endTime).getTime() - now;
  if (remaining <= 0) return "任务已结束";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const taskId = params.get("taskId") ?? "";
  const userId = params.get("userId") ?? "";
  const studentId = params.get("studentId") ?? "学号未加载";
  const studentName = params.get("name") ?? "学生";
  const { task, checkIn, location, setTask, setCheckIn, setLocation } = useCheckInStore();
  const { videoRef, ready: cameraReady, error: cameraError, start: restartCamera, setReady } = useCamera();
  const { location: currentLocation, error: locationError } = useGeolocation();
  const watermarkRef = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  const [loadError, setLoadError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setLocation(currentLocation);
  }, [currentLocation, setLocation]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!taskId || !userId) {
      setLoadError("缺少 taskId 或 userId，无法初始化打卡任务");
      return;
    }
    const controller = new AbortController();
    async function load() {
      try {
        const [taskResponse, checkInResponse] = await Promise.all([
          fetch(`/api/tasks/${taskId}`, { signal: controller.signal }),
          fetch(`/api/check-ins?taskId=${encodeURIComponent(taskId)}&userId=${encodeURIComponent(userId)}`, {
            signal: controller.signal
          })
        ]);
        if (!taskResponse.ok) throw new Error("无法加载打卡任务");
        if (!checkInResponse.ok) throw new Error("无法读取打卡状态");
        setTask((await taskResponse.json()) as Task);
        const result = (await checkInResponse.json()) as { checkIn: CheckIn | null };
        setCheckIn(result.checkIn ?? undefined);
      } catch (error) {
        if ((error as Error).name !== "AbortError") setLoadError((error as Error).message);
      }
    }
    void load();
    return () => controller.abort();
  }, [setCheckIn, setTask, taskId, userId]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  useWatermarkPreview(videoRef.current, watermarkRef.current, {
    studentId,
    name: studentName,
    location
  });

  const distance = task && location ? Math.round(distanceMeters(location.lat, location.lng, task.centerLat, task.centerLng)) : undefined;
  const status = checkIn?.status;
  const needsCapture = !status || status === "NOT_CHECKED";

  async function takePhoto() {
    if (!videoRef.current) return;
    try {
      setSubmitError(undefined);
      const blob = await captureWatermarkedPhoto(videoRef.current, { studentId, name: studentName, location });
      const url = URL.createObjectURL(blob);
      setPreview({ blob, url });
    } catch (error) {
      setSubmitError((error as Error).message);
    }
  }

  async function submit() {
    if (!preview || !location || !taskId || !userId) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const form = new FormData();
      form.append("taskId", taskId);
      form.append("userId", userId);
      form.append("lat", String(location.lat));
      form.append("lng", String(location.lng));
      if (location.address) form.append("address", location.address);
      form.append("photo", preview.blob, "check-in.jpg");
      const response = await fetch("/api/check-ins", { method: "POST", body: form });
      const body = (await response.json()) as { checkIn?: CheckIn; message?: string };
      if (body.checkIn) setCheckIn(body.checkIn);
      if (!response.ok) throw new Error(body.message ?? "提交失败");
      setPreview(undefined);
    } catch (error) {
      setSubmitError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function retake() {
    setCheckIn(undefined);
    setPreview(undefined);
    void restartCamera();
  }

  if (!taskId || !userId) {
    return <StudentSetupScreen />;
  }
  if (loadError) {
    return <ErrorScreen message={loadError} />;
  }
  if (!task) {
    return <main className="grid min-h-dvh place-items-center bg-slate-950 text-sm text-slate-300">正在加载打卡任务...</main>;
  }

  if (!needsCapture) {
    return <StatusScreen checkIn={checkIn!} task={task} onRetake={retake} />;
  }

  return (
    <main className="min-h-dvh bg-slate-950 text-white">
      <header className="safe-top px-5 pb-4 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="mb-1 text-xs text-teal-300">返校手势打卡</p>
            <h1 className="truncate text-lg font-semibold">{task.title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-slate-300">
            <Clock3 size={14} /> {formatRemaining(task.endTime, now)}
          </div>
        </div>
        <div className="mt-4 flex gap-2 text-xs">
          <StatusPill active={Boolean(location)} icon={<LocateFixed size={13} />} text={location ? "定位成功" : "定位中"} />
          <StatusPill active={cameraReady} icon={<Camera size={13} />} text={cameraReady ? "相机就绪" : "相机启动中"} />
        </div>
      </header>

      <section className="relative mx-3 h-[60dvh] min-h-[360px] overflow-hidden border border-slate-700 bg-slate-900">
        {preview ? (
          <img className="h-full w-full object-cover" src={preview.url} alt="已拍摄的带水印打卡照片" />
        ) : (
          <>
            <video
              ref={videoRef}
              className="h-full w-full object-cover"
              autoPlay
              muted
              playsInline
              onLoadedMetadata={() => setReady(true)}
            />
            <canvas ref={watermarkRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
          </>
        )}
        <div className="pointer-events-none absolute inset-4 border border-white/50" />
      </section>

      <section className="safe-bottom px-5 pb-5 pt-4">
        {(cameraError || locationError || submitError) && (
          <p className="mb-3 flex items-center gap-2 text-sm text-rose-300">
            <AlertCircle size={16} /> {submitError ?? cameraError ?? locationError}
          </p>
        )}
        <div className="flex min-h-16 items-center justify-center">
          {preview ? (
            <div className="flex w-full gap-3">
              <button className="icon-button" type="button" aria-label="重新拍摄" title="重新拍摄" onClick={() => setPreview(undefined)}>
                <RotateCcw size={22} />
              </button>
              <button className="command-button flex-1" type="button" onClick={() => void submit()} disabled={submitting || !location}>
                <Send size={19} /> {submitting ? "提交中..." : "确认并提交"}
              </button>
            </div>
          ) : (
            <button
              className="capture-button"
              type="button"
              aria-label="拍摄打卡照片"
              title="拍摄打卡照片"
              onClick={() => void takePhoto()}
              disabled={!cameraReady || !location}
            >
              <Camera size={31} />
            </button>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-3 text-xs text-slate-300">
          <span className="flex items-center gap-1.5"><MapPin size={14} />{location ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}` : "正在获取坐标"}</span>
          <span className={distance !== undefined && distance <= task.radius ? "text-teal-300" : "text-amber-300"}>
            {distance === undefined ? "计算距离中" : `距离打卡点 ${distance}m`}
          </span>
        </div>
      </section>
    </main>
  );
}

function Root() {
  return window.location.pathname.startsWith("/dashboard") ? <CounselorDashboard /> : <App />;
}

function StatusPill({ active, icon, text }: { active: boolean; icon: ReactNode; text: string }) {
  return <span className={`inline-flex items-center gap-1.5 ${active ? "text-teal-300" : "text-slate-400"}`}>{icon}{text}</span>;
}

function StatusScreen({ checkIn, task, onRetake }: { checkIn: CheckIn; task: Task; onRetake: () => void }) {
  const rejected = checkIn.status === "REJECTED";
  const failed = checkIn.status === "EMAIL_ERROR";
  return (
    <main className="safe-bottom safe-top grid min-h-dvh content-center bg-slate-950 px-6 text-white">
      <section className="border border-slate-700 bg-slate-900 p-6">
        <div className={`mb-5 inline-flex h-11 w-11 items-center justify-center ${rejected || failed ? "bg-rose-500/15 text-rose-300" : "bg-teal-500/15 text-teal-300"}`}>
          {rejected || failed ? <AlertCircle size={24} /> : <ShieldCheck size={24} />}
        </div>
        <p className="text-sm text-slate-400">{task.title}</p>
        <h1 className="mt-1 text-2xl font-semibold">{statusText[checkIn.status]}</h1>
        <p className="mt-4 text-sm leading-6 text-slate-300">
          {rejected ? checkIn.rejectReason || "审核未通过，请按要求重新拍摄。" : failed ? "邮件发送失败，请重新提交。" : "打卡资料已进入系统，请等待审核结果。"}
        </p>
        {(rejected || failed) && (
          <button className="command-button mt-6 w-full" type="button" onClick={onRetake}><RotateCcw size={18} />重新打卡</button>
        )}
      </section>
    </main>
  );
}

function StudentSetupScreen() {
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem("attendance-student-profile") ?? "{}") as {
        taskId?: string;
        userId?: string;
        studentId?: string;
        name?: string;
      };
    } catch {
      return {};
    }
  }, []);
  const [taskId, setTaskId] = useState(saved.taskId ?? "");
  const [userId, setUserId] = useState(saved.userId ?? "");
  const [studentId, setStudentId] = useState(saved.studentId ?? "");
  const [name, setName] = useState(saved.name ?? "");
  const [error, setError] = useState("");

  function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!taskId.trim() || !userId.trim() || !studentId.trim() || !name.trim()) {
      setError("请完整填写任务 ID、用户 ID、学号和姓名");
      return;
    }
    const profile = { taskId: taskId.trim(), userId: userId.trim(), studentId: studentId.trim(), name: name.trim() };
    localStorage.setItem("attendance-student-profile", JSON.stringify(profile));
    const query = new URLSearchParams(profile);
    window.location.assign(`/?${query.toString()}`);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-slate-950 px-5 text-white">
      <form className="w-full max-w-md border border-slate-700 bg-slate-900 p-6" onSubmit={enter}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">Student Check-in</p>
        <h1 className="mt-2 text-xl font-semibold">开始返校打卡</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">首次使用需要填写管理员提供的任务 ID 和学生用户 ID。</p>
        <div className="mt-6 space-y-3">
          <SetupField label="任务 ID" value={taskId} onChange={setTaskId} placeholder="例如：cm..." />
          <SetupField label="学生用户 ID" value={userId} onChange={setUserId} placeholder="例如：cm..." />
          <SetupField label="学号" value={studentId} onChange={setStudentId} placeholder="20240001" />
          <SetupField label="姓名" value={name} onChange={setName} placeholder="张三" />
        </div>
        {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}
        <button className="command-button mt-6 w-full" type="submit">进入打卡页面</button>
      </form>
    </main>
  );
}

function SetupField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="block text-sm"><span className="mb-1.5 block text-slate-300">{label}</span><input className="h-11 w-full border border-slate-600 bg-slate-800 px-3 text-white placeholder:text-slate-500" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-950 p-6 text-white">
      <div className="max-w-sm border border-rose-400/30 bg-slate-900 p-6">
        <AlertCircle className="mb-4 text-rose-300" size={28} />
        <h1 className="text-lg font-semibold">无法开始打卡</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300">{message}</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

void registerServiceWorker();
