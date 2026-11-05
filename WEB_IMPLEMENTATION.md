# SQLite 与 Streamlit 完整实现

```text
attendance-bonus/
├── app.py
├── src/
│   ├── __init__.py
│   ├── config.py
│   ├── logger.py
│   ├── common.py
│   ├── data_store.py
│   ├── email_fetcher.py
│   ├── exif_validator.py
│   ├── report_generator.py
│   ├── web_helpers.py
│   └── cli.py
├── scripts/
│   ├── __init__.py
│   └── migrate_csv_to_sqlite.py
├── tests/
│   ├── __init__.py
│   ├── helpers.py
│   ├── test_mvp_agent.py
│   ├── test_modules.py
│   ├── test_sqlite.py
│   └── test_web.py
├── .streamlit/config.toml
├── .env.example
├── config.example.json
├── requirements.txt
├── run.sh
├── cli.py / mvp_agent.py          # 旧命令兼容入口
├── attendance.py / config.py     # 旧模块导入兼容层
├── common.py / logger.py / data_store.py
├── README.md
├── REFACTOR.md
└── WEB_IMPLEMENTATION.md
```

以下为当前仓库的完整实现；配置示例使用占位值，不包含本地授权码。

## src/data_store.py

```python
"""SQLite 考勤存储：短连接、参数化查询、来源去重、记录与进度原子提交。"""

from abc import ABC, abstractmethod
from contextlib import contextmanager
import json
import math
from pathlib import Path
import sqlite3

from .common import COLUMNS, MVPError


class DataStore(ABC):
    @abstractmethod
    def save_records(self, records: list) -> int:
        """幂等追加记录，返回新增数量；相同来源但内容冲突时拒绝。"""

    @abstractmethod
    def load_records(self) -> list:
        """读取全部记录，is_valid 为 bool，数值缺失为 None。"""

    @abstractmethod
    def has_source(self, key: str) -> bool:
        """检查附件来源，避免拉取时全量加载历史记录。"""

    @abstractmethod
    def load_checkpoint(self) -> dict:
        """读取当前数据源的邮件进度。"""

    @abstractmethod
    def commit_batch(self, records: list, checkpoint: dict) -> int:
        """在同一事务中保存一封邮件的记录和处理进度。"""


def normalize_records(records: list) -> list:
    normalized = {}
    for record in records:
        if not isinstance(record, dict) or set(COLUMNS[:-1]) - record.keys():
            raise MVPError("考勤记录缺少必要字段。")
        row = {key: "" if record.get(key) is None else str(record.get(key, "")) for key in COLUMNS}
        if not row["source_key"].strip():
            raise MVPError("考勤记录缺少来源标识，无法安全去重。")
        flag = row["is_valid"].strip().lower()
        if flag not in ("true", "false", "0", "1"):
            raise MVPError("is_valid 必须为 True/False 或 1/0。")
        row["is_valid"] = flag in ("true", "1")
        for key, bound in (("exif_lat", 90), ("exif_lon", 180), ("distance", None)):
            if row[key] == "":
                row[key] = None
                continue
            try:
                value = float(row[key])
                if not math.isfinite(value) or (bound is not None and abs(value) > bound) or (key == "distance" and value < 0):
                    raise ValueError
            except (ValueError, TypeError):
                raise MVPError(f"考勤记录的 {key} 不是合法数值。") from None
            row[key] = value
        previous = normalized.get(row["source_key"])
        if previous is not None and previous != row:
            raise MVPError("同一来源存在冲突记录，本批数据未导入。")
        normalized[row["source_key"]] = row
    return list(normalized.values())


class SqliteDataStore(DataStore):
    def __init__(self, path="data/attendance.db"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS attendance_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_id TEXT NOT NULL,
                    student_name TEXT NOT NULL,
                    email_time TEXT NOT NULL,
                    photo_name TEXT NOT NULL,
                    exif_lat REAL CHECK(exif_lat BETWEEN -90 AND 90),
                    exif_lon REAL CHECK(exif_lon BETWEEN -180 AND 180),
                    shoot_time TEXT NOT NULL DEFAULT '',
                    distance REAL CHECK(distance >= 0),
                    is_valid INTEGER NOT NULL CHECK(is_valid IN (0, 1)),
                    reason TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    source_key TEXT NOT NULL UNIQUE,
                    attendance_window TEXT NOT NULL DEFAULT '',
                    validation_scope TEXT NOT NULL DEFAULT '',
                    photo_path TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_records_valid_id ON attendance_records(is_valid, id);
                CREATE INDEX IF NOT EXISTS idx_records_student_window ON attendance_records(student_id, attendance_window);
                CREATE INDEX IF NOT EXISTS idx_records_email_time ON attendance_records(email_time);
                CREATE TABLE IF NOT EXISTS mail_checkpoint (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    value TEXT NOT NULL
                );
            """)

    @contextmanager
    def _connection(self):
        connection = None
        try:
            # 每次操作独立连接，避免 Streamlit 多线程共用 connection。
            connection = sqlite3.connect(self.path, timeout=10)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=10000")
            with connection:
                yield connection
        except sqlite3.Error as exc:
            raise MVPError("数据库读写失败，请检查文件权限、磁盘空间，或稍后重试。") from exc
        finally:
            if connection is not None:
                connection.close()

    @staticmethod
    def _decode(row):
        value = dict(row)
        value["is_valid"] = bool(value["is_valid"])
        return value

    def _insert(self, connection, records):
        inserted = 0
        columns = ", ".join(COLUMNS)
        placeholders = ", ".join("?" for _ in COLUMNS)
        for row in records:
            previous = connection.execute("SELECT * FROM attendance_records WHERE source_key = ?", (row["source_key"],)).fetchone()
            if previous is not None:
                old = self._decode(previous)
                if any(old[key] != row[key] for key in COLUMNS if key != "photo_path"):
                    raise MVPError("同一邮件来源存在内容冲突，本批数据未保存，请人工核对。")
                if not old["photo_path"] and row["photo_path"]:
                    connection.execute("UPDATE attendance_records SET photo_path = ? WHERE id = ?", (row["photo_path"], old["id"]))
                continue
            connection.execute(f"INSERT INTO attendance_records ({columns}) VALUES ({placeholders})", [row[key] for key in COLUMNS])
            inserted += 1
        return inserted

    def save_records(self, records: list) -> int:
        rows = normalize_records(records)
        with self._connection() as connection:
            return self._insert(connection, rows)

    def commit_batch(self, records: list, checkpoint: dict) -> int:
        rows = normalize_records(records)
        with self._connection() as connection:
            inserted = self._insert(connection, rows)
            connection.execute("INSERT INTO mail_checkpoint(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
                               (json.dumps(checkpoint, ensure_ascii=False),))
            return inserted

    def load_checkpoint(self) -> dict:
        with self._connection() as connection:
            row = connection.execute("SELECT value FROM mail_checkpoint WHERE id = 1").fetchone()
        if row is None:
            return {}
        try:
            state = json.loads(row["value"])
        except (ValueError, TypeError):
            raise MVPError("数据库中的邮件进度损坏，请恢复备份。") from None
        if (not isinstance(state, dict) or not isinstance(state.get("account"), str)
                or state.get("mailbox") != "INBOX" or not str(state.get("uidvalidity", "")).isdigit()
                or type(state.get("last_uid")) is not int or state["last_uid"] < 0):
            raise MVPError("数据库中的邮件进度格式错误，请恢复备份。")
        return state

    def has_source(self, key: str) -> bool:
        with self._connection() as connection:
            return connection.execute("SELECT 1 FROM attendance_records WHERE source_key = ?", (key,)).fetchone() is not None

    def load_records(self) -> list:
        with self._connection() as connection:
            rows = connection.execute("SELECT * FROM attendance_records ORDER BY id").fetchall()
        return [self._decode(row) for row in rows]

    def statistics(self) -> dict:
        with self._connection() as connection:
            row = connection.execute("SELECT COUNT(*) AS total, COALESCE(SUM(is_valid), 0) AS valid FROM attendance_records").fetchone()
        return {"total": row["total"], "valid": row["valid"], "invalid": row["total"] - row["valid"]}

    def query_records(self, is_valid=None, limit=200, offset=0) -> list:
        if is_valid is not None and type(is_valid) is not bool:
            raise MVPError("校验结果筛选参数错误。")
        if type(limit) is not int or not 1 <= limit <= 1000 or type(offset) is not int or offset < 0:
            raise MVPError("分页参数错误。")
        where, params = ("", []) if is_valid is None else (" WHERE is_valid = ?", [int(is_valid)])
        with self._connection() as connection:
            rows = connection.execute("SELECT * FROM attendance_records" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
                                      [*params, limit, offset]).fetchall()
        return [self._decode(row) for row in rows]
```

## scripts/migrate_csv_to_sqlite.py

```python
#!/usr/bin/env python3
"""一次性读取旧 CSV，校验后以单事务幂等导入 SQLite，不删除源文件。"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd

from src.common import COLUMNS, MVPError, UNLIMITED_WINDOW, single_process
from src.data_store import SqliteDataStore, normalize_records
from src.logger import close_logging, setup_logging


def prepare_records(csv_path, work_dir=ROOT):
    try:
        frame = pd.read_csv(csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    except FileNotFoundError:
        raise MVPError("找不到旧 CSV，请使用 --csv 指定路径。") from None
    except (ValueError, UnicodeError, pd.errors.ParserError):
        raise MVPError("CSV 格式错误，请检查 UTF-8 编码与字段。") from None
    if set(COLUMNS[:10]) - set(frame.columns):
        raise MVPError("CSV 缺少原始十个必要字段，未执行迁移。")
    records = []
    for number, original in enumerate(frame.to_dict("records"), 2):
        row = {key: original.get(key, "") for key in COLUMNS}
        row["attendance_window"] = row["attendance_window"] or UNLIMITED_WINDOW
        row["validation_scope"] = row["validation_scope"] or "历史数据：仅坐标校验，未校验拍摄时间"
        try:
            # 最早的十列版本可能使用无时区时间，按原系统所在地北京时间解释。
            if not original.get("source_key"):
                received = datetime.fromisoformat(row["email_time"])
                if received.utcoffset() is None:
                    received = received.replace(tzinfo=timezone(timedelta(hours=8)))
                row["email_time"] = received.isoformat()
            row["source_key"] = row["source_key"] or "pending"
            row = normalize_records([row])[0]
        except (MVPError, ValueError) as exc:
            raise MVPError(f"CSV 第 {number} 行数据无效，未导入任何记录。请检查布尔值、坐标和时间。") from exc
        if not original.get("source_key"):
            # 不含路径/行号，改名或重排 CSV 后再次导入也不会重复。
            canonical = {key: row[key] for key in COLUMNS[:10]}
            row["source_key"] = "csv:" + hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if not row["photo_path"]:
            filename = hashlib.sha256(row["source_key"].encode()).hexdigest() + ".jpg"
            if (Path(work_dir) / "attachments" / filename).is_file():
                row["photo_path"] = "attachments/" + filename
        records.append(row)
    return normalize_records(records)


def migrate(csv_path, db_path, work_dir=ROOT):
    with single_process(work_dir):
        rows = prepare_records(csv_path, work_dir)
        store = SqliteDataStore(db_path)
        count = store.save_records(rows)
    return {"rows": len(rows), "inserted": count, "skipped": len(rows) - count}


def main(argv=None):
    parser = argparse.ArgumentParser(description="把旧 CSV 幂等导入 SQLite；不删除 CSV，不复制旧邮件进度。")
    parser.add_argument("--csv", type=Path, default=None, help="默认 data/records.csv；兼容回退到根目录 records.csv")
    parser.add_argument("--db", type=Path, default=ROOT / "data/attendance.db")
    args = parser.parse_args(argv)
    source = args.csv or ROOT / "data/records.csv"
    if args.csv is None and not source.exists() and (ROOT / "records.csv").exists():
        source = ROOT / "records.csv"
    try:
        setup_logging(ROOT / "logs", ROOT / ".env")
        print("正在校验并导入 CSV…")
        result = migrate(source, args.db)
        print(f"迁移完成：{result['rows']} 条记录，新增 {result['inserted']} 条，已有 {result['skipped']} 条。源 CSV 已保留。")
        return 0
    except Exception:
        logging.getLogger(__name__).exception("CSV 迁移失败。")
        print("迁移失败，未提交本批记录。请检查 CSV 格式和路径，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
```

## app.py

```python
"""Streamlit 本地管理后台：python -m streamlit run app.py。"""

import logging
import math
import os
from pathlib import Path

import pandas as pd
import streamlit as st

from src.common import MVPError, single_process
from src.config import DEFAULT_CONFIG, load_config, read_business_config, save_config
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.logger import add_secret, redact, setup_logging
from src.report_generator import generate_report
from src.web_helpers import safe_photo_path


WORK_DIR = Path(os.environ.get("ATTENDANCE_WORK_DIR", Path(__file__).resolve().parent)).resolve()
log = logging.getLogger(__name__)
PAGE_SIZE = 200


def show_error(action, error):
    log.exception("%s失败。", action)
    if isinstance(error, MVPError):
        message = redact(str(error))
    else:
        message = "请检查邮箱连接、文件权限或稍后重试。详细原因已记录到运行日志。"
    st.error(f"{action}失败：{message}")


def sidebar(store):
    with st.sidebar:
        st.title("打卡管理")
        st.caption("照片校验与考勤汇总")
        try:
            business = read_business_config(WORK_DIR)
        except Exception as error:
            show_error("读取配置", error)
            business = DEFAULT_CONFIG.copy()
        if st.session_state.pop("clear_auth", False):
            st.session_state["auth_code"] = ""
        with st.form("settings"):
            st.subheader("系统配置")
            account = st.text_input("QQ 邮箱", value=business["email_account"])
            latitude = st.text_input("目标纬度", value=str(business["target_lat"]))
            longitude = st.text_input("目标经度", value=str(business["target_lon"]))
            threshold = st.text_input("距离阈值（米）", value=str(business["threshold_meters"]))
            auth = st.text_input("QQ 邮箱授权码", type="password", key="auth_code",
                                 help="首次使用请填写；留空则保留已保存的授权码。")
            with st.expander("拍摄时间校验"):
                start = st.text_input("窗口开始", value=business["attendance_start"], placeholder="2026-11-05T08:00:00+08:00")
                end = st.text_input("窗口结束", value=business["attendance_end"], placeholder="2026-11-05T10:00:00+08:00")
                photo_tz = st.text_input("照片默认时区", value=business["photo_timezone"])
                st.caption("开始与结束均留空时，仅校验照片坐标。")
            save = st.form_submit_button("保存配置", use_container_width=True)
        st.caption("新配置用于后续新提交，已有校验结果不会重新计算。")
        if save:
            try:
                add_secret(auth)
                with st.spinner("正在保存配置…"):
                    save_config({"email_account": account, "target_lat": latitude, "target_lon": longitude,
                                 "threshold_meters": threshold, "attendance_start": start,
                                 "attendance_end": end, "photo_timezone": photo_tz}, auth, WORK_DIR)
                st.session_state["clear_auth"] = True
                st.session_state["flash"] = "配置已保存。"
                st.rerun()
            except Exception as error:
                show_error("保存配置", error)

        st.divider()
        st.subheader("核心操作")
        if st.button("一键拉取并校验", type="primary", use_container_width=True, disabled=store is None):
            progress = None
            try:
                with st.spinner("正在连接邮箱、读取照片并校验…"):
                    config = load_config(WORK_DIR / "config.json", WORK_DIR / ".env")
                    add_secret(config.imap_auth_code.get_secret_value())
                    progress = st.progress(0, text="正在搜索新邮件…")

                    def update(done, total):
                        progress.progress(done / total, text=f"已处理 {done} / {total} 封邮件")

                    with single_process(WORK_DIR):
                        log.info("开始从 Web 拉取邮件。")
                        result = fetch_emails(config, store, WORK_DIR, update)
                    log.info("Web 拉取完成。")
                st.session_state.pop("report_bytes", None)
                st.session_state["flash"] = f"拉取完成：处理 {result['emails']} 封邮件，新增 {result['records']} 条记录。"
                st.rerun()
            except Exception as error:
                show_error("邮件拉取", error)
            finally:
                if progress is not None:
                    progress.empty()

        if st.button("生成并下载报表", use_container_width=True, disabled=store is None):
            try:
                with st.spinner("正在汇总记录并生成 Excel…"):
                    st.session_state["report_bytes"] = generate_report(store)
                st.success("报表已生成，请点击下方下载。")
            except Exception as error:
                st.session_state.pop("report_bytes", None)
                show_error("生成报表", error)
        if "report_bytes" in st.session_state:
            st.download_button("下载考勤汇总报表", data=st.session_state["report_bytes"],
                               file_name="考勤汇总报表.xlsx",
                               mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                               use_container_width=True)
        if st.button("刷新数据", use_container_width=True):
            st.rerun()
        st.caption("授权码只保存在本机配置中，页面不会回显已保存的授权码。")


def dashboard(store):
    with st.spinner("正在读取考勤数据…"):
        stats = store.statistics()
    metrics = st.columns(3)
    for column, label, key in zip(metrics, ("总打卡数", "有效打卡数", "异常 / 待核验"), ("total", "valid", "invalid")):
        column.metric(label, stats[key])
    st.caption("统计单位为照片提交记录；同一学生的多张照片会分别计数。")
    st.divider()
    st.subheader("打卡记录")
    controls = st.columns([2, 1])
    choice = controls[0].selectbox("校验结果", ["全部", "有效", "无效"], key="result_filter")
    valid = {"全部": None, "有效": True, "无效": False}[choice]
    count = stats[{None: "total", True: "valid", False: "invalid"}[valid]]
    pages = max(1, math.ceil(count / PAGE_SIZE))
    if st.session_state.get("last_filter") != choice:
        st.session_state["page"] = 1
        st.session_state["last_filter"] = choice
    if st.session_state.get("page", 1) > pages:
        st.session_state["page"] = pages
    page = controls[1].number_input("页码", min_value=1, max_value=pages, step=1, key="page")
    with st.spinner("正在加载记录明细…"):
        rows = store.query_records(valid, limit=PAGE_SIZE, offset=(page - 1) * PAGE_SIZE)
    st.caption(f"共 {count} 条记录，第 {page} / {pages} 页；每页最多 {PAGE_SIZE} 条，可点击表头排序当前页。")
    if not rows:
        st.info("暂无符合条件的打卡记录。请先保存邮箱配置，再点击“一键拉取并校验”。")
        return
    table, preview = st.columns([3, 1], gap="large")
    with table:
        frame = pd.DataFrame(rows)
        frame["校验结果"] = frame["is_valid"].map({True: "有效", False: "无效"})
        names = {"id": "编号", "student_id": "学号", "student_name": "姓名", "email_time": "收件时间",
                 "photo_name": "照片", "distance": "距离（米）", "reason": "原因", "shoot_time": "拍摄时间",
                 "exif_lat": "照片纬度", "exif_lon": "照片经度", "created_at": "入库时间"}
        visible = ["id", "student_id", "student_name", "校验结果", "distance", "reason", "email_time",
                   "shoot_time", "photo_name", "exif_lat", "exif_lon", "created_at"]
        st.dataframe(frame[visible].rename(columns=names), hide_index=True, width="stretch",
                     column_config={"距离（米）": st.column_config.NumberColumn(format="%.2f")})
    with preview:
        st.markdown("**照片预览**")
        selected_id = st.selectbox("选择本页记录", [row["id"] for row in rows],
                                   format_func=lambda value: next(f"{row['student_id']} · {row['student_name']}（#{value}）"
                                                                  for row in rows if row["id"] == value))
        selected = next(row for row in rows if row["id"] == selected_id)
        photo = safe_photo_path(selected.get("photo_path"), WORK_DIR)
        if photo is None:
            st.warning("这条记录没有可预览的照片，或本地文件已不存在。")
        else:
            try:
                with st.spinner("正在加载照片…"):
                    st.image(str(photo), caption=selected["photo_name"], width="stretch")
            except Exception as error:
                show_error("照片预览", error)
        st.caption(selected["reason"])


def main():
    st.set_page_config(page_title="校园打卡 · 管理后台", page_icon="📍", layout="wide")
    st.markdown("""<style>
        .stApp {font-family: 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif;}
        .block-container {max-width: 1500px; padding-top: 2.4rem;}
        h1 {font-weight: 650; letter-spacing: -.04em;}
        [data-testid="stSidebar"] {border-right: 1px solid #D5E1DB;}
        [data-testid="stMetric"] {padding: .8rem 0; border-top: 3px solid #216C53;}
        [data-testid="stMetricLabel"] {color: #51685E;}
        [data-testid="stMetricValue"] {font-variant-numeric: tabular-nums;}
        </style>""", unsafe_allow_html=True)
    st.title("校园打卡工作台")
    st.caption("核对照片位置，查看异常提交，导出考勤汇总。")
    st.warning("照片元数据可以被修改；无效或缺少 GPS 的记录需要人工核验，不能据此认定作弊。")
    if flash := st.session_state.pop("flash", None):
        st.success(flash)
    store = None
    try:
        setup_logging(WORK_DIR / "logs", WORK_DIR / ".env")
        with st.spinner("正在连接考勤数据库…"):
            store = SqliteDataStore(WORK_DIR / "data/attendance.db")
    except Exception as error:
        show_error("初始化后台", error)
    sidebar(store)
    if store is not None:
        try:
            dashboard(store)
        except Exception as error:
            show_error("读取考勤记录", error)


if __name__ == "__main__":
    main()

# Linux：.venv/bin/python -m streamlit run app.py --server.address=0.0.0.0
# 后台：nohup .venv/bin/python -m streamlit run app.py --server.address=0.0.0.0 > logs/web.log 2>&1 &
# 详细部署、访问范围和停止方法见 README.md 的《Linux 部署与运行指南》。
```

## requirements.txt

```text
exifread>=3.0,<4
pandas>=2.2,<4
openpyxl>=3.1,<4
pydantic>=2.12,<3
python-dotenv>=1.1,<2
streamlit>=1.50,<2
```

## src/config.py

```python
"""合并 JSON 业务配置与 .env 凭证，并通过 Pydantic 校验。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from dotenv import dotenv_values, set_key
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator

from .common import MVPError, UNLIMITED_WINDOW, atomic_path, read_json, save_json, single_process


DEFAULT_CONFIG = {
    "email_account": "your_qq@qq.com",
    "target_lat": 39.9042,
    "target_lon": 116.4074,
    "threshold_meters": 200.0,
    "attendance_start": "",
    "attendance_end": "",
    "photo_timezone": "+08:00",
    "max_attachment_bytes": 10 * 1024 * 1024,
    "max_email_bytes": 25 * 1024 * 1024,
}
ENV_EXAMPLE = "# QQ 邮箱 IMAP 授权码，不是登录密码。\nIMAP_AUTH_CODE=your_auth_code\n"


def parse_timezone(value):
    match = re.fullmatch(r"([+-])(\d{2}):(\d{2})", str(value))
    if not match:
        raise MVPError("时区必须为固定偏移，例如 +08:00。")
    hours, minutes = int(match[2]), int(match[3])
    if hours > 23 or minutes > 59:
        raise MVPError("时区偏移超出范围。")
    delta = timedelta(hours=hours, minutes=minutes)
    return timezone(delta if match[1] == "+" else -delta)


class AppConfig(BaseModel):
    """SecretStr 避免凭证出现在模型 repr/JSON 中；配置源由 load_config 控制。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, hide_input_in_errors=True,
                              validate_assignment=True)
    email_account: str
    imap_auth_code: SecretStr = Field(repr=False, exclude=True)
    target_lat: float = Field(ge=-90, le=90)
    target_lon: float = Field(ge=-180, le=180)
    threshold_meters: float = Field(ge=0)
    attendance_start: str = ""
    attendance_end: str = ""
    photo_timezone: str = "+08:00"
    max_attachment_bytes: int = Field(default=10 * 1024 * 1024, gt=0, strict=True)
    max_email_bytes: int = Field(default=25 * 1024 * 1024, gt=0, strict=True)

    @field_validator("target_lat", "target_lon", "threshold_meters", mode="before")
    @classmethod
    def reject_boolean(cls, value):
        if isinstance(value, bool):
            raise ValueError("必须是数值，不能为布尔值")
        return value

    @field_validator("email_account")
    @classmethod
    def validate_account(cls, value):
        value = value.strip()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+", value) or value == DEFAULT_CONFIG["email_account"]:
            raise ValueError("请填写真实邮箱")
        return value

    @field_validator("imap_auth_code")
    @classmethod
    def validate_secret(cls, value):
        secret = value.get_secret_value()
        if not secret.strip() or secret == "your_auth_code" or secret != secret.strip():
            raise ValueError("请在 .env 中填写 IMAP 授权码")
        return value

    @model_validator(mode="after")
    def validate_times(self):
        try:
            parse_timezone(self.photo_timezone)
            if bool(self.attendance_start) != bool(self.attendance_end):
                raise ValueError("打卡起止时间必须同时填写")
            bounds = self.window
            if bounds and (any(bound.utcoffset() is None for bound in bounds) or bounds[0] > bounds[1]):
                raise ValueError("打卡时间必须包含时区，且起点不晚于终点")
        except MVPError as exc:
            raise ValueError(str(exc)) from None
        return self

    @property
    def photo_tz(self):
        return parse_timezone(self.photo_timezone)

    @property
    def window(self):
        if not self.attendance_start:
            return None
        return datetime.fromisoformat(self.attendance_start), datetime.fromisoformat(self.attendance_end)

    @property
    def window_label(self):
        if not self.window:
            return UNLIMITED_WINDOW
        return "/".join(bound.astimezone(timezone.utc).isoformat() for bound in self.window)


def load_config(config_path="config.json", env_path=".env") -> AppConfig:
    if not Path(config_path).exists() or not Path(env_path).exists():
        raise MVPError("缺少 config.json 或 .env，请先执行 init 并填写配置。")
    business = read_json(config_path)
    if "imap_auth_code" in business:
        raise MVPError("请将 config.json 中的 imap_auth_code 移至 .env 的 IMAP_AUTH_CODE，并删除 JSON 中该字段。")
    # 不读取进程环境，不做 ${VAR} 插值，确保凭证只来源于指定 .env 文件。
    secret = dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE")
    if secret is None:
        raise MVPError(".env 缺少 IMAP_AUTH_CODE，请填写 QQ 邮箱 IMAP 授权码。")
    try:
        return AppConfig.model_validate({**DEFAULT_CONFIG, **business, "imap_auth_code": secret})
    except ValidationError as exc:
        # 不输出 Pydantic 的 input/context，避免配置异常泄露凭证。
        fields = sorted({".".join(map(str, error["loc"])) or "时间窗口/时区"
                         for error in exc.errors(include_input=False, include_context=False)})
        raise MVPError("配置校验失败，请检查字段：" + ", ".join(fields)) from None


def init_config():
    """只生成缺失文件，既有 JSON 和 .env 都不会被覆盖。"""
    generated = []
    if not Path("config.json").exists():
        save_json("config.json", DEFAULT_CONFIG)
        generated.append("config.json")
    if not Path(".env").exists():
        with atomic_path(".env") as temp:
            temp.write_text(ENV_EXAMPLE, encoding="utf-8")
        generated.append(".env")
    if not generated:
        raise MVPError("config.json 和 .env 已存在，未覆盖。请直接编辑配置。")
    print("已生成 " + "、".join(generated) + "。邮箱和业务参数填 config.json；IMAP 授权码填 .env。")


def read_business_config(work_dir="."):
    path = Path(work_dir) / "config.json"
    value = read_json(path) if path.exists() else {}
    if "imap_auth_code" in value:
        raise MVPError("请先将旧 JSON 的 imap_auth_code 移至 .env，再删除该字段。")
    return {**DEFAULT_CONFIG, **value}


def save_config(changes: dict, auth_code="", work_dir=".") -> AppConfig:
    """表单保存：先校验，留空保留授权码；写入失败时恢复之前的两个文件。"""
    from .logger import add_secret

    folder = Path(work_dir)
    config_path, env_path = folder / "config.json", folder / ".env"
    with single_process(folder):
        business = {**read_business_config(folder), **changes}
        if "imap_auth_code" in business:
            raise MVPError("授权码只能写入 .env。")
        old_env = env_path.read_bytes() if env_path.exists() else None
        old_config = config_path.read_bytes() if config_path.exists() else None
        saved_secret = dotenv_values(env_path, interpolate=False).get("IMAP_AUTH_CODE") if env_path.exists() else None
        secret = auth_code if auth_code else saved_secret
        add_secret(secret)
        try:
            config = AppConfig.model_validate({**business, "imap_auth_code": secret})
        except ValidationError as exc:
            labels = {"email_account": "QQ 邮箱", "imap_auth_code": "邮箱授权码", "target_lat": "目标纬度",
                      "target_lon": "目标经度", "threshold_meters": "距离阈值"}
            fields = sorted({labels.get(".".join(map(str, error["loc"])), "时间窗口或其他配置")
                             for error in exc.errors(include_input=False, include_context=False)})
            raise MVPError("配置未保存，请检查：" + ", ".join(fields)) from None
        try:
            # 两个独立文件不能组成数据库事务；错误时恢复原始字节。
            save_json(config_path, config.model_dump())
            with atomic_path(env_path) as temp:
                temp.write_bytes(old_env or b"")
                set_key(str(temp), "IMAP_AUTH_CODE", secret, quote_mode="always")
        except Exception:
            for path, previous in ((config_path, old_config), (env_path, old_env)):
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    with atomic_path(path) as temp:
                        temp.write_bytes(previous)
            raise
        return config
```

## src/email_fetcher.py

```python
"""只读拉取邮件，解析图片，按邮件事务保存记录与进度。"""

from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
import hashlib
import imaplib
import json
import logging
from pathlib import Path
import re

from .common import COLUMNS, MVPError, atomic_path
from .config import AppConfig
from .data_store import DataStore
from .exif_validator import evaluate_photo

log = logging.getLogger(__name__)
SUBJECT_RE = re.compile(r"^【打卡】(?P<id>[0-9]+)-(?P<name>[^\r\n]+)$")


def source_key(account, validity, uid, part_index):
    return json.dumps([account.casefold(), "INBOX", validity, uid, part_index], ensure_ascii=False, separators=(",", ":"))

def email_received_time(metadata):
    match = re.search(rb'INTERNALDATE "([^"]+)"', metadata)
    if not match:
        raise MVPError("服务器没有提供 INTERNALDATE，未推进邮件处理进度。")
    try:
        # INTERNALDATE 来自邮件服务器，而不是发件人可自行填写的 Date 头。
        value = match[1].decode("ascii").replace("-", " ", 2)
        received = parsedate_to_datetime(value)
        if received.utcoffset() is None:
            raise ValueError
        return received.isoformat()
    except (ValueError, TypeError, UnicodeError):
        raise MVPError("服务器收件时间无法解析，未推进邮件处理进度。") from None

def attachment_rows(raw_email, metadata, config: AppConfig, validity, uid, store, work_dir=Path(".")):
    message = BytesParser(policy=policy.default).parsebytes(raw_email)
    subject = str(message.get("Subject", "")).strip()
    # fullmatch 限定整行；学号保留字符串类型，防止丢失前导零。
    match = SUBJECT_RE.fullmatch(subject)
    if not match or not match["name"].strip():
        log.info("跳过 UID %s：主题不符合【打卡】学号-姓名。", uid)
        return []
    received = email_received_time(metadata)
    rows = []
    for index, part in enumerate(message.walk()):
        if part.is_multipart():
            continue
        filename = part.get_filename()
        if not filename or Path(filename).suffix.lower() not in (".jpg", ".jpeg"):
            continue
        key = source_key(config.email_account, validity, uid, index)
        if store.has_source(key):
            continue
        row = dict.fromkeys(COLUMNS, "")
        row.update(student_id=match["id"], student_name=match["name"].strip(),
                   email_time=received, photo_name=filename, source_key=key,
                   is_valid=False, attendance_window=config.window_label,
                   validation_scope="坐标及拍摄时间校验" if config.window else "仅坐标校验，未校验拍摄时间")
        payload = part.get_payload(decode=True)
        if not payload:
            row["reason"] = "附件为空或无法解码"
        elif len(payload) > config.max_attachment_bytes:
            row["reason"] = "附件超过大小限制"
        elif not payload.startswith(b"\xff\xd8\xff"):
            row["reason"] = "附件不是可识别的JPEG图片"
        else:
            # 永远不把邮件附件名拼入本地路径，阻断路径穿越和同名覆盖。
            folder = Path(work_dir) / "attachments"
            folder.mkdir(mode=0o700, exist_ok=True)
            target = folder / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".jpg")
            with atomic_path(target) as temp:
                temp.write_bytes(payload)
            row["photo_path"] = str(target.relative_to(work_dir))
            row.update(evaluate_photo(target, config))
        rows.append(row)
    if not rows:
        log.info("UID %s：没有新的 JPG/JPEG 附件。", uid)
    return rows

def require_ok(status, operation):
    if status != "OK":
        raise MVPError(f"邮箱{operation}失败，未推进处理进度。")

def fetch_emails(config: AppConfig, store: DataStore, work_dir=Path("."), progress=None):
    """每封邮件的记录与 UID 进度在同一事务内提交，中断可重试。"""
    import exifread  # 在连接邮箱前检查依赖。

    account = config.email_account
    auth = config.imap_auth_code.get_secret_value()
    state = store.load_checkpoint()
    connection = None
    total = 0
    try:
        connection = imaplib.IMAP4_SSL("imap.qq.com", 993, timeout=30)
        status, _ = connection.login(account, auth)
        require_ok(status, "登录")
        status, _ = connection.select("INBOX", readonly=True)
        require_ok(status, "打开收件箱")
        _, response = connection.response("UIDVALIDITY")
        if not response or not response[0] or not response[0].isdigit():
            raise MVPError("无法获取 UIDVALIDITY，停止处理以免错误去重。")
        validity = response[0].decode("ascii")
        same_mailbox = (state.get("account", "").casefold() == account.casefold()
                        and state.get("mailbox") == "INBOX" and state.get("uidvalidity") == validity)
        last_uid = state.get("last_uid", 0) if same_mailbox else 0
        if type(last_uid) is not int or last_uid < 0:
            raise MVPError("数据库中的邮件进度无效，请先核对。")
        if state and not same_mailbox:
            log.warning("邮箱或 UIDVALIDITY 发生变化，将重新扫描收件箱，并使用新的来源标识。")
        # 不依赖已读状态；过滤大于游标的 UID，兼容服务器对 n:* 的范围解释。
        status, data = connection.uid("SEARCH", None, "UID", f"{last_uid + 1}:*")
        require_ok(status, "搜索邮件")
        uids = sorted({int(value) for value in (data[0] or b"").split() if int(value) > last_uid})
        for position, uid in enumerate(uids, 1):
            status, size_data = connection.uid("FETCH", str(uid), "(RFC822.SIZE)")
            require_ok(status, "读取邮件大小")
            size_metadata = b" ".join(item for item in size_data if isinstance(item, bytes))
            size_match = re.search(rb"RFC822.SIZE (\d+)", size_metadata)
            if not size_match:
                raise MVPError(f"UID {uid} 无法读取大小，停止处理；下次可重试。")
            if int(size_match[1]) > config.max_email_bytes:
                # 不推进此邮件，以便调高配置后可直接重试，避免静默永久漏掉。
                raise MVPError(f"UID {uid} 超过 max_email_bytes；请调高限制后重试，或人工移出收件箱。")
            status, data = connection.uid("FETCH", str(uid), "(BODY.PEEK[] INTERNALDATE)")
            require_ok(status, "下载邮件")
            body = next((item for item in data if isinstance(item, tuple) and isinstance(item[1], bytes)), None)
            if body is None:
                raise MVPError(f"UID {uid} 下载不完整，停止处理；下次可重试。")
            rows = attachment_rows(body[1], body[0], config, validity, uid, store, Path(work_dir))
            checkpoint = dict(account=account, mailbox="INBOX", uidvalidity=validity, last_uid=uid)
            total += store.commit_batch(rows, checkpoint)
            if progress:
                progress(position, len(uids))
        log.info("处理完成：检查 %s 封邮件，新增 %s 条附件记录。", len(uids), total)
        if not config.window:
            log.info("当前仅校验照片坐标，未校验拍摄时间；结果不证明本人到场。")
        return {"emails": len(uids), "records": total}
    finally:
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                log.warning("邮箱退出失败；已保存的记录和进度不受影响。")
```

## src/exif_validator.py

```python
"""JPEG EXIF 解析与坐标、拍摄时间校验。"""

from datetime import datetime
import logging
import math
from pathlib import Path

from .common import MVPError
from .config import AppConfig, parse_timezone

log = logging.getLogger(__name__)


def haversine(lat1, lon1, lat2, lon2):
    """Haversine 球面距离，地球半径 6371000 米；钳制误差避免反三角函数越界。"""
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    value = math.sin((lat2 - lat1) / 2) ** 2
    value += math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(min(1.0, max(0.0, value))))

def gps_coordinate(tags, axis):
    """EXIF GPS 用“度、分、秒”有理数存储；N/E 为正，S/W 为负。"""
    label = "Latitude" if axis == "lat" else "Longitude"
    parts = tags[f"GPS GPS{label}"].values
    ref = str(tags[f"GPS GPS{label}Ref"]).strip().upper()
    if len(parts) != 3 or ref not in (("N", "S") if axis == "lat" else ("E", "W")):
        raise ValueError("GPS 格式错误")
    values = [float(part.num) / float(part.den) for part in parts]
    if any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("GPS 数值错误")
    if values[1] >= 60 or values[2] >= 60:
        raise ValueError("GPS 分秒越界")
    coordinate = values[0] + values[1] / 60 + values[2] / 3600
    if coordinate > (90 if axis == "lat" else 180):
        raise ValueError("GPS 坐标越界")
    return -coordinate if ref in ("S", "W") else coordinate

def evaluate_photo(path, config: AppConfig):
    import exifread

    result = dict(exif_lat="", exif_lon="", shoot_time="", distance="", is_valid=False, reason="")
    try:
        with Path(path).open("rb") as stream:
            tags = exifread.process_file(stream, details=False, strict=True)
    except OSError:
        raise  # 文件系统错误应停止任务并由 CLI 记录，不伪装成照片校验失败。
    except Exception:
        log.warning("照片或 EXIF 解析失败，当前附件转人工核验。")
        # 解析器面对不可信图片可能抛出多种异常，隔离到当前附件。
        result["reason"] = "照片或EXIF解析失败，待人工核验"
        return result
    raw_time = str(tags.get("EXIF DateTimeOriginal", "")).strip()
    result["shoot_time"] = raw_time
    try:
        lat, lon = gps_coordinate(tags, "lat"), gps_coordinate(tags, "lon")
    except (KeyError, ValueError, TypeError, AttributeError, ZeroDivisionError, OverflowError):
        result["reason"] = "缺少可用GPS，待人工核验"
        return result
    result.update(exif_lat=lat, exif_lon=lon)
    distance = haversine(lat, lon, config.target_lat, config.target_lon)
    result["distance"] = distance  # 原始精度参与判断，Excel 中仅显示两位小数。
    if distance > config.threshold_meters:
        result["reason"] = "距离超限"
        return result
    if config.window:
        try:
            offset = str(tags.get("EXIF OffsetTimeOriginal", "")).strip()
            tz = parse_timezone(offset) if offset else config.photo_tz
            shoot = datetime.strptime(raw_time, "%Y:%m:%d %H:%M:%S").replace(tzinfo=tz)
        except (ValueError, MVPError):
            result["reason"] = "缺少可用拍摄时间，待人工核验"
            return result
        result["shoot_time"] = shoot.isoformat()
        start, end = config.window
        if not start <= shoot <= end:
            result["reason"] = "拍摄时间不在打卡窗口内"
            return result
    result.update(is_valid=True, reason="有效")
    return result
```

## src/report_generator.py

```python
"""带颜色的 Excel 明细和学生汇总，可直接返回下载字节。"""

from datetime import datetime, timedelta, timezone
from io import BytesIO
import logging
import math
from pathlib import Path

from .common import COLUMNS, UNLIMITED_WINDOW, MVPError, atomic_path
from .data_store import DataStore

log = logging.getLogger(__name__)


def write_sheet(workbook, title, headers, rows, status_column):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

    sheet = workbook.create_sheet(title)
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="D9EAF7")
    for row_index, (values, valid) in enumerate(rows, 2):
        color = "E2F0D9" if valid else "FCE4D6"
        for column, value in enumerate(values, 1):
            cell = sheet.cell(row=row_index, column=column)
            if isinstance(value, str):
                # openpyxl 默认把 = 开头的字符串当公式，必须显式强制为文本。
                cell.value = ILLEGAL_CHARACTERS_RE.sub("", value)[:32767]
                cell.data_type = "s"
            else:
                cell.value = value
            cell.fill = PatternFill("solid", fgColor=color)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if headers[column - 1] in ("distance", "exif_lat", "exif_lon"):
                cell.number_format = "0.00" if headers[column - 1] == "distance" else "0.000000"
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for column, header in enumerate(headers, 1):
        width = 36 if column == status_column or header in ("reason", "validation_scope", "校验说明") else 23
        sheet.column_dimensions[get_column_letter(column)].width = width
    return sheet

def generate_report(store: DataStore, destination=None) -> bytes:
    import pandas as pd
    from openpyxl import Workbook

    try:
        rows = store.load_records()
    except FileNotFoundError:
        rows = []
    records = pd.DataFrame(rows, columns=COLUMNS)
    records = records.astype(object).where(pd.notna(records), "")
    if records.empty:
        raise MVPError("没有可导出的记录，请先执行 fetch。")
    for column in ("student_id", "student_name", "attendance_window", "validation_scope"):
        if records[column].str.strip().eq("").any():
            raise MVPError(f"考勤记录的 {column} 存在空值，请先核对。")
    # 检查已有数值，避免手工修改的 CSV 把非法值带入报表。
    for column in ("exif_lat", "exif_lon", "distance"):
        for value in records[column]:
            if value:
                try:
                    number = float(value)
                    if not math.isfinite(number):
                        raise ValueError
                except (TypeError, ValueError):
                    raise MVPError(f"考勤记录的 {column} 包含非法数值。") from None
    workbook = Workbook()
    workbook.remove(workbook.active)
    detail_rows = []
    for row in records.to_dict("records"):
        values = []
        for column in COLUMNS:
            value = row[column]
            if column == "is_valid":
                value = "有效" if row["is_valid"] else f"无效({row['reason'] or '原因缺失，待核验'})"
            elif column in ("exif_lat", "exif_lon", "distance") and value != "":
                value = float(value)
            values.append(value)
        detail_rows.append((values, bool(row["is_valid"])))
    write_sheet(workbook, "附件明细", COLUMNS, detail_rows, COLUMNS.index("is_valid") + 1)
    summary_rows = []
    # 未设置窗口的记录按收件日期汇总，防止跨天提交被算成一次。
    records["_group"] = records["attendance_window"]
    for index, row in records.iterrows():
        if row["attendance_window"] == UNLIMITED_WINDOW:
            try:
                received = datetime.fromisoformat(row["email_time"])
                if received.utcoffset() is None:
                    raise ValueError
                day = received.astimezone(timezone(timedelta(hours=8))).date().isoformat()
            except ValueError:
                raise MVPError("未设置窗口的记录必须具有含时区的 email_time。") from None
            records.at[index, "_group"] = f"{day}（北京时间收件日，未校验拍摄时间）"
    for (student_id, period), group in records.groupby(["student_id", "_group"], sort=True):
        names = sorted(set(group["student_name"]))
        conflict = len(names) > 1
        valid = bool(group["is_valid"].any()) and not conflict
        status = "待人工核验(同一学号姓名冲突)" if conflict else ("校验通过" if valid else "未通过，待核验")
        summary_rows.append(([student_id, " / ".join(names), period, len(group),
                              int(group["is_valid"].sum()), status,
                              "；".join(sorted(set(group["validation_scope"])))], valid))
    write_sheet(workbook, "学生汇总", ["学号", "姓名", "时间窗口或收件日", "附件数", "通过附件数", "校验结果", "校验说明"], summary_rows, 6)
    notes = workbook.create_sheet("使用说明")
    for text in (
        "本工具验证照片元数据，不证明本人到场；EXIF 可被修改，也可能因压缩而丢失。",
        "附件明细中的有效/无效仅表示配置规则的自动校验结果，无GPS等情况应人工核验。",
        "同一学号同一窗口至少一张通过即记一次通过；姓名冲突需人工核验。",
        "未设置时间窗口时按北京时间收件日期汇总，仅表示坐标校验通过。",
        "没有学生名单，不能识别未提交者，也不能据此生成缺勤结论。",
        "未绑定发件邮箱与学号，主题中的身份由提交者填写，需人工核对。",
        "照片无时区时使用提交处理时配置的 photo_timezone；不会自动推断实际拍摄地时区。",
        "考勤存储是可信工作数据，手工修改会影响结果；跨不同校验配置的记录请使用不同工作目录。",
    ):
        notes.append([text])
    notes.column_dimensions["A"].width = 120
    buffer = BytesIO()
    try:
        workbook.save(buffer)
    finally:
        workbook.close()
    content = buffer.getvalue()
    if destination is not None:
        with atomic_path(destination) as temp:
            temp.write_bytes(content)
    log.info("报表已生成：%s 条附件明细，%s 条学生汇总。", len(records), len(summary_rows))
    return content
```

## src/common.py

```python
"""共享记录字段、异常和原子文件操作，不依赖具体考勤存储实现。"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile


COLUMNS = [
    "student_id", "student_name", "email_time", "photo_name", "exif_lat",
    "exif_lon", "shoot_time", "distance", "is_valid", "reason",
    "source_key", "attendance_window", "validation_scope", "photo_path",
]
UNLIMITED_WINDOW = "未设置时间窗口"


class MVPError(Exception):
    """可直接展示给用户的业务错误，消息中不得包含凭证。"""


@contextmanager
def single_process(work_dir="."):
    """同一工作目录只允许一个命令修改记录或邮件进度。"""
    lock = Path(work_dir) / ".mvp_agent.lock"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise MVPError("已有任务运行或遗留锁文件；确认没有任务运行后，删除 .mvp_agent.lock 再重试。") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
        yield
    finally:
        lock.unlink(missing_ok=True)


@contextmanager
def atomic_path(destination, mode=0o600):
    """同目录临时文件 + 原子替换，避免失败时留下半份数据。"""
    destination = Path(destination)
    fd, name = tempfile.mkstemp(prefix=".mvp-", suffix=destination.suffix, dir=destination.parent)
    os.close(fd)
    temp = Path(name)
    try:
        yield temp
        os.chmod(temp, mode)
        with temp.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def save_json(path, value):
    with atomic_path(path) as temp:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise MVPError(f"{path} 不是有效的 UTF-8 JSON，请检查文件。") from None
    if not isinstance(value, dict):
        raise MVPError(f"{path} 顶层必须是 JSON 对象。")
    return value
```

## src/logger.py

```python
"""Root logger：控制台 + 5 MiB 滚动日志，异常堆栈也进行凭证脱敏。"""

import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
from threading import RLock

from dotenv import dotenv_values


_secrets = set()
_lock = RLock()


def add_secret(value):
    if value:
        with _lock:
            _secrets.add(value)
            _secrets.add(repr(value)[1:-1])


def redact(text):
    with _lock:
        secrets = sorted(_secrets, key=len, reverse=True)
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    return text


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        # 先格式化异常链，再整体替换，覆盖异常消息中可能出现的授权码。
        return redact(super().format(record))


def setup_logging(log_dir="logs", env_path=".env"):
    with _lock:
        if Path(env_path).is_file():
            add_secret(dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE"))
        handlers = [handler for handler in logging.getLogger().handlers if getattr(handler, "_attendance_handler", False)]
        expected = str((Path(log_dir) / "agent.log").resolve())
        if len(handlers) == 2 and any(getattr(handler, "baseFilename", None) == expected for handler in handlers):
            return
        _setup_logging(log_dir, env_path)


def _setup_logging(log_dir, env_path):
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_attendance_handler", False):
            root.removeHandler(handler)
            handler.close()
    if Path(env_path).is_file():
        # 先注册密钥再读取业务配置，配置失败时的日志也能脱敏。
        add_secret(dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE"))
    folder = Path(log_dir)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / "agent.log"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    file_handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    console_handler = logging.StreamHandler()
    formatter = RedactingFormatter("%(asctime)s | %(name)s | %(levelname)s | %(message)s",
                                   datefmt="%Y-%m-%d %H:%M:%S")
    for handler in (file_handler, console_handler):
        handler.setFormatter(formatter)
        handler.setLevel(logging.INFO)
        handler._attendance_handler = True
        root.addHandler(handler)
    root.setLevel(logging.INFO)


def close_logging():
    """释放本应用创建的 handler，方便同进程多次调用 CLI 或执行测试。"""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_attendance_handler", False):
            root.removeHandler(handler)
            handler.close()
```

## src/web_helpers.py

```python
"""Web 与测试共用的照片路径检查。"""

from pathlib import Path


def safe_photo_path(value, work_dir):
    if not value:
        return None
    root = Path(work_dir).resolve()
    folder = (root / "attachments").resolve()
    path = (root / value).resolve()
    # 仅预览附件目录下的 JPEG，不能借数据库字段读取任意本地文件。
    if not path.is_relative_to(folder) or path.suffix.lower() not in (".jpg", ".jpeg") or not path.is_file():
        return None
    return path
```

## src/cli.py

```python
"""命令入口与依赖组装；更换后端只需在此传入其他 DataStore。"""

import argparse
import imaplib
import logging
import sys

from .email_fetcher import fetch_emails
from .report_generator import generate_report
from .common import MVPError, single_process
from .config import init_config, load_config
from .data_store import SqliteDataStore, DataStore
from .logger import add_secret, close_logging, redact, setup_logging


log = logging.getLogger(__name__)


def main(argv=None, store: DataStore | None = None):
    parser = argparse.ArgumentParser(description="照片打卡校验（元数据不能证明本人到场）")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="生成 config.json 和 .env，不覆盖已有文件")
    subparsers.add_parser("fetch", help="从 QQ 邮箱增量处理照片附件")
    subparsers.add_parser("report", help="生成带颜色的 Excel 明细与汇总")
    args = parser.parse_args(argv)
    logging_ready = False
    try:
        setup_logging()
        logging_ready = True
        with single_process():
            # CLI 与 Web 共享同一 SQLite 存储和业务模块。
            if store is None:
                store = SqliteDataStore()
            labels = {"init": "初始化配置", "fetch": "拉取邮件", "report": "生成报表"}
            log.info("开始%s...", labels[args.command])
            if args.command == "init":
                init_config()
            elif args.command == "fetch":
                config = load_config()
                add_secret(config.imap_auth_code.get_secret_value())
                fetch_emails(config, store)
            else:
                generate_report(store, "考勤汇总报表.xlsx")
            log.info("%s完成。", labels[args.command])
        return 0
    except KeyboardInterrupt:
        if logging_ready:
            log.warning("命令被用户中断，已保存的数据可在下次继续处理。")
        print("\n操作已中断。", file=sys.stderr)
        return 130
    except Exception as exc:
        # 兜底记录未预期异常与堆栈，返回失败退出码；授权码由 formatter 脱敏。
        if logging_ready:
            log.exception("命令 %s 执行失败。", args.command)
        if isinstance(exc, MVPError):
            message = str(exc)
        elif isinstance(exc, imaplib.IMAP4.error):
            message = "邮箱操作失败，请检查 IMAP 服务、授权码及连接状态。"
        elif isinstance(exc, (OSError, EOFError)):
            message = "网络或文件读写失败，请检查连接、权限、磁盘空间及文件占用。"
        else:
            message = "发生未处理异常，请查看 logs/agent.log。"
        if not logging_ready:
            message = "日志初始化失败，请检查 .env 编码和 logs 目录写入权限。"
        print("错误：" + redact(message), file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    sys.exit(main())
```

## src/__init__.py

```python
"""大学生照片打卡校验业务模块。"""
```

## scripts/__init__.py

```python
"""一次性数据迁移工具。"""
```

## cli.py

```python
"""旧命令入口，兼容 python cli.py init/fetch/report。"""

from src.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
```

## mvp_agent.py

```python
"""兼容旧 MVP 命令入口。"""

from src.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
```

## attendance.py

```python
"""兼容旧业务导入；新代码分别位于 src 对应模块。"""

from src.email_fetcher import *  # noqa: F403
from src.exif_validator import *  # noqa: F403
from src.report_generator import *  # noqa: F403
```

## config.py

```python
"""兼容旧导入；新实现位于 src/config.py。"""

from src.config import *  # noqa: F403
```

## common.py

```python
"""兼容旧导入；新实现位于 src/common.py。"""

from src.common import *  # noqa: F403
```

## logger.py

```python
"""兼容旧导入；新实现位于 src/logger.py。"""

from src.logger import *  # noqa: F403
```

## data_store.py

```python
"""兼容旧导入；新实现位于 src/data_store.py。"""

from src.data_store import *  # noqa: F403
```

## run.sh

```bash
#!/usr/bin/env bash
# 固定工作目录与 Python 环境，从任何目录启动都会使用本项目的配置和数据。
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
    printf '%s\n' '未找到项目虚拟环境。请按 README.md 的快速运行步骤安装。' >&2
    exit 1
fi

if [[ $# -eq 0 ]]; then
    set -- --help
fi

cd -- "$PROJECT_DIR"
if [[ "${1:-}" == "web" ]]; then
    shift
    exec "$PYTHON_BIN" -m streamlit run "$PROJECT_DIR/app.py" "$@"
fi
exec "$PYTHON_BIN" "$PROJECT_DIR/mvp_agent.py" "$@"
```

## .streamlit/config.toml

```toml
[theme]
base = "light"
primaryColor = "#216C53"
backgroundColor = "#F5F7F5"
secondaryBackgroundColor = "#EAF0EC"
textColor = "#183D33"
font = "sans serif"

[server]
address = "127.0.0.1"
headless = true

[browser]
gatherUsageStats = false
```

## .env.example

```dotenv
# QQ 邮箱 IMAP 授权码，不是 QQ 登录密码。
# 获取方法：QQ 邮箱网页版 → 设置 → 账户/账号与安全 → 开启 IMAP/SMTP → 生成授权码。
IMAP_AUTH_CODE=your_auth_code
```

## config.example.json

```json
{
  "email_account": "your_qq@qq.com",
  "target_lat": 39.9042,
  "target_lon": 116.4074,
  "threshold_meters": 200.0,
  "attendance_start": "",
  "attendance_end": "",
  "photo_timezone": "+08:00",
  "max_attachment_bytes": 10485760,
  "max_email_bytes": 26214400
}
```

## .gitignore

```gitignore
.venv/
__pycache__/
.pytest_cache/
config.json
state.json
records.csv
attachments/
*.xlsx
.mvp_agent.lock
.mvp-*
.env
.env.*
!.env.example
logs/
data/
.streamlit/secrets.toml
```

## Linux 部署与运行指南

### 仅本机访问

```bash
cd /path/to/attendance-bonus
.venv/bin/python -m streamlit run app.py --server.address=127.0.0.1 --server.port=8501
```

浏览器访问 `http://127.0.0.1:8501`。仓库默认配置也是仅监听本机。

### 允许其他 IP 访问

```bash
.venv/bin/python -m streamlit run app.py --server.address=0.0.0.0 --server.port=8501
```

也可以把 `.streamlit/config.toml` 中的对应值改为：

```toml
[server]
address = "0.0.0.0"
port = 8501
headless = true
```

其他电脑访问 `http://服务器实际IP:8501`，`0.0.0.0` 本身不是访问地址。
需要网络/防火墙允许 TCP 8501。此版本没有登录鉴权，外部访问应限定在可信内网，
或放在已有身份验证的反向代理之后。

### 使用 nohup 后台运行

```bash
cd /path/to/attendance-bonus
mkdir -p logs
nohup .venv/bin/python -m streamlit run app.py --server.address=0.0.0.0 --server.port=8501 > logs/web.log 2>&1 &
echo $! > logs/streamlit.pid
```

查看日志与健康状态：

```bash
tail -f logs/web.log
curl --fail http://127.0.0.1:8501/_stcore/health
```

健康接口返回 `ok`。停止本次后台进程：

```bash
kill "$(cat logs/streamlit.pid)"
```

也可以用 `screen -S attendance` 打开会话并执行启动命令；按 `Ctrl+A` 再按 `D` 脱离，
用 `screen -r attendance` 恢复。`nohup` 和 `screen` 都不提供开机自启。
备份时停止程序后复制整个 `data/`、`attachments/` 及本地配置，避免遗漏 SQLite WAL 文件。
