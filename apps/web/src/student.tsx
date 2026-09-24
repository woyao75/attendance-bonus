import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, CheckIn, LocationData } from "./types";
import { api, type Account } from "./lib/api";
import { useCamera } from "./hooks/use-camera";
import { useGeolocation } from "./hooks/use-geolocation";
import { useWatermarkPreview } from "./hooks/use-watermark-preview";
import { captureWatermarkedPhoto } from "./lib/watermark";
import { distanceMeters } from "./lib/geo";
import { useCheckInStore } from "./store/check-in-store";
const labels = {
  NOT_CHECKED: "未打卡",
  EMAIL_PENDING: "已保存，邮件排队发送中",
  EMAIL_SENT: "邮件已发送，等待接收",
  REVIEWING: "审核中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  EMAIL_ERROR: "邮件发送或解析异常",
};
export function StudentHome({ user }: { user: Account }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ tasks: Task[] }>("/api/tasks")
      .then((v) => setTasks(v.tasks))
      .catch((e) => setError(e.message));
  }, []);
  if (selected)
    return (
      <StudentTask
        key={selected.id}
        user={user}
        task={selected}
        onBack={() => setSelected(undefined)}
      />
    );
  return (
    <main className="portal">
      <h1>我的返校任务</h1>
      <p>选择任务后查看手势要求并完成拍照。</p>
      <p role="alert">{error}</p>
      {tasks.length === 0 && !error && <p>暂时没有分配给你的任务。</p>}
      {tasks.map((t) => (
        <button
          className="task-option"
          key={t.id}
          onClick={() => setSelected(t)}
        >
          <strong>{t.title}</strong>
          <span>
            {new Date(t.startTime).toLocaleString()} —{" "}
            {new Date(t.endTime).toLocaleString()}
          </span>
        </button>
      ))}
    </main>
  );
}
function StudentTask({
  user,
  task,
  onBack,
}: {
  user: Account;
  task: Task;
  onBack: () => void;
}) {
  const { checkIn, setCheckIn } = useCheckInStore();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setCheckIn(undefined);
    async function refresh() {
      try {
        const result = await api<{ checkIn: CheckIn | null }>(
          `/api/check-ins?taskId=${task.id}`,
        );
        if (!cancelled) {
          setCheckIn(result.checkIn ?? undefined);
          setLoading(false);
          setError("");
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.id, setCheckIn]);
  const inTime =
    task.status !== "ARCHIVED" &&
    task.status !== "COMPLETED" &&
    Date.now() >= new Date(task.startTime).getTime() &&
    Date.now() <= new Date(task.endTime).getTime();
  return (
    <main className="student-shell">
      <button className="secondary-button" onClick={onBack}>
        返回任务列表
      </button>
      <h1>{task.title}</h1>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p>正在读取状态…</p>
      ) : (
        !error && (
          <>
            {checkIn && !retry && (
              <section className="panel">
                <h2>{labels[checkIn.status]}</h2>
                <p>{checkIn.rejectReason}</p>
                {["REJECTED", "EMAIL_ERROR"].includes(checkIn.status) &&
                  inTime && (
                    <button
                      className="command-button"
                      onClick={() => setRetry(true)}
                    >
                      重新打卡
                    </button>
                  )}
                {checkIn.status === "APPROVED" && (
                  <p>本次返校打卡已审核通过。</p>
                )}
              </section>
            )}
            {(!checkIn || checkIn.status === "NOT_CHECKED" || retry) &&
              (inTime ? (
                <Capture
                  user={user}
                  task={task}
                  onSubmitted={(c) => {
                    setCheckIn(c);
                    setRetry(false);
                  }}
                />
              ) : (
                <p>任务尚未开始、已结束或已归档。</p>
              ))}
          </>
        )
      )}
    </main>
  );
}
function Capture({
  user,
  task,
  onSubmitted,
}: {
  user: Account;
  task: Task;
  onSubmitted: (c: CheckIn) => void;
}) {
  const camera = useCamera();
  const gps = useGeolocation();
  const overlay = useRef<HTMLCanvasElement>(null);
  const [photo, setPhoto] = useState<{
    blob: Blob;
    url: string;
    location: LocationData;
    time: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const watermark = useMemo(
    () => ({
      studentId: user.studentId,
      name: user.name,
      location: gps.location,
    }),
    [user, gps.location],
  );
  useWatermarkPreview(camera.videoRef.current, overlay.current, watermark);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url);
    },
    [photo],
  );
  const distance = gps.location
    ? distanceMeters(
        gps.location.lat,
        gps.location.lng,
        task.centerLat,
        task.centerLng,
      )
    : undefined;
  const ready =
    camera.ready &&
    gps.location &&
    now - gps.location.timestamp < 30000 &&
    gps.location.accuracy <= 200 &&
    distance! <= task.radius &&
    now <= new Date(task.endTime).getTime();
  async function capture() {
    if (!ready || !gps.location || !camera.videoRef.current) return;
    setBusy(true);
    setError("");
    try {
      const time = new Date();
      const location = { ...gps.location };
      const blob = await captureWatermarkedPhoto(camera.videoRef.current, {
        ...watermark,
        location,
        timestamp: time,
      });
      setPhoto({
        blob,
        url: URL.createObjectURL(blob),
        location,
        time: time.toISOString(),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!photo) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      Object.entries({
        taskId: task.id,
        lat: String(photo.location.lat),
        lng: String(photo.location.lng),
        accuracy: String(photo.location.accuracy),
        capturedAt: photo.time,
      }).forEach(([k, v]) => form.append(k, v));
      form.append("photo", photo.blob, "check-in.jpg");
      const result = await api<{ checkIn: CheckIn }>("/api/check-ins", form);
      onSubmitted(result.checkIn);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const seconds = Math.max(
    0,
    Math.floor((new Date(task.endTime).getTime() - now) / 1000),
  );
  return (
    <section>
      <p>
        剩余 {Math.floor(seconds / 3600)} 小时{" "}
        {Math.floor((seconds % 3600) / 60)} 分 {seconds % 60} 秒
      </p>
      {task.gestureImgUrl && (
        <figure>
          <img
            className="gesture-guide"
            src={task.gestureImgUrl}
            alt="本次标准手势"
          />
          <figcaption>请按图示完成手势</figcaption>
        </figure>
      )}
      <p>
        {camera.ready ? "相机就绪" : "相机启动中"} ·{" "}
        {gps.location
          ? `定位精度 ${Math.round(gps.location.accuracy)}m`
          : "定位中"}
      </p>
      <div className="camera-stage">
        <video
          ref={camera.videoRef}
          autoPlay
          muted
          playsInline
          onLoadedMetadata={() => camera.setReady(true)}
        />
        <canvas ref={overlay} aria-hidden="true" />
        {photo && <img src={photo.url} alt="待提交的带水印照片" />}
      </div>
      <p role="alert">{error || camera.error || gps.error}</p>
      {camera.error && (
        <button onClick={() => void camera.start()}>重新开启相机</button>
      )}
      <div className="capture-actions">
        {photo ? (
          <>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setPhoto(undefined)}
            >
              重新拍摄
            </button>
            <button
              className="command-button"
              disabled={busy || !navigator.onLine}
              onClick={() => void submit()}
            >
              {busy ? "提交中…" : "确认并提交"}
            </button>
          </>
        ) : (
          <button
            className="capture-button"
            disabled={!ready || busy}
            onClick={() => void capture()}
          >
            拍照
          </button>
        )}
      </div>
      <p>
        {distance === undefined
          ? "正在获取坐标"
          : `距离打卡点 ${Math.round(distance)}m，允许范围 ${task.radius}m`}
      </p>
      <p className="text-sm">
        照片与定位仅在联网时提交。定位精度差或超出范围时请移动到开阔处重试。
      </p>
    </section>
  );
}
