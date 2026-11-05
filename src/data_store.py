"""SQLite 考勤存储：短连接、参数化查询、来源去重、记录与进度原子提交。"""

from abc import ABC, abstractmethod
from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3
import time
from datetime import date

from .common import BASE_COLUMNS, COLUMNS, PHASH_COLUMNS, DUPLICATE_COLUMNS, DEFAULT_PHASH_THRESHOLD, MVPError
from .photo_deduplicator import DUPLICATE_STATUSES, compare_photo, validate_threshold
from .student_roster import normalize_students


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
        optional = {"photo_path", "exif_software", "software_check", *PHASH_COLUMNS, *DUPLICATE_COLUMNS}
        if not isinstance(record, dict) or set(COLUMNS) - optional - record.keys():
            raise MVPError("考勤记录缺少必要字段。")
        row = {key: "" if record.get(key) is None else str(record.get(key, "")) for key in COLUMNS}
        raw_threshold = record.get("duplicate_threshold")
        if raw_threshold is None or raw_threshold == "":
            raw_threshold = DEFAULT_PHASH_THRESHOLD
        try:
            if isinstance(raw_threshold, bool) or not re.fullmatch(r"[0-9]+", str(raw_threshold)):
                raise ValueError
            row["duplicate_threshold"] = validate_threshold(int(raw_threshold))
        except ValueError:
            raise MVPError("照片相似度阈值必须为 0 到 64 的整数。") from None
        # 比对结果由数据库事务生成，不信任 CSV 或调用方传入的历史关联。
        row.update(duplicate_status="未校验", duplicate_reason="", duplicate_record_id=None, duplicate_distance=None)
        row["software_check"] = row["software_check"] or "未校验"
        if not row["source_key"].strip():
            raise MVPError("考勤记录缺少来源标识，无法安全去重。")
        flag = row["is_valid"].strip().lower()
        if flag not in ("true", "false", "0", "1"):
            raise MVPError("is_valid 必须为 True/False 或 1/0。")
        row["is_valid"] = flag in ("true", "1")
        row["photo_phash"] = row["photo_phash"].lower()
        row["phash_status"] = row["phash_status"] or ("已计算" if row["photo_phash"] else "未计算")
        if row["photo_phash"] and not re.fullmatch(r"[0-9a-f]{16}", row["photo_phash"]):
            raise MVPError("照片 pHash 格式错误。")
        if (row["phash_status"] not in ("已计算", "校验异常", "未计算")
                or bool(row["photo_phash"]) != (row["phash_status"] == "已计算")):
            raise MVPError("照片 pHash 与计算状态不一致。")
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
            self._enable_wal(connection)
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
                CREATE TABLE IF NOT EXISTS students (
                    student_id TEXT PRIMARY KEY NOT NULL,
                    student_name TEXT NOT NULL,
                    class_name TEXT NOT NULL DEFAULT '',
                    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                CREATE TABLE IF NOT EXISTS teacher_attendance_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_id TEXT NOT NULL REFERENCES students(student_id),
                    attendance_day TEXT NOT NULL,
                    action TEXT NOT NULL CHECK(action IN ('请假', '老师代签', '撤销')),
                    reason TEXT NOT NULL,
                    teacher TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                CREATE INDEX IF NOT EXISTS idx_teacher_attendance_student_day
                    ON teacher_attendance_events(student_id, attendance_day, id);
            """)
            self._migrate_validation_columns(connection)

    @staticmethod
    def _enable_wal(connection):
        # 首次将旧库从 DELETE 切至 WAL 时，SQLite 可能立即返回 SQLITE_BUSY，
        # 不一定遵守 busy_timeout；仅对此锁竞争做有上限的重试。
        deadline = time.monotonic() + 10
        while True:
            try:
                connection.execute("PRAGMA journal_mode=WAL").fetchone()
                return
            except sqlite3.OperationalError as exc:
                code = getattr(exc, "sqlite_errorcode", 0) & 0xFF
                if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)

    @staticmethod
    def _migrate_validation_columns(connection):
        """持有写锁后检查字段；重复启动或多个 Web 会话初始化均可安全执行。"""
        connection.execute("BEGIN IMMEDIATE")
        student_columns = {row["name"] for row in connection.execute("PRAGMA table_info(students)")}
        if "class_name" not in student_columns:
            connection.execute("ALTER TABLE students ADD COLUMN class_name TEXT NOT NULL DEFAULT ''")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(attendance_records)")}
        # SQL 使用固定语句，既兼容旧库，也不覆盖历史结果或邮件进度。
        if "exif_software" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN exif_software TEXT NOT NULL DEFAULT ''")
        if "software_check" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN software_check TEXT NOT NULL DEFAULT '未校验'")
        if "photo_phash" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN photo_phash TEXT NOT NULL DEFAULT ''")
        if "phash_status" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN phash_status TEXT NOT NULL DEFAULT '未计算'")
        if "phash_reason" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN phash_reason TEXT NOT NULL DEFAULT ''")
        if "duplicate_status" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_status TEXT NOT NULL DEFAULT '未校验'")
        if "duplicate_reason" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_reason TEXT NOT NULL DEFAULT ''")
        if "duplicate_record_id" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_record_id INTEGER")
        if "duplicate_distance" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_distance INTEGER CHECK(duplicate_distance BETWEEN 0 AND 64)")
        if "duplicate_threshold" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_threshold INTEGER NOT NULL DEFAULT 5 CHECK(duplicate_threshold BETWEEN 0 AND 64)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_records_duplicate_status_id ON attendance_records(duplicate_status, id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_records_hashed_id ON attendance_records(id) WHERE phash_status = '已计算'")

    @contextmanager
    def _connection(self):
        connection = None
        try:
            # 每次操作独立连接，避免 Streamlit 多线程共用 connection。
            connection = sqlite3.connect(self.path, timeout=10)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=10000")
            connection.execute("PRAGMA foreign_keys=ON")
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

    @staticmethod
    def _compare(connection, row, before_id=None):
        # 调用者持有 BEGIN IMMEDIATE 写锁：比较与落库原子完成，防止并发提交互相漏判。
        if row["phash_status"] != "已计算":
            return compare_photo(row, [])
        sql = "SELECT id, source_key, photo_phash FROM attendance_records WHERE phash_status = '已计算'"
        params = []
        if before_id is not None:
            sql += " AND id < ?"
            params.append(before_id)
        candidates = connection.execute(sql + " ORDER BY id", params).fetchall()
        return compare_photo(row, candidates)

    @staticmethod
    def _save_comparison(connection, record_id, result):
        assignments = ", ".join(f"{key} = ?" for key in DUPLICATE_COLUMNS)
        connection.execute(f"UPDATE attendance_records SET {assignments} WHERE id = ?",
                           [*(result[key] for key in DUPLICATE_COLUMNS), record_id])

    def _insert(self, connection, records):
        inserted = 0
        columns = ", ".join(COLUMNS)
        placeholders = ", ".join("?" for _ in COLUMNS)
        for row in records:
            previous = connection.execute("SELECT * FROM attendance_records WHERE source_key = ?", (row["source_key"],)).fetchone()
            if previous is not None:
                old = self._decode(previous)
                if any(old[key] != row[key] for key in BASE_COLUMNS if key != "photo_path"):
                    raise MVPError("同一邮件来源存在内容冲突，本批数据未保存，请人工核对。")
                if not old["photo_path"] and row["photo_path"]:
                    connection.execute("UPDATE attendance_records SET photo_path = ? WHERE id = ?", (row["photo_path"], old["id"]))
                if old["photo_phash"] and row["photo_phash"] and old["photo_phash"] != row["photo_phash"]:
                    raise MVPError("同一邮件来源存在不同 pHash，本批数据未保存，请人工核对。")
                if ((old["phash_status"] == "未计算" and row["phash_status"] != "未计算")
                        or (old["phash_status"] == "校验异常" and row["phash_status"] == "已计算")):
                    connection.execute("UPDATE attendance_records SET photo_phash = ?, phash_status = ?, phash_reason = ? WHERE id = ?",
                                       [*(row[key] for key in PHASH_COLUMNS), old["id"]])
                    self._save_comparison(connection, old["id"], self._compare(connection, row, old["id"]))
                continue
            row.update(self._compare(connection, row))
            connection.execute(f"INSERT INTO attendance_records ({columns}) VALUES ({placeholders})", [row[key] for key in COLUMNS])
            inserted += 1
        return inserted

    def save_records(self, records: list) -> int:
        rows = normalize_records(records)
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self._insert(connection, rows)

    def commit_batch(self, records: list, checkpoint: dict) -> int:
        rows = normalize_records(records)
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
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

    def import_students(self, students: list) -> dict:
        """整批导入；同学号同姓名允许更新班级，未填班级不清空已有归属。"""
        rows = normalize_students(students)
        inserted = 0
        updated = 0
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for row in rows:
                previous = connection.execute("SELECT student_name, class_name FROM students WHERE student_id = ?",
                                              (row["student_id"],)).fetchone()
                if previous is not None:
                    if previous["student_name"] != row["student_name"]:
                        raise MVPError(f"学号 {row['student_id']} 与已有名单姓名冲突，本批名单未导入。")
                    if row["class_name"] and previous["class_name"] != row["class_name"]:
                        connection.execute("UPDATE students SET class_name = ? WHERE student_id = ?",
                                           (row["class_name"], row["student_id"]))
                        updated += 1
                    continue
                connection.execute("INSERT INTO students(student_id, student_name, class_name) VALUES (?, ?, ?)",
                                   (row["student_id"], row["student_name"], row["class_name"]))
                inserted += 1
            total = connection.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        return {"inserted": inserted, "updated": updated, "skipped": len(rows) - inserted - updated, "total": total}

    def load_students(self) -> list:
        with self._connection() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM students ORDER BY student_id")]

    @staticmethod
    def _validate_attendance_day(day):
        try:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError
        except (ValueError, TypeError):
            raise MVPError("考勤日期必须为 YYYY-MM-DD。") from None

    def record_teacher_attendance(self, student_id, day, action, reason, teacher):
        """追加人工考勤流水；同一天最后一条生效，撤销保留历史且不改照片记录。"""
        self._validate_attendance_day(day)
        if action not in ("请假", "老师代签", "撤销"):
            raise MVPError("人工考勤操作无效。")
        if not isinstance(student_id, str) or not student_id.strip():
            raise MVPError("请选择名单内学生。")
        if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 1000:
            raise MVPError("请填写 1～1000 字的原因。")
        if not isinstance(teacher, str) or not teacher.strip() or len(teacher.strip()) > 100:
            raise MVPError("请填写 1～100 字的经办老师姓名。")
        reason, teacher = reason.strip(), teacher.strip()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM students WHERE student_id = ?", (student_id,)).fetchone() is None:
                raise MVPError("该学生不在名单内，请先导入名单。")
            previous = connection.execute("""
                SELECT * FROM teacher_attendance_events WHERE student_id = ? AND attendance_day = ?
                ORDER BY id DESC LIMIT 1
            """, (student_id, day)).fetchone()
            if previous is not None and (previous["action"], previous["reason"], previous["teacher"]) == (action, reason, teacher):
                return dict(previous)
            if action == "撤销" and (previous is None or previous["action"] == "撤销"):
                raise MVPError("该学生当天没有可撤销的人工考勤记录。")
            cursor = connection.execute("""
                INSERT INTO teacher_attendance_events(student_id, attendance_day, action, reason, teacher)
                VALUES (?, ?, ?, ?, ?)
            """, (student_id, day, action, reason, teacher))
            result = dict(connection.execute("SELECT * FROM teacher_attendance_events WHERE id = ?",
                                             (cursor.lastrowid,)).fetchone())
        return result

    def teacher_attendance_history(self, student_id, day):
        self._validate_attendance_day(day)
        with self._connection() as connection:
            rows = connection.execute("""
                SELECT * FROM teacher_attendance_events WHERE student_id = ? AND attendance_day = ?
                ORDER BY id DESC
            """, (student_id, day)).fetchall()
        return [dict(row) for row in rows]

    def student_attendance(self, day: str, class_name: str | None = None) -> dict:
        """按北京时间收件日期汇总；多附件只计一人，姓名冲突不计为通过。"""
        self._validate_attendance_day(day)
        with self._connection() as connection:
            # 照片、名单与人工登记使用同一读事务快照，避免统计中途发生变化。
            connection.execute("BEGIN")
            rows = connection.execute("""
                SELECT s.student_id, s.student_name, s.class_name, COUNT(r.id) AS submission_count,
                       COALESCE(SUM(CASE WHEN r.student_name = s.student_name AND r.is_valid = 1
                                         THEN 1 ELSE 0 END), 0) AS valid_count,
                       COALESCE(SUM(CASE WHEN r.student_name != s.student_name THEN 1 ELSE 0 END), 0) AS mismatched_count,
                       GROUP_CONCAT(DISTINCT r.student_name) AS submitted_names,
                       GROUP_CONCAT(DISTINCT CASE WHEN r.is_valid = 0 THEN r.reason END) AS reasons,
                       MAX(datetime(r.email_time, '+8 hours')) AS latest_email_time
                FROM students s LEFT JOIN attendance_records r
                  ON s.student_id = r.student_id AND date(r.email_time, '+8 hours') = ?
                GROUP BY s.student_id, s.student_name, s.class_name ORDER BY s.class_name, s.student_id
            """, (day,)).fetchall()
            outsiders = connection.execute("""
                SELECT r.student_id, r.student_name, COUNT(*) AS submission_count
                FROM attendance_records r LEFT JOIN students s ON s.student_id = r.student_id
                WHERE s.student_id IS NULL AND date(r.email_time, '+8 hours') = ?
                GROUP BY r.student_id, r.student_name ORDER BY r.student_id
            """, (day,)).fetchall()
            events = connection.execute("""
                SELECT e.* FROM teacher_attendance_events e
                JOIN (SELECT student_id, MAX(id) AS last_id FROM teacher_attendance_events
                      WHERE attendance_day = ? GROUP BY student_id) latest ON latest.last_id = e.id
            """, (day,)).fetchall()
        manual = {event["student_id"]: dict(event) for event in events}
        details = []
        for stored in rows:
            row = dict(stored)
            if not row["submission_count"]:
                status, reason = "未提交", "所选日期未收到照片附件"
            elif row["mismatched_count"]:
                status, reason = "姓名不匹配", f"邮件填写姓名：{row['submitted_names']}"
            elif row["valid_count"]:
                status, reason = "校验通过", "至少一张照片通过基础校验"
            else:
                status, reason = "未通过", row["reasons"] or "待人工核验"
            row.update(base_status=status, base_reason=reason,
                       teacher="", manual_reason="", manual_created_at="", manual_action="")
            event = manual.get(row["student_id"])
            if event is not None and event["action"] != "撤销":
                status, reason = event["action"], event["reason"]
                row.update(teacher=event["teacher"], manual_reason=event["reason"],
                           manual_created_at=event["created_at"], manual_action=event["action"])
            row.update(status=status, reason=reason, latest_email_time=row["latest_email_time"] or "")
            details.append(row)
        if class_name is not None:
            details = [row for row in details if row["class_name"] == class_name]

        def counts(students):
            return {"total": len(students), "submitted": sum(row["submission_count"] > 0 for row in students),
                    "passed": sum(row["status"] == "校验通过" for row in students),
                    "signed": sum(row["status"] == "老师代签" for row in students),
                    "leave": sum(row["status"] == "请假" for row in students),
                    "present": sum(row["status"] in ("校验通过", "老师代签") for row in students),
                    "pending": sum(row["status"] in ("姓名不匹配", "未通过") for row in students),
                    "missing": sum(row["status"] == "未提交" for row in students)}

        grouped = {}
        for row in details:
            grouped.setdefault(row["class_name"], []).append(row)
        classes = [{"class_name": name, **counts(students)} for name, students in sorted(grouped.items())]
        return {"statistics": counts(details), "students": details, "classes": classes,
                "outsiders": [dict(row) for row in outsiders]}

    @staticmethod
    def _filters(is_valid=None, duplicate_status=None):
        if is_valid is not None and type(is_valid) is not bool:
            raise MVPError("校验结果筛选参数错误。")
        if duplicate_status is not None and duplicate_status not in DUPLICATE_STATUSES:
            raise MVPError("重复判定筛选参数错误。")
        clauses, params = [], []
        if is_valid is not None:
            clauses.append("is_valid = ?")
            params.append(int(is_valid))
        if duplicate_status is not None:
            clauses.append("duplicate_status = ?")
            params.append(duplicate_status)
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), params

    def count_records(self, is_valid=None, duplicate_status=None):
        where, params = self._filters(is_valid, duplicate_status)
        with self._connection() as connection:
            return connection.execute("SELECT COUNT(*) FROM attendance_records" + where, params).fetchone()[0]

    def get_record(self, record_id):
        if type(record_id) is not int or record_id < 1:
            raise MVPError("记录编号错误。")
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM attendance_records WHERE id = ?", (record_id,)).fetchone()
        return self._decode(row) if row is not None else None

    def recheck_duplicates(self, threshold=DEFAULT_PHASH_THRESHOLD, progress=None):
        """按入库顺序重新比对已有哈希；不重算照片、不修改 EXIF 结果或邮件游标。"""
        try:
            validate_threshold(threshold)
        except ValueError as exc:
            raise MVPError(str(exc)) from None
        counts = {status: 0 for status in DUPLICATE_STATUSES}
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT * FROM attendance_records ORDER BY id").fetchall()
            for index, stored in enumerate(rows, 1):
                row = {**dict(stored), "duplicate_threshold": threshold}
                result = self._compare(connection, row, row["id"])
                self._save_comparison(connection, row["id"], result)
                counts[result["duplicate_status"]] += 1
                if progress:
                    progress(index, len(rows))
        return counts

    def query_records(self, is_valid=None, limit=200, offset=0, duplicate_status=None) -> list:
        where, params = self._filters(is_valid, duplicate_status)
        if type(limit) is not int or not 1 <= limit <= 1000 or type(offset) is not int or offset < 0:
            raise MVPError("分页参数错误。")
        with self._connection() as connection:
            rows = connection.execute("SELECT * FROM attendance_records" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
                                      [*params, limit, offset]).fetchall()
        return [self._decode(row) for row in rows]
