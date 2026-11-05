# EXIF Software 软件信息校验

已接入现有 Streamlit / SQLite 模块化架构。无需安装新的第三方库；
`requirements.txt` 中已有的 `exifread>=3.0,<4` 负责读取 Software 标签。

## 业务行为

- 读取 `Image Software`，同时兼容 `EXIF Software`，保留标签原文。
- 对标签统一全半角、忽略大小写、移除空白和空字符后匹配关键词。
- 禁用关键词：`美图秀秀`、`美圖秀秀`、`meitu`、`xiuxiu`、`p图软件`、`p圖軟件`、
  `photoshop`、`picsart`、`snapseed`、`gimp`、`lightroom`、`虚拟相机`、`虛擬相機`、
  `virtualcamera`、`virtualcam`。包含版本号的标签也能命中。
- 命中时 `is_valid=False`，`software_check` 与总原因记录命中关键词，直接返回。
- Software 缺失时记录“未提供Software标签”，不单凭缺失判无效，继续原有 GPS / 时间校验。
- Software 存在且未命中时记录“未命中禁用软件”，继续原有 GPS / 时间校验。
- Software 读取或 EXIF 解析出错时记录异常堆栈到现有 `logs/agent.log`，
  将该附件标为无效且原因包含“校验异常”，继续处理后续附件和邮件。
- 文件打开、附件落盘、数据库写入等原有基础设施错误处理保持不变，以支持失败重试。
- 关键词匹配仅验证元数据；标签缺失或未命中不代表照片未被编辑。

## 数据库升级

增加两个字段：`exif_software`（Software 原文）与 `software_check`（软件校验结果）。
`SqliteDataStore` 初始化时在 `BEGIN IMMEDIATE` 写事务内读取
`PRAGMA table_info(attendance_records)`，只对缺少的字段执行固定 ALTER 语句。
支持重复启动、部分字段已存在，以及多个会话并发初始化。

```sql
BEGIN IMMEDIATE;
PRAGMA table_info(attendance_records);
-- Python 根据上述字段列表，只执行缺失字段对应的 ALTER：
ALTER TABLE attendance_records ADD COLUMN exif_software TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_records ADD COLUMN software_check TEXT NOT NULL DEFAULT '未校验';
COMMIT;
```

SQLite 的 `ADD COLUMN` 不支持通用的 `IF NOT EXISTS`；上述 SQL 展示实际迁移语句，
重复运行请使用下方 Python 初始化入口，由程序检查字段后再执行 ALTER。

```bash
.venv/bin/python -c 'from src.data_store import SqliteDataStore; SqliteDataStore()'
```

正常启动 Web 或 CLI 也会自动执行相同迁移。历史记录保留原结果、ID、入库时间与
邮件进度，新字段为 `exif_software=''`、`software_check='未校验'`。
旧 CSV 导入和旧调用者可以省略新增字段，归一化时自动补齐。
已处理附件不会因升级重新拉取或重新校验。

## 页面与报表

`app.py` 明细新增“EXIF 软件信息”“软件校验结果”。Excel 附件明细新增
`exif_software`、`software_check`，保留原有列顺序，字段追加到末尾；
学生汇总仍依照原有 `is_valid` 规则统计。

## 验证

```bash
.venv/bin/python -m unittest discover -v
```

50 项测试通过，覆盖真实 Software EXIF、缺失标签、大小写和全半角、原有 GPS /
时间校验、异常日志及后续附件继续入库、旧库并发迁移、SQLite 往返、Excel 输出与
Streamlit 官方 AppTest 页面操作。邮件测试使用离线 IMAP 样本。

## 完整代码

以下是本次涉及的全部 Python 文件与依赖清单的完整内容。

### `requirements.txt`

```text
# EXIF Software 标签校验复用 ExifRead，无新增第三方依赖。
exifread>=3.0,<4
pandas>=2.2,<4
openpyxl>=3.1,<4
pydantic>=2.12,<3
python-dotenv>=1.1,<2
streamlit>=1.50,<2
```

### `src/common.py`

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
    "exif_software", "software_check",
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

### `src/exif_validator.py`

```python
"""JPEG EXIF 解析与软件信息、坐标、拍摄时间校验。"""

from datetime import datetime
import logging
import math
from pathlib import Path
import unicodedata

from .common import MVPError
from .config import AppConfig, parse_timezone

log = logging.getLogger(__name__)

# 子串匹配兼容版本号；先统一大小写、全半角和空白。
BLOCKED_SOFTWARE = (
    "美图秀秀", "美圖秀秀", "meitu", "xiuxiu",
    "p图软件", "p圖軟件", "photoshop", "picsart", "snapseed", "gimp", "lightroom",
    "虚拟相机", "虛擬相機", "virtualcamera", "virtualcam",
)


def check_software(tags):
    """返回原始 Software 文本和结果；缺失标签不替代原有 GPS/时间校验。"""
    values = [str(tags[key]).strip("\x00 \t\r\n") for key in ("Image Software", "EXIF Software")
              if key in tags]
    software = " / ".join(value for value in values if value)
    if not software:
        return "", "未提供Software标签"
    normalized = "".join(character for character in unicodedata.normalize("NFKC", software).casefold()
                         if not character.isspace() and character != "\x00")
    for keyword in BLOCKED_SOFTWARE:
        if keyword in normalized:
            return software, f"未通过：命中禁用软件（{keyword}）"
    return software, "未命中禁用软件"


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

    result = dict(exif_lat="", exif_lon="", shoot_time="", distance="", is_valid=False, reason="",
                  exif_software="", software_check="未校验")
    # 保留原有文件打开失败行为；解析器（包括其 OSError）异常只影响当前附件。
    with Path(path).open("rb") as stream:
        try:
            tags = exifread.process_file(stream, details=False, strict=True)
        except Exception:
            log.exception("照片或 EXIF 解析异常，附件 %s 转人工核验。", Path(path).name)
            result.update(reason="校验异常：照片或EXIF解析失败，待人工核验", software_check="校验异常：EXIF解析失败")
            return result
    try:
        software, status = check_software(tags)
        result.update(exif_software=software, software_check=status)
    except Exception:
        log.exception("Software 标签校验异常，附件 %s 转人工核验。", Path(path).name)
        result.update(reason="校验异常：Software标签读取失败，待人工核验", software_check="校验异常：Software标签读取失败")
        return result
    if status.startswith("未通过"):
        result["reason"] = f"软件信息校验{status}"
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

### `src/data_store.py`

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
        optional = {"photo_path", "exif_software", "software_check"}
        if not isinstance(record, dict) or set(COLUMNS) - optional - record.keys():
            raise MVPError("考勤记录缺少必要字段。")
        row = {key: "" if record.get(key) is None else str(record.get(key, "")) for key in COLUMNS}
        row["software_check"] = row["software_check"] or "未校验"
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
            self._migrate_software_columns(connection)

    @staticmethod
    def _migrate_software_columns(connection):
        """持有写锁后检查字段；重复启动或多个 Web 会话初始化均可安全执行。"""
        connection.execute("BEGIN IMMEDIATE")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(attendance_records)")}
        # SQL 使用固定语句，既兼容旧库，也不覆盖历史结果或邮件进度。
        if "exif_software" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN exif_software TEXT NOT NULL DEFAULT ''")
        if "software_check" not in columns:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN software_check TEXT NOT NULL DEFAULT '未校验'")

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

### `src/email_fetcher.py`

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
                   software_check="未校验",
                   validation_scope="软件信息、坐标及拍摄时间校验" if config.window else "软件信息及坐标校验，未校验拍摄时间")
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
            log.info("当前校验照片软件信息及坐标，未校验拍摄时间；结果不证明本人到场。")
        return {"emails": len(uids), "records": total}
    finally:
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                log.warning("邮箱退出失败；已保存的记录和进度不受影响。")
```

### `src/report_generator.py`

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
        width = 36 if column == status_column or header in ("reason", "validation_scope", "software_check", "exif_software", "校验说明") else 23
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
        "exif_software 为 Software 标签原文，software_check 为软件校验结果；历史记录未自动重新校验。",
        "Software 缺失或未命中禁用关键词不能证明照片未经编辑；命中禁用软件时自动判为无效。",
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

### `app.py`

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
                st.caption("开始与结束均留空时，校验照片软件信息及坐标。")
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
                 "exif_lat": "照片纬度", "exif_lon": "照片经度", "created_at": "入库时间",
                 "exif_software": "EXIF 软件信息", "software_check": "软件校验结果"}
        visible = ["id", "student_id", "student_name", "校验结果", "distance", "reason", "email_time",
                   "software_check", "exif_software", "shoot_time", "photo_name", "exif_lat", "exif_lon", "created_at"]
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

### `tests/helpers.py`

```python
"""真实 EXIF 字节样本与离线 IMAP 服务。"""

from email.message import EmailMessage
import struct


def exif_jpeg(lat=(39, 54, 15.12), lon=(116, 24, 26.64), refs=("N", "E"),
              shoot="2026:11:05 08:30:00", offset="+08:00", zero_denominator=False,
              software=None):
    """手工构造含 GPS/拍摄时间 IFD 的 JPEG 元数据样本，不模拟 EXIF 解析器。"""
    shift = 12 if software is not None else 0
    gps_at, exif_at, data_at = 38 + shift, 92 + shift, 122 + shift
    extra = bytearray()

    def field(tag, kind, count, value):
        return struct.pack("<HHI", tag, kind, count) + value.ljust(4, b"\0")

    def reference(tag, kind, count, payload):
        # TIFF 不超过四字节的字段直接内联，而不是写数据区指针。
        if len(payload) <= 4:
            return field(tag, kind, count, payload)
        pointer = data_at + len(extra)
        extra.extend(payload)
        return field(tag, kind, count, struct.pack("<I", pointer))

    def rationals(values):
        return b"".join(struct.pack("<II", round(value * 10000),
                                    0 if zero_denominator else 10000) for value in values)

    root = struct.pack("<H", 2 + (software is not None))
    if software is not None:
        payload = software.encode("utf-8") + b"\0"
        root += reference(0x0131, 2, len(payload), payload)
    root += field(0x8769, 4, 1, struct.pack("<I", exif_at))
    root += field(0x8825, 4, 1, struct.pack("<I", gps_at)) + b"\0" * 4
    gps = struct.pack("<H", 4)
    gps += field(1, 2, 2, refs[0].encode() + b"\0")
    gps += reference(2, 5, 3, rationals(lat))
    gps += field(3, 2, 2, refs[1].encode() + b"\0")
    gps += reference(4, 5, 3, rationals(lon)) + b"\0" * 4
    exif = struct.pack("<H", 2)
    exif += reference(0x9003, 2, len(shoot) + 1, shoot.encode() + b"\0")
    exif += reference(0x9011, 2, len(offset) + 1, offset.encode() + b"\0") + b"\0" * 4
    tiff = b"II\x2a\0\x08\0\0\0" + root + gps + exif + extra
    payload = b"Exif\0\0" + tiff
    return b"\xff\xd8\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload + b"\xff\xd9"



def message_bytes(subject="【打卡】0020230001-张三", photos=None):
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = "student@example.com"
    message["Date"] = "Mon, 01 Jan 2001 00:00:00 +0000"  # 故意伪造 Date。
    message.set_content("打卡提交")
    for name, payload in photos if photos is not None else [("photo.jpg", exif_jpeg())]:
        message.add_attachment(payload, maintype="image", subtype="jpeg", filename=name)
    return message.as_bytes()



class FakeIMAP:
    def __init__(self, messages, validity=b"101"):
        self.messages = messages
        self.validity = validity
        self.calls = []
        self.logged_out = False

    def login(self, account, auth):
        return "OK", []

    def select(self, folder, readonly=False):
        if not readonly:
            raise AssertionError("必须只读打开邮箱")
        return "OK", [str(len(self.messages)).encode()]

    def response(self, key):
        return key, [self.validity]

    def uid(self, operation, *args):
        self.calls.append((operation, args))
        if operation == "SEARCH":
            return "OK", [b" ".join(str(uid).encode() for uid in self.messages)]
        uid = int(args[0])
        raw = self.messages[uid]
        if args[1] == "(RFC822.SIZE)":
            return "OK", [f"1 (UID {uid} RFC822.SIZE {len(raw)})".encode()]
        if args[1] != "(BODY.PEEK[] INTERNALDATE)":
            raise AssertionError("必须使用 BODY.PEEK[]，避免改变已读状态")
        meta = f'1 (UID {uid} INTERNALDATE "05-Nov-2026 08:05:00 +0800" BODY[] {{{len(raw)}}}'.encode()
        return "OK", [(meta, raw), b")"]

    def logout(self):
        self.logged_out = True
```

### `tests/test_software_validation.py`

```python
"""Software 校验、历史数据库升级与逐附件异常隔离。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from src.config import AppConfig, DEFAULT_CONFIG
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.exif_validator import evaluate_photo
from src.report_generator import generate_report
from tests.helpers import FakeIMAP, exif_jpeg, message_bytes
from tests.test_sqlite import record


class SoftwareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config = AppConfig(**{**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "imap_auth_code": "secret"})

    def evaluate(self, software=None, **options):
        path = self.folder / "photo.jpg"
        path.write_bytes(exif_jpeg(software=software, **options))
        return evaluate_photo(path, self.config)

    def test_real_software_tags_reject_editors_and_virtual_cameras(self):
        for software in ("美图秀秀", "P图软件 1.0", "虚拟相机", "Meitu XiuXiu 10.0",
                         "Adobe Photoshop 2026", "Virtual Camera 2.0", "ＶＩＲＴＵＡＬ ＣＡＭＥＲＡ", "pHoToShOp"):
            with self.subTest(software=software):
                row = self.evaluate(software)
                self.assertFalse(row["is_valid"])
                self.assertEqual(row["exif_software"], software)
                self.assertIn("命中禁用软件", row["software_check"])
                self.assertIn("软件信息校验未通过", row["reason"])

    def test_missing_empty_or_camera_software_keeps_original_checks(self):
        for software in (None, "", "iOS 18.0", "Android Camera"):
            with self.subTest(software=software):
                self.assertTrue(self.evaluate(software)["is_valid"])
                self.assertFalse(self.evaluate(software, lat=(40, 0, 0))["is_valid"])
        self.assertEqual(self.evaluate()["software_check"], "未提供Software标签")
        self.config = AppConfig(**{**self.config.model_dump(), "imap_auth_code": "secret",
                                   "attendance_start": "2026-11-05T09:00:00+08:00",
                                   "attendance_end": "2026-11-05T10:00:00+08:00"})
        self.assertIn("拍摄时间不在", self.evaluate("iOS 18.0")["reason"])

    def test_software_tag_failure_is_logged_and_next_attachment_still_commits(self):
        class BrokenTag:
            def __str__(self):
                raise RuntimeError("broken software value")

        import exifread
        original = exifread.process_file
        count = 0

        def process(*args, **kwargs):
            nonlocal count
            count += 1
            tags = original(*args, **kwargs)
            if count == 1:
                tags["Image Software"] = BrokenTag()
            return tags

        store = SqliteDataStore(self.folder / "test.db")
        messages = {10: message_bytes(photos=[("bad.jpg", exif_jpeg()), ("good.jpg", exif_jpeg())]),
                    11: message_bytes()}
        server = FakeIMAP(messages)
        with patch("exifread.process_file", side_effect=process), self.assertLogs("src.exif_validator", level="ERROR") as logs:
            with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=server):
                result = fetch_emails(self.config, store, self.folder)
        self.assertEqual(result, {"emails": 2, "records": 3})
        rows = store.load_records()
        self.assertEqual([row["is_valid"] for row in rows], [False, True, True])
        self.assertIn("校验异常", rows[0]["software_check"])
        self.assertIn("校验异常", rows[0]["reason"])
        self.assertIn("Traceback", "\n".join(logs.output))
        self.assertEqual(store.load_checkpoint()["last_uid"], 11)
        self.assertTrue(server.logged_out)

    def test_parser_errors_do_not_escape_validation(self):
        for error in (ValueError("corrupt EXIF"), OSError("parser failure")):
            with self.subTest(error=error), patch("exifread.process_file", side_effect=error):
                with self.assertLogs("src.exif_validator", level="ERROR"):
                    row = self.evaluate()
                self.assertFalse(row["is_valid"])
                self.assertIn("校验异常", row["reason"])

    def test_old_schema_upgrade_preserves_rows_and_checkpoint_and_is_repeatable(self):
        path = self.folder / "old.db"
        # 使用升级前的字段集合创建真实旧库，保留唯一约束和旧邮件进度。
        old_columns = list(record())
        with closing(sqlite3.connect(path)) as connection, connection:
            definitions = [f'"{key}" {"INTEGER" if key == "is_valid" else "TEXT"}' for key in old_columns]
            connection.execute("CREATE TABLE attendance_records (id INTEGER PRIMARY KEY, " +
                               ", ".join(definitions) + ", created_at TEXT DEFAULT 'old-time', UNIQUE(source_key))")
            connection.execute("INSERT INTO attendance_records (" + ", ".join(old_columns) + ") VALUES (" +
                               ", ".join("?" for _ in old_columns) + ")", list(record().values()))
            connection.execute("CREATE TABLE mail_checkpoint (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute('INSERT INTO mail_checkpoint VALUES (1, ?)',
                               ('{"account":"teacher@qq.com","mailbox":"INBOX","uidvalidity":"101","last_uid":10}',))
        with ThreadPoolExecutor(max_workers=4) as pool:
            stores = list(pool.map(lambda _: SqliteDataStore(path), range(4)))
        store = stores[0]
        row = store.load_records()[0]
        self.assertEqual(row["created_at"], "old-time")
        self.assertEqual(row["software_check"], "未校验")
        self.assertEqual(row["exif_software"], "")
        self.assertTrue(row["is_valid"])
        self.assertEqual(store.load_checkpoint()["last_uid"], 10)
        self.assertEqual(len(SqliteDataStore(path).load_records()), 1)

    def test_software_results_roundtrip_and_excel_export(self):
        store = SqliteDataStore(self.folder / "test.db")
        row = {**record(), **self.evaluate("美图秀秀")}
        self.assertEqual(store.save_records([row]), 1)
        self.assertEqual(store.save_records([row]), 0)
        self.assertEqual(store.load_records()[0]["exif_software"], "美图秀秀")
        workbook = load_workbook(BytesIO(generate_report(store)))
        self.addCleanup(workbook.close)
        sheet = workbook["附件明细"]
        headers = [cell.value for cell in sheet[1]]
        self.assertEqual(sheet.cell(2, headers.index("exif_software") + 1).value, "美图秀秀")
        self.assertIn("未通过", sheet.cell(2, headers.index("software_check") + 1).value)


if __name__ == "__main__":
    unittest.main()
```

### `tests/test_web.py`

```python
"""使用 Streamlit 官方 AppTest 实际操作表单、筛选、拉取与报表。"""

from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dotenv import dotenv_values
from openpyxl import load_workbook
from PIL import Image
from streamlit.testing.v1 import AppTest

from src.common import MVPError, read_json, save_json
from src.config import DEFAULT_CONFIG, save_config
from src.data_store import SqliteDataStore
from src.logger import close_logging
from tests.helpers import FakeIMAP, exif_jpeg, message_bytes
from tests.test_sqlite import record


ROOT = Path(__file__).resolve().parents[1]


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(close_logging)
        self.folder = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")
        self.app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=20)

    def configured(self):
        save_json(self.folder / "config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com"})
        (self.folder / ".env").write_text("IMAP_AUTH_CODE=WEB-SECRET\nOTHER=keep\n", encoding="utf-8")

    def run_app(self):
        self.app.run()
        self.assertEqual(len(self.app.exception), 0)

    def button(self, label):
        return next(button for button in self.app.button if button.label == label)

    def input(self, label):
        return next(value for value in self.app.text_input if value.label == label)

    def test_initial_empty_state_and_metrics(self):
        self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["0", "0", "0"])
        self.assertTrue(self.app.info)
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_pagination_and_filter_reset(self):
        self.store.save_records([record(f"source:{number}") for number in range(205)])
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 200)
        self.app.number_input(key="page").set_value(2)
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 5)
        self.app.selectbox(key="result_filter").select("无效")
        self.run_app()
        self.assertEqual(self.app.number_input(key="page").value, 1)
        self.assertTrue(self.app.info)

    def test_save_configuration_and_preserve_hidden_secret(self):
        self.configured()
        self.run_app()
        self.input("目标纬度").set_value("31.2304")
        self.input("目标经度").set_value("121.4737")
        self.input("距离阈值（米）").set_value("100")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.success)
        config = read_json(self.folder / "config.json")
        self.assertEqual(config["target_lat"], 31.2304)
        self.assertNotIn("imap_auth_code", config)
        self.assertEqual(dotenv_values(self.folder / ".env")["IMAP_AUTH_CODE"], "WEB-SECRET")
        self.assertEqual(dotenv_values(self.folder / ".env")["OTHER"], "keep")
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_first_time_configuration_and_invalid_form_does_not_write(self):
        self.run_app()
        self.input("QQ 邮箱").set_value("teacher@qq.com")
        self.input("QQ 邮箱授权码").set_value("NEW-WEB-SECRET")
        self.input("目标纬度").set_value("91")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.error)
        self.assertFalse((self.folder / "config.json").exists())
        self.input("目标纬度").set_value("39.9042")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.success)
        self.assertEqual(dotenv_values(self.folder / ".env")["IMAP_AUTH_CODE"], "NEW-WEB-SECRET")
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_filter_metrics_missing_photo_and_excel_download(self):
        self.store.save_records([record("valid"), {**record("invalid", False), "exif_software": "美图秀秀",
                                                  "software_check": "未通过：命中禁用软件（美图秀秀）"}])
        self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["2", "1", "1"])
        self.app.selectbox(key="result_filter").select("无效")
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 1)
        self.assertEqual(self.app.dataframe[0].value.iloc[0]["校验结果"], "无效")
        self.assertEqual(self.app.dataframe[0].value.iloc[0]["EXIF 软件信息"], "美图秀秀")
        self.assertIn("命中禁用软件", self.app.dataframe[0].value.iloc[0]["软件校验结果"])
        self.assertTrue(any("没有可预览" in value.value for value in self.app.warning))
        self.button("生成并下载报表").click()
        self.run_app()
        workbook = load_workbook(BytesIO(self.app.session_state["report_bytes"]))
        self.addCleanup(workbook.close)
        self.assertEqual(workbook["附件明细"].max_row, 3)
        self.assertEqual(len(self.app.get("download_button")), 1)

    def test_pull_calls_real_pipeline_and_refreshes_metrics(self):
        self.configured()
        self.run_app()
        sample = exif_jpeg()
        length = int.from_bytes(sample[4:6], "big")
        photo = BytesIO()
        Image.new("RGB", (8, 8), "green").save(photo, format="JPEG", exif=sample[6:6 + length - 2])
        message = message_bytes(photos=[("photo.jpg", photo.getvalue())])
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=FakeIMAP({10: message})):
            self.button("一键拉取并校验").click()
            self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["1", "1", "0"])
        self.assertTrue(any("新增 1 条记录" in value.value for value in self.app.success))
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 10)
        self.assertFalse(self.app.error)

    def test_mail_and_database_errors_are_shown_without_page_crash(self):
        self.configured()
        self.run_app()
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", side_effect=OSError("network WEB-SECRET")):
            self.button("一键拉取并校验").click()
            self.run_app()
        self.assertTrue(any("邮件拉取失败" in value.value for value in self.app.error))
        self.assertNotIn("WEB-SECRET", (self.folder / "logs/agent.log").read_text())
        with patch.object(SqliteDataStore, "statistics", side_effect=MVPError("数据库暂不可用")):
            self.run_app()
        self.assertTrue(any("数据库暂不可用" in value.value for value in self.app.error))

    def test_config_write_failure_restores_both_files(self):
        self.configured()
        old = [(self.folder / path).read_bytes() for path in ("config.json", ".env")]
        original_replace = os.replace
        failed = False

        def fail_once(source, target):
            nonlocal failed
            if Path(target).name == ".env" and not failed:
                failed = True
                raise OSError("写入失败")
            return original_replace(source, target)

        with patch("src.common.os.replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                save_config({"threshold_meters": 100}, "REPLACEMENT", self.folder)
        self.assertEqual(old, [(self.folder / path).read_bytes() for path in ("config.json", ".env")])


if __name__ == "__main__":
    unittest.main()
```
