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
DEFAULT_PHASH_THRESHOLD = 5
DUPLICATE_COLUMNS = ["duplicate_status", "duplicate_reason", "duplicate_record_id",
                     "duplicate_distance", "duplicate_threshold"]
COLUMNS = BASE_COLUMNS + DUPLICATE_COLUMNS + PHASH_COLUMNS
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
