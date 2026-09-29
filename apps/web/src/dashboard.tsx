import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Image as ImageIcon,
  LayoutDashboard,
  MailCheck,
  MapPin,
  Package,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import type { CheckInStatus, Task } from "./types";
import type { Account } from "./lib/api";

interface DashboardData {
  task: Task & { status: string };
  metrics: {
    expected: number;
    checkedIn: number;
    notChecked: number;
    pending: number;
    approved: number;
    abnormal: number;
  };
  agent: {
    running: boolean;
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    processedCount: number;
    failedCount?: number;
    queueLength?: number;
    outboxQueueLength?: number;
    rejectedMailCount?: number;
  };
  timeDistribution: { time: string; count: number }[];
}

interface ReviewRow {
  user: { id: string; studentId: string; name: string; classId: string };
  status: CheckInStatus;
  checkIn: {
    id: string;
    status: CheckInStatus;
    photoUrl: string | null;
    lat: number | null;
    lng: number | null;
    address: string | null;
    rejectReason: string | null;
    createdAt: string;
    emailReceivedAt: string | null;
  } | null;
}

type Section = "dashboard" | "materials";
const statusLabel: Record<CheckInStatus, string> = {
  EMAIL_PENDING: "邮件待发送",
  NOT_CHECKED: "未打卡",
  EMAIL_SENT: "待邮件解析",
  REVIEWING: "审核中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  EMAIL_ERROR: "邮件异常",
};

export function CounselorDashboard({ user }: { user: Account }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [localEmailMode, setLocalEmailMode] = useState(false);
  const [taskId, setTaskId] = useState(
    new URLSearchParams(window.location.search).get("taskId") ?? "",
  );
  const [data, setData] = useState<DashboardData>();
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [filter, setFilter] = useState<"ALL" | CheckInStatus>("ALL");
  const [selected, setSelected] = useState<ReviewRow>();
  const [section, setSection] = useState<Section>("dashboard");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const loadVersion = useRef(0);

  async function loadTasks() {
    const response = await fetch("/api/tasks");
    if (!response.ok) throw new Error("无法加载任务列表");
    const result = (await response.json()) as { tasks: Task[]; localEmailMode: boolean };
    setTasks(result.tasks);
    setLocalEmailMode(result.localEmailMode);
    if (!result.tasks.length) setLoading(false);
    if (!taskId && result.tasks[0]) setTaskId(result.tasks[0].id);
  }

  async function loadTaskData(id: string) {
    const version = ++loadVersion.current;
    setLoading(true);
    setSelected(undefined);
    try {
      const [dashboardResponse, rowsResponse] = await Promise.all([
        fetch(`/api/tasks/${id}/dashboard`),
        fetch(
          `/api/tasks/${id}/check-ins${filter === "ALL" ? "" : `?status=${filter}`}`,
        ),
      ]);
      if (!dashboardResponse.ok || !rowsResponse.ok)
        throw new Error("无法加载任务统计");
      const dashboard = (await dashboardResponse.json()) as DashboardData;
      const list = (await rowsResponse.json()) as { rows: ReviewRow[] };
      if (version !== loadVersion.current) return;
      setData(dashboard);
      setRows(list.rows);
      setError(undefined);
    } catch (loadError) {
      if (version === loadVersion.current) {
        setData(undefined);
        setError((loadError as Error).message);
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadTasks().catch((loadError) => {
      setError((loadError as Error).message);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (taskId) void loadTaskData(taskId);
  }, [taskId, filter]);

  async function review(
    status: "APPROVED" | "REJECTED",
    rejectReason?: string,
  ) {
    if (!selected?.checkIn) return;
    const response = await fetch(
      `/api/check-ins/${selected.checkIn.id}/review`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Attendance-Request": "1",
        },
        body: JSON.stringify({ status, rejectReason }),
      },
    );
    const result = (await response.json()) as { message?: string };
    if (!response.ok) throw new Error(result.message ?? "审核操作失败");
    setSelected(undefined);
    await loadTaskData(taskId);
  }

  function download(path: string) {
    // 浏览器直接下载流，避免把整份 ZIP 读入前端内存。
    window.location.assign(path);
  }

  const visibleRows = useMemo(() => rows, [rows]);

  return (
    <main className="dashboard-shell min-h-dvh bg-slate-100 text-slate-900">
      <aside className="dashboard-sidebar border-r border-slate-200 bg-slate-950 text-slate-300">
        <div className="border-b border-slate-800 px-5 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">
            Campus Return
          </p>
          <h1 className="mt-2 text-lg font-semibold text-white">
            返校打卡管理
          </h1>
        </div>
        <nav className="space-y-1 p-3">
          <button
            className={`nav-item ${section === "dashboard" ? "nav-item-active" : ""}`}
            type="button"
            onClick={() => setSection("dashboard")}
          >
            <LayoutDashboard size={17} />
            任务审核
          </button>
          <button
            className={`nav-item ${section === "materials" ? "nav-item-active" : ""}`}
            type="button"
            onClick={() => setSection("materials")}
          >
            <Archive size={17} />
            材料中心
          </button>
        </nav>
        <div className="mt-auto hidden border-t border-slate-800 p-4 text-xs text-slate-500 md:block">
          返校打卡管理工作台
        </div>
      </aside>

      <section className="min-w-0">
        <header className="dashboard-header flex min-h-16 items-center justify-between border-b border-slate-200 bg-white px-5 md:px-8">
          <div>
            <p className="text-xs text-slate-500">周末返校统计</p>
            <h2 className="text-base font-semibold">辅导员控制台</h2>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-600">
            <span className="h-2 w-2 rounded-full bg-teal-500" />
            {user.name} · {user.role === "ADMIN" ? "管理员" : "辅导员"}
          </div>
        </header>

        <div className="space-y-6 p-5 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="relative block min-w-[260px]">
              <span className="sr-only">选择任务</span>
              <select
                className="h-10 w-full appearance-none border border-slate-300 bg-white px-3 pr-9 text-sm"
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
              >
                <option value="">选择任务</option>
                {tasks.map((task) => (
                  <option value={task.id} key={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-3 top-3 text-slate-400"
                size={16}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              onClick={() => taskId && void loadTaskData(taskId)}
              disabled={!taskId || loading}
            >
              <RefreshCw size={16} />
              刷新数据
            </button>
            {data && data.task.status !== "ARCHIVED" && (
              <button
                className="secondary-button"
                disabled={loading}
                onClick={async () => {
                  try {
                    const response = await fetch(
                      `/api/tasks/${taskId}/archive`,
                      {
                        method: "PATCH",
                        headers: { "X-Attendance-Request": "1" },
                      },
                    );
                    if (!response.ok)
                      throw new Error((await response.json()).message);
                    setTasks((current) =>
                      current.map((t) =>
                        t.id === taskId ? { ...t, status: "ARCHIVED" } : t,
                      ),
                    );
                    await loadTaskData(taskId);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                归档任务
              </button>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <X size={16} />
              {error}
            </div>
          )}
          {loading && !data ? (
            <div className="border border-slate-200 bg-white p-8 text-sm text-slate-500">
              加载看板数据...
            </div>
          ) : null}
          {!loading && !tasks.length && (
            <p>暂无任务，请在“人员与任务管理”中创建班级和任务。</p>
          )}
          {data && section === "dashboard" && (
            <DashboardContent
              data={data}
              rows={visibleRows}
              filter={filter}
              setFilter={setFilter}
              onSelect={setSelected}
            />
          )}
          {data && section === "materials" && (
            <MaterialsContent
              taskId={taskId}
              task={data.task}
              tasks={tasks}
              onSelectTask={setTaskId}
              onDownload={download}
            />
          )}
        </div>
      </section>

      {selected && (
        <ReviewDrawer
          row={selected}
          task={data?.task}
          localEmailMode={localEmailMode}
          onClose={() => setSelected(undefined)}
          onReview={review}
        />
      )}
    </main>
  );
}

function DashboardContent({
  data,
  rows,
  filter,
  setFilter,
  onSelect,
}: {
  data: DashboardData;
  rows: ReviewRow[];
  filter: "ALL" | CheckInStatus;
  setFilter: (value: "ALL" | CheckInStatus) => void;
  onSelect: (row: ReviewRow) => void;
}) {
  const metricCards = [
    ["应到人数", data.metrics.expected, Users, "text-slate-700"],
    ["实到人数", data.metrics.checkedIn, MailCheck, "text-teal-700"],
    ["未打卡", data.metrics.notChecked, Search, "text-amber-700"],
    ["异常/驳回", data.metrics.abnormal, X, "text-rose-700"],
  ] as const;
  const maxCount = Math.max(
    1,
    ...data.timeDistribution.map((item) => item.count),
  );
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map(([label, value, Icon, color]) => (
          <div className="metric-card" key={label}>
            <div className={`metric-icon ${color}`}>
              <Icon size={18} />
            </div>
            <p className="mt-4 text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>打卡时间分布</h3>
              <p>按提交时间统计</p>
            </div>
            <span className="text-xs text-slate-500">
              共{" "}
              {data.timeDistribution.reduce((sum, item) => sum + item.count, 0)}{" "}
              条
            </span>
          </div>
          <div className="bar-chart">
            {data.timeDistribution.length ? (
              data.timeDistribution.map((item) => (
                <div className="bar-column" key={item.time}>
                  <span className="bar-value">{item.count}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ height: `${(item.count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span>{item.time}</span>
                </div>
              ))
            ) : (
              <p className="py-8 text-sm text-slate-500">暂无打卡时间数据</p>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h3>邮件 Agent</h3>
              <p>IMAP 抓取服务</p>
            </div>
            <span
              className={`agent-dot ${data.agent.lastError ? "agent-dot-error" : ""}`}
            />
          </div>
          <div className="mt-6 flex items-center gap-3">
            <span
              className={`text-2xl font-semibold ${data.agent.lastError ? "text-rose-700" : "text-teal-700"}`}
            >
              {data.agent.lastError ? "异常" : "运行中"}
            </span>
            <span className="text-sm text-slate-500">
              已处理 {data.agent.processedCount} 封
            </span>
          </div>
          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">最近抓取</dt>
              <dd>
                {data.agent.lastSuccessAt
                  ? new Date(data.agent.lastSuccessAt).toLocaleString()
                  : "暂无"}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">被拒绝邮件</dt>
              <dd>{data.agent.rejectedMailCount ?? 0}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">队列状态</dt>
              <dd>
                {data.agent.running ? "抓取中" : "空闲"} · 待解析 {data.agent.queueLength ?? 0} · 待发送 {data.agent.outboxQueueLength ?? 0}
              </dd>
            </div>
            <div className="flex justify-between gap-4"><dt className="text-slate-500">抓取失败次数</dt><dd>{data.agent.failedCount ?? 0}</dd></div>
          </dl>
          {data.agent.lastError && (
            <p className="mt-5 border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-700">
              {data.agent.lastError}
            </p>
          )}
        </section>
      </div>
      <section className="panel overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h3>学生打卡名单</h3>
            <p className="mt-1 text-xs text-slate-500">
              点击审核中的记录查看照片与定位
            </p>
          </div>
          <select
            className="h-9 border border-slate-300 bg-white px-3 text-sm"
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as "ALL" | CheckInStatus)
            }
          >
            <option value="ALL">全部状态</option>
            {Object.entries(statusLabel).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>学生</th>
                <th>班级</th>
                <th>状态</th>
                <th>提交时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user.id}>
                  <td>
                    <p className="font-medium">{row.user.name}</p>
                    <p className="text-xs text-slate-500">
                      {row.user.studentId}
                    </p>
                  </td>
                  <td>{row.user.classId}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>
                    {row.checkIn?.createdAt
                      ? new Date(row.checkIn.createdAt).toLocaleString()
                      : "-"}
                  </td>
                  <td>
                    {row.checkIn ? (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => onSelect(row)}
                      >
                        查看详情
                      </button>
                    ) : (
                      <span className="text-slate-400">未提交</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            暂无符合条件的记录
          </p>
        )}
      </section>
    </>
  );
}

function MaterialsContent({
  taskId,
  task,
  tasks,
  onSelectTask,
  onDownload,
}: {
  taskId: string;
  task: Task;
  tasks: Task[];
  onSelectTask: (id: string) => void;
  onDownload: (path: string) => void;
}) {
  return (
    <section className="space-y-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-teal-700">
          材料中心
        </p>
        <h2 className="mt-1 text-2xl font-semibold">归档与导出</h2>
        <p className="mt-2 text-sm text-slate-500">
          已通过审核的照片和统计表可从这里下载。
        </p>
      </div>
      <div className="panel">
        <h3>已归档任务</h3>
        {tasks.filter((t) => t.status === "ARCHIVED").length === 0 && (
          <p className="text-sm text-slate-500">暂无归档任务</p>
        )}
        {tasks
          .filter((t) => t.status === "ARCHIVED")
          .map((t) => (
            <button
              className="task-option"
              key={t.id}
              onClick={() => onSelectTask(t.id)}
            >
              {t.title}
            </button>
          ))}
      </div>
      <div className="panel flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500">当前任务</p>
          <p className="mt-1 font-semibold">{task.title}</p>
        </div>
        <select
          className="h-9 border border-slate-300 bg-white px-3 text-sm"
          value={taskId}
          onChange={(event) => onSelectTask(event.target.value)}
        >
          {tasks.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="panel">
          <FileSpreadsheet className="text-teal-700" size={22} />
          <h3 className="mt-5">统计 Excel</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            包含学生、班级、打卡时间、状态和邮件接收时间。
          </p>
          <button
            className="command-button mt-5 w-full"
            type="button"
            onClick={() => onDownload(`/api/tasks/${taskId}/export/excel`)}
          >
            <Download size={17} />
            导出统计 Excel
          </button>
        </div>
        <div className="panel">
          <Package className="text-teal-700" size={22} />
          <h3 className="mt-5">通过照片 ZIP</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            仅包含审核通过的照片，按学号和姓名重命名。
          </p>
          <button
            className="command-button mt-5 w-full"
            type="button"
            onClick={() => onDownload(`/api/tasks/${taskId}/export/photos`)}
          >
            <Download size={17} />
            一键打包照片 ZIP
          </button>
        </div>
      </div>
    </section>
  );
}

function ReviewDrawer({
  row,
  task,
  localEmailMode,
  onClose,
  onReview,
}: {
  row: ReviewRow;
  task?: Task;
  localEmailMode: boolean;
  onClose: () => void;
  onReview: (status: "APPROVED" | "REJECTED", reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  async function submit(status: "APPROVED" | "REJECTED") {
    if (status === "REJECTED" && !reason.trim()) {
      setReviewError("驳回时必须填写原因");
      return;
    }
    setWorking(true);
    try {
      await onReview(status, reason.trim());
    } catch (error) {
      setReviewError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const imageUrl = row.checkIn?.photoUrl ?? "";
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        className="review-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="照片审核"
      >
        <div className="flex items-start justify-between border-b border-slate-200 p-5">
          <div>
            <p className="text-xs text-slate-500">照片审核</p>
            <h2 className="mt-1 text-lg font-semibold">
              {row.user.name} · {row.user.studentId}
            </h2>
          </div>
          <button
            className="icon-action"
            type="button"
            aria-label="关闭审核抽屉"
            title="关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        <div className="space-y-5 overflow-y-auto p-5">
          <div className="photo-stage">
            {imageUrl ? (
              <img src={imageUrl} alt={`${row.user.name}的打卡照片`} />
            ) : (
              <div className="text-sm text-slate-500">
                <ImageIcon size={24} />
                暂无照片
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="border border-slate-200 p-3">
              <p className="text-xs text-slate-500">{localEmailMode ? "邮件自报坐标（未经验证）" : "GPS 坐标"}</p>
              <p className="mt-2 font-medium">
                {row.checkIn?.lat?.toFixed(6) ?? "-"},{" "}
                {row.checkIn?.lng?.toFixed(6) ?? "-"}
              </p>
            </div>
            <div className="border border-slate-200 p-3">
              <p className="text-xs text-slate-500">{localEmailMode ? "邮箱收件时间" : "打卡时间"}</p>
              <p className="mt-2 font-medium">
                {row.checkIn?.createdAt
                  ? new Date(row.checkIn.createdAt).toLocaleString()
                  : "-"}
              </p>
            </div>
          </div>
          <div className="border border-slate-200 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <MapPin size={16} className="text-teal-700" />
              {localEmailMode ? "邮件位置声明" : "拍摄位置"}
            </p>
            <p className="mt-3 text-xs text-slate-500">
              {localEmailMode ? "邮件正文中的位置可由发件人填写，不能作为真实定位证据。" : "拍照时采集的单点坐标，供人工核对。"}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {row.checkIn?.address || "未提供逆地理编码地址"}
            </p>
          </div>
          {task?.gestureImgUrl && (
            <div>
              <p className="mb-2 text-sm font-medium">标准手势对比</p>
              <img
                className="max-h-36 border border-slate-200 object-contain"
                src={task.gestureImgUrl}
                alt="标准手势图例"
              />
            </div>
          )}
          <label className="block text-sm">
            <span className="font-medium">驳回原因</span>
            <textarea
              className="mt-2 min-h-24 w-full resize-y border border-slate-300 p-3"
              placeholder="审核不通过时填写具体原因"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {reviewError && (
            <p className="text-sm text-rose-600">{reviewError}</p>
          )}
        </div>
        <div className="flex gap-3 border-t border-slate-200 p-5">
          <button
            className="command-button flex-1"
            type="button"
            disabled={working || row.status !== "REVIEWING"}
            onClick={() => void submit("APPROVED")}
          >
            <Check size={17} />
            通过
          </button>
          <button
            className="reject-button flex-1"
            type="button"
            disabled={working || row.status !== "REVIEWING"}
            onClick={() => void submit("REJECTED")}
          >
            <X size={17} />
            驳回
          </button>
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: CheckInStatus }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      {statusLabel[status]}
    </span>
  );
}
