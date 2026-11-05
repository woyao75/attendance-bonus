> 此文档记录首次 pHash 计算功能的历史版本。当前已增加相似度比对与重复判定；请使用 [最新完整代码与说明](PHOTO_DEDUPLICATION.md)，勿用下列历史代码覆盖当前实现。

# 照片 pHash 计算：完整实现

按业务规则实现“照片保存后计算 pHash”，保留原有 Software、EXIF、坐标及时间校验。
不执行相似度比较，不自动认定照片重复或作弊。

- `photo_phash`：64 位 pHash 的 16 位十六进制字符串，失败时为空。
- `phash_status`：已计算 / 校验异常 / 未计算。
- `phash_reason`：异常或未执行原因。

pHash 计算异常独立记录，基础 `is_valid` 和 `reason` 保留原含义。
历史记录自动补列后显示未计算，不自动回填，不改变编号、入库时间和邮件进度。

## 新增依赖与安装

```text
ImageHash>=4.3,<5
Pillow>=10,<14
```

ImageHash 的 SciPy、PyWavelets 等计算依赖由 pip 自动安装。

```bash
.venv/bin/python -m pip install -r requirements.txt
```

以下按文件路径给出全部修改/新增 Python 文件和更新后的依赖清单。

## requirements.txt

```text
# EXIF Software 标签校验复用 ExifRead，无新增第三方依赖。
exifread>=3.0,<4
pandas>=2.2,<4
openpyxl>=3.1,<4
pydantic>=2.12,<3
python-dotenv>=1.1,<2
streamlit>=1.50,<2
ImageHash>=4.3,<5
Pillow>=10,<14
```

## src/common.py

```python
"""共享记录字段、异常和原子文件操作，不依赖具体考勤存储实现。"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile


BASE_COLUMNS = [
    "student_id", "student_name", "email_time", "photo_name", "exif_lat",
    "exif_lon", "shoot_time", "distance", "is_valid", "reason",
    "source_key", "attendance_window", "validation_scope", "photo_path",
    "exif_software", "software_check",
]
PHASH_COLUMNS = ["photo_phash", "phash_status", "phash_reason"]
COLUMNS = BASE_COLUMNS + PHASH_COLUMNS
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

## src/exif_validator.py

```python
"""JPEG EXIF 解析与软件信息、坐标、拍摄时间校验。"""

from datetime import datetime
import logging
import math
from pathlib import Path
import re
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


def calculate_photo_phash(path) -> dict:
    """计算 64 位 pHash；失败只标记此项，不覆盖现有 EXIF/软件检查结果。"""
    try:
        # 延迟导入也受保护，缺少依赖或底层库故障不会中断整个拉取任务。
        import imagehash
        from PIL import Image, ImageOps

        with Image.open(path) as image:
            image.load()  # 完整解码，捕获损坏/截断的照片。
            with ImageOps.exif_transpose(image) as oriented:
                value = str(imagehash.phash(oriented, hash_size=8)).lower()
        if not re.fullmatch(r"[0-9a-f]{16}", value):
            raise ValueError("pHash 返回值不是 64 位十六进制哈希")
        return {"photo_phash": value, "phash_status": "已计算", "phash_reason": ""}
    except Exception:
        log.exception("照片 pHash 计算失败，当前记录标记为校验异常，继续处理后续附件。")
        return {"photo_phash": "", "phash_status": "校验异常",
                "phash_reason": "无法读取照片或计算 pHash，请人工核验"}


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
from .exif_validator import calculate_photo_phash, evaluate_photo

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
        row.update(phash_status="未计算", phash_reason="附件未保存，未计算 pHash")
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
            row.update(calculate_photo_phash(target))
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

## src/data_store.py

```python
"""SQLite 考勤存储：短连接、参数化查询、来源去重、记录与进度原子提交。"""

from abc import ABC, abstractmethod
from contextlib import contextmanager
import json
import math
from pathlib import Path
import re
import sqlite3

from .common import BASE_COLUMNS, COLUMNS, PHASH_COLUMNS, MVPError


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
        optional = {"photo_path", "exif_software", "software_check", *PHASH_COLUMNS}
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
            self._migrate_validation_columns(connection)

    @staticmethod
    def _migrate_validation_columns(connection):
        """持有写锁后检查字段；重复启动或多个 Web 会话初始化均可安全执行。"""
        connection.execute("BEGIN IMMEDIATE")
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
    st.caption("指标及筛选沿用基础校验结果；pHash 计算异常单独显示，不代表重复照片或作弊。")
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
                 "exif_software": "EXIF 软件信息", "software_check": "软件校验结果",
                 "photo_phash": "照片 pHash", "phash_status": "pHash 计算结果", "phash_reason": "pHash 异常原因"}
        visible = ["id", "student_id", "student_name", "校验结果", "distance", "reason", "email_time",
                   "software_check", "exif_software", "phash_status", "phash_reason", "photo_phash",
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
        if selected.get("phash_status") == "校验异常":
            st.warning(selected.get("phash_reason") or "pHash 计算异常，请人工核验。")


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

## scripts/migrate_phash_schema.py

```python
#!/usr/bin/env python3
"""安全升级 pHash 表结构，支持重复执行，不回填历史照片。"""

import argparse
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.data_store import SqliteDataStore
from src.logger import close_logging, setup_logging


def main(argv=None):
    parser = argparse.ArgumentParser(description="检测并补全 pHash 字段，保留所有历史数据及邮件进度。")
    parser.add_argument("--db", type=Path, default=ROOT / "data/attendance.db")
    args = parser.parse_args(argv)
    try:
        setup_logging(ROOT / "logs", ROOT / ".env")
        SqliteDataStore(args.db)
        print("pHash 字段已就绪。历史记录标为未计算，原有校验结果与邮件进度已保留。")
        return 0
    except Exception:
        logging.getLogger(__name__).exception("pHash 表结构升级失败。")
        print("升级失败，请检查数据库权限或稍后重试，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
```

## tests/test_phash.py

```python
"""pHash 真图、异常隔离、旧数据库升级及 UI/报表联动。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import imagehash
from openpyxl import load_workbook
from PIL import Image, ImageDraw
from streamlit.testing.v1 import AppTest

from src.common import BASE_COLUMNS, PHASH_COLUMNS, MVPError, save_json
from src.config import DEFAULT_CONFIG, load_config
from src.data_store import SqliteDataStore, normalize_records
from src.email_fetcher import fetch_emails
from src.exif_validator import calculate_photo_phash
from src.logger import close_logging
from src.report_generator import generate_report
from tests.helpers import exif_jpeg, FakeIMAP, message_bytes
from tests.test_sqlite import record


ROOT = Path(__file__).resolve().parents[1]


def jpeg_bytes():
    sample = exif_jpeg()
    length = int.from_bytes(sample[4:6], "big")
    image = Image.new("RGB", (64, 48), "white")
    drawing = ImageDraw.Draw(image)
    drawing.rectangle((2, 5, 28, 30), fill="green")
    drawing.ellipse((26, 12, 59, 42), fill="navy")
    output = BytesIO()
    image.save(output, format="JPEG", exif=sample[6:6 + length - 2])
    image.close()
    return output.getvalue()


class PhashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.photo = self.folder / "photo.jpg"
        self.photo.write_bytes(jpeg_bytes())

    def test_real_hash_matches_library_and_is_stable(self):
        result = calculate_photo_phash(self.photo)
        self.assertEqual(result["phash_status"], "已计算")
        self.assertRegex(result["photo_phash"], r"^[0-9a-f]{16}$")
        with Image.open(self.photo) as image:
            expected = str(imagehash.phash(image, hash_size=8))
        self.assertEqual(result["photo_phash"], expected)
        self.assertEqual(result, calculate_photo_phash(self.photo))

    def test_corrupt_missing_and_dependency_failure_are_isolated(self):
        bad = self.folder / "bad.jpg"
        bad.write_bytes(b"\xff\xd8\xffcorrupted")
        for photo in (bad, self.folder / "missing.jpg"):
            with self.subTest(photo=photo.name):
                with self.assertLogs("src.exif_validator", level="ERROR"):
                    result = calculate_photo_phash(photo)
                self.assertEqual(result["phash_status"], "校验异常")
                self.assertEqual(result["photo_phash"], "")
                self.assertTrue(result["phash_reason"])
        with patch.dict(sys.modules, {"imagehash": None}):
            with self.assertLogs("src.exif_validator", level="ERROR"):
                self.assertEqual(calculate_photo_phash(self.photo)["phash_status"], "校验异常")

    def test_hash_library_errors_and_malformed_results_are_isolated(self):
        for options in ({"side_effect": RuntimeError("library failure")}, {"return_value": "invalid"}):
            with self.subTest(options=options):
                with patch("imagehash.phash", **options):
                    with self.assertLogs("src.exif_validator", level="ERROR"):
                        self.assertEqual(calculate_photo_phash(self.photo)["phash_status"], "校验异常")

    def test_one_hash_error_does_not_stop_mail_or_override_exif(self):
        save_json(self.folder / "config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com"})
        (self.folder / ".env").write_text("IMAP_AUTH_CODE=TEST-SECRET\n", encoding="utf-8")
        config = load_config(self.folder / "config.json", self.folder / ".env")
        store = SqliteDataStore(self.folder / "attendance.db")
        mail = message_bytes(photos=[("first.jpg", self.photo.read_bytes()), ("second.jpg", self.photo.read_bytes())])
        server = FakeIMAP({10: mail, 11: message_bytes(photos=[("third.jpg", self.photo.read_bytes())])})
        original = imagehash.phash
        calls = 0

        def fail_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("one image failed")
            return original(*args, **kwargs)

        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=server), patch("imagehash.phash", side_effect=fail_once):
            with self.assertLogs("src.exif_validator", level="ERROR"):
                result = fetch_emails(config, store, self.folder)
        rows = store.load_records()
        self.assertEqual(result, {"emails": 2, "records": 3})
        self.assertEqual([row["phash_status"] for row in rows], ["校验异常", "已计算", "已计算"])
        self.assertTrue(all(row["is_valid"] for row in rows))
        self.assertTrue(all(row["reason"] == "有效" for row in rows))
        self.assertEqual(store.load_checkpoint()["last_uid"], 11)
        self.assertTrue(server.logged_out)

    def test_old_records_and_reimport_do_not_erase_hash(self):
        store = SqliteDataStore(self.folder / "attendance.db")
        old = record()
        self.assertEqual(store.save_records([old]), 1)
        before = store.load_records()[0]
        self.assertEqual(before["phash_status"], "未计算")
        hashed = {**old, **calculate_photo_phash(self.photo)}
        self.assertEqual(store.save_records([hashed]), 0)
        self.assertEqual(store.save_records([old]), 0)
        loaded = store.load_records()[0]
        self.assertEqual(loaded["photo_phash"], hashed["photo_phash"])
        self.assertEqual(loaded["id"], before["id"])
        self.assertEqual(loaded["created_at"], before["created_at"])

    def test_invalid_hash_data_rejected_and_conflict_rolls_back(self):
        store = SqliteDataStore(self.folder / "attendance.db")
        good = {**record(), "photo_phash": "a" * 16, "phash_status": "已计算", "phash_reason": ""}
        store.save_records([good])
        with self.assertRaises(MVPError):
            store.save_records([record("new"), {**good, "photo_phash": "b" * 16}])
        self.assertEqual(len(store.load_records()), 1)
        for changes in ({"photo_phash": "wrong"}, {"phash_status": "已计算"},
                        {"photo_phash": "a" * 16, "phash_status": "校验异常"}):
            with self.assertRaises(MVPError):
                normalize_records([{**record(), **changes}])

    def test_ui_and_report_expose_separate_phash_results(self):
        store = SqliteDataStore(self.folder / "data/attendance.db")
        status = {"photo_phash": "", "phash_status": "校验异常", "phash_reason": "坏图待核验"}
        store.save_records([{**record(), **status}])
        self.addCleanup(close_logging)
        with patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)}):
            app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=20).run()
        self.assertFalse(app.exception)
        frame = app.dataframe[0].value
        self.assertEqual(frame.iloc[0]["pHash 计算结果"], "校验异常")
        self.assertEqual(frame.iloc[0]["pHash 异常原因"], "坏图待核验")
        self.assertIn("照片 pHash", frame.columns)
        self.assertEqual(app.metric[1].value, "1")  # 基础规则仍有效。
        workbook = load_workbook(BytesIO(generate_report(store)))
        self.addCleanup(workbook.close)
        values = list(workbook["附件明细"].values)
        self.assertEqual(values[0][-3:], tuple(PHASH_COLUMNS))
        self.assertEqual(values[1][-2:], ("校验异常", "坏图待核验"))
        self.assertEqual(values[1][8], "有效")


class PhashMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "legacy.db"
        self.state = dict(account="teacher@qq.com", mailbox="INBOX", uidvalidity="101", last_uid=42)
        with closing(sqlite3.connect(self.path)) as connection:
            with connection:
                # 独立构造升级前（含 Software 校验、不含 pHash）的真实表结构。
                connection.executescript("""
                    CREATE TABLE attendance_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        student_id TEXT NOT NULL, student_name TEXT NOT NULL,
                        email_time TEXT NOT NULL, photo_name TEXT NOT NULL,
                        exif_lat REAL, exif_lon REAL, shoot_time TEXT NOT NULL,
                        distance REAL, is_valid INTEGER NOT NULL, reason TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT '2026-11-05T08:00:00Z',
                        source_key TEXT NOT NULL UNIQUE, attendance_window TEXT NOT NULL,
                        validation_scope TEXT NOT NULL, photo_path TEXT NOT NULL,
                        exif_software TEXT NOT NULL DEFAULT '', software_check TEXT NOT NULL DEFAULT '未校验'
                    );
                    CREATE TABLE mail_checkpoint(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                """)
                row = normalize_records([record()])[0]
                connection.execute("INSERT INTO attendance_records (" + ", ".join(BASE_COLUMNS) + ") VALUES (" +
                                   ", ".join("?" for _ in BASE_COLUMNS) + ")", [row[key] for key in BASE_COLUMNS])
                connection.execute("INSERT INTO mail_checkpoint VALUES(1, ?)", (json.dumps(self.state),))

    def test_repeated_and_concurrent_initialization_preserves_history(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            rows = list(executor.map(lambda _: SqliteDataStore(self.path).load_records()[0], range(8)))
        for row in rows:
            self.assertEqual(row["phash_status"], "未计算")
            self.assertEqual(row["photo_phash"], "")
            self.assertEqual(row["id"], 1)
            self.assertEqual(row["created_at"], "2026-11-05T08:00:00Z")
            self.assertTrue(row["is_valid"])
        self.assertEqual(SqliteDataStore(self.path).load_checkpoint(), self.state)

    def test_partial_schema_upgrade_completes_missing_columns(self):
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("ALTER TABLE attendance_records ADD COLUMN photo_phash TEXT NOT NULL DEFAULT ''")
        row = SqliteDataStore(self.path).load_records()[0]
        self.assertEqual([row[key] for key in PHASH_COLUMNS], ["", "未计算", ""])

    def test_migration_failure_rolls_back_all_new_columns(self):
        with closing(sqlite3.connect(self.path)) as connection:
            connection.row_factory = sqlite3.Row

            class FailingConnection:
                def execute(self, sql):
                    if "ADD COLUMN phash_reason" in sql:
                        raise sqlite3.OperationalError("模拟升级失败")
                    return connection.execute(sql)

            with self.assertRaises(sqlite3.OperationalError):
                with connection:
                    SqliteDataStore._migrate_validation_columns(FailingConnection())
            present = {row["name"] for row in connection.execute("PRAGMA table_info(attendance_records)")}
            self.assertFalse(set(PHASH_COLUMNS) & present)


if __name__ == "__main__":
    unittest.main()
```

## 数据库迁移 SQL 与执行方式

初始化时在 `BEGIN IMMEDIATE` 写锁下读取 `PRAGMA table_info(attendance_records)`，
仅对缺失字段执行相应语句，最后统一提交；异常时回滚。本地旧版 Software 补列逻辑继续保留。

```sql
ALTER TABLE attendance_records ADD COLUMN photo_phash TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_records ADD COLUMN phash_status TEXT NOT NULL DEFAULT '未计算';
ALTER TABLE attendance_records ADD COLUMN phash_reason TEXT NOT NULL DEFAULT '';
```

SQLite 的 ADD COLUMN 不支持通用的 IF NOT EXISTS，因此不要把上面三句无条件重复执行。
使用已提供的安全检测脚本（或启动后台/CLI 自动升级）：

```bash
.venv/bin/python scripts/migrate_phash_schema.py
# 自定义数据库：
.venv/bin/python scripts/migrate_phash_schema.py --db /path/to/attendance.db
```

## 运行和验证

```bash
.venv/bin/python -m streamlit run app.py
.venv/bin/python -m unittest discover -s tests -v
```

新增测试覆盖真图哈希、坏图、缺少依赖、库异常、邮件不中断、旧库及部分升级、
并发/重复升级、升级失败回滚、历史导入不抹去哈希，以及 UI 与 Excel 展示。
