# 照片相似比对与重复判定：完整实现

在原有 pHash 计算基础上，新照片入库时与更早入库的所有可用哈希比较。
相同邮件来源仍然幂等；不按学号、基础有效性或时间窗口排除候选。
采用 64 位哈希汉明距离，默认阈值 5，距离 <= 阈值时标记“疑似重复”。
保留最相似的历史记录编号；同距离时选编号最小者。只有后入库记录标记为疑似重复。
相似度为复用线索，需要人工核验，不自动将 `is_valid` 或 `reason` 改为无效。

## 依赖与配置

沿用已有 `ImageHash`、`Pillow`，本次无新增第三方库。缺少依赖时执行：

```bash
.venv/bin/python -m pip install -r requirements.txt
```

`config.json` 新增 `"phash_distance_threshold": 5`，旧配置缺省时自动取 5。
仅接受 0～64 的整数；0 表示只匹配相同 pHash（不保证文件字节相同），越大越容易命中。
后台也可保存此配置。授权码仍只来源于 `.env`，无需新增敏感配置。
阈值按记录保存，修改配置只影响后续新提交；历史结果用重新比对按钮或脚本更新。

## 新增数据字段

| 字段 | 含义 |
| --- | --- |
| duplicate_status | 未校验 / 未发现重复 / 疑似重复 / 校验异常 |
| duplicate_reason | 比对说明或异常原因 |
| duplicate_record_id | 最相似且命中的历史记录主键；无命中为空 |
| duplicate_distance | 命中历史记录的汉明距离；无命中为空 |
| duplicate_threshold | 此次比对使用的阈值 |

哈希计算失败、比较函数异常只影响当前照片，记录日志并显示校验异常，后续照片继续处理。
历史哈希损坏时跳过该候选并记录日志；其余候选命中则保留疑似重复并注明部分历史未参与，
无命中时标为校验异常，避免在比对不完整时显示未发现重复。
数据库本身读写失败仍回滚当前邮件记录与进度，以便重试。
比较与写入持有同一 SQLite 写锁，兼顾同批附件与并发提交。

## 运行

```bash
# 仅升级表结构（启动后台或 CLI 时也会自动升级，可重复运行）：
.venv/bin/python scripts/migrate_phash_schema.py
# 按已保存配置重新比较所有已有哈希：
.venv/bin/python scripts/recheck_photo_duplicates.py
# 或指定本次重比对阈值（不修改 config.json）：
.venv/bin/python scripts/recheck_photo_duplicates.py --threshold 5
# 启动后台：
.venv/bin/python -m streamlit run app.py
# 回归测试：
.venv/bin/python -m unittest discover -s tests -v
```

后台新增“疑似重复”指标、“照片重复判定”筛选、关联历史照片预览和“重新比对历史照片”按钮。
Excel 明细导出重复判定字段和自身 id，学生汇总增加疑似重复数量及异常/未校验数量。
原有“有效/无效”“校验通过”沿用基础规则结果，需结合新增列人工核验。
历史比对仅使用已有哈希，不下载邮件、不重算旧照片；无哈希记录为未校验。
迁移不重写历史 EXIF/基础校验结果，也不推进邮件游标。
比较的先后按数据库编号确定，不按邮件中可伪造的日期或照片拍摄时间确定。
每条新记录扫描历史哈希；全库重新比对为 O(n²)，适合当前本地 MVP，界面和脚本均提供进度。

## 安全迁移 SQL

初始化时在 `BEGIN IMMEDIATE` 事务内通过 `PRAGMA table_info(attendance_records)` 检查字段，
仅执行缺失字段的 SQL，并创建索引；重复或并发初始化不会覆盖历史结果。
不要不经检测反复直接执行下面的 ALTER TABLE；推荐使用上述 Python 迁移脚本。

```sql
ALTER TABLE attendance_records ADD COLUMN duplicate_status TEXT NOT NULL DEFAULT '未校验';
ALTER TABLE attendance_records ADD COLUMN duplicate_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_records ADD COLUMN duplicate_record_id INTEGER;
ALTER TABLE attendance_records ADD COLUMN duplicate_distance INTEGER CHECK(duplicate_distance BETWEEN 0 AND 64);
ALTER TABLE attendance_records ADD COLUMN duplicate_threshold INTEGER NOT NULL DEFAULT 5 CHECK(duplicate_threshold BETWEEN 0 AND 64);
CREATE INDEX IF NOT EXISTS idx_records_duplicate_status_id ON attendance_records(duplicate_status, id);
CREATE INDEX IF NOT EXISTS idx_records_hashed_id ON attendance_records(id) WHERE phash_status = '已计算';
```

## 文件结构

```text
app.py
config.example.json
requirements.txt
src/
  common.py
  config.py
  email_fetcher.py
  exif_validator.py
  photo_deduplicator.py          # 新增：汉明距离与疑似重复判定
  data_store.py                 # 事务比较、保存、迁移、历史重比对
  report_generator.py
scripts/
  migrate_phash_schema.py
  recheck_photo_duplicates.py    # 新增：历史比对命令
 tests/
  test_photo_duplicates.py       # 新增：边界、异常、并发、迁移与页面测试
```

以下为相关生产文件的完整代码，辅助测试完整源码见 `tests/test_photo_duplicates.py`。

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

## config.example.json

```json
{
  "email_account": "your_qq@qq.com",
  "target_lat": 39.9042,
  "target_lon": 116.4074,
  "threshold_meters": 200.0,
  "phash_distance_threshold": 5,
  "attendance_start": "",
  "attendance_end": "",
  "photo_timezone": "+08:00",
  "max_attachment_bytes": 10485760,
  "max_email_bytes": 26214400
}
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
```

## src/config.py

```python
"""合并 JSON 业务配置与 .env 凭证，并通过 Pydantic 校验。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from dotenv import dotenv_values, set_key
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator

from .common import DEFAULT_PHASH_THRESHOLD, MVPError, UNLIMITED_WINDOW, atomic_path, read_json, save_json, single_process


DEFAULT_CONFIG = {
    "email_account": "your_qq@qq.com",
    "target_lat": 39.9042,
    "target_lon": 116.4074,
    "threshold_meters": 200.0,
    "phash_distance_threshold": DEFAULT_PHASH_THRESHOLD,
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
    phash_distance_threshold: int = Field(default=DEFAULT_PHASH_THRESHOLD, ge=0, le=64, strict=True)
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
                      "target_lon": "目标经度", "threshold_meters": "距离阈值",
                      "phash_distance_threshold": "照片相似度阈值"}
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

## src/photo_deduplicator.py

```python
"""64 位 pHash 相似照片判定；只输出疑似重复，保留基础 EXIF 校验结果。"""

import logging
import re

log = logging.getLogger(__name__)
DUPLICATE_STATUSES = ("未校验", "未发现重复", "疑似重复", "校验异常")


def validate_threshold(value):
    if type(value) is not int or not 0 <= value <= 64:
        raise ValueError("pHash 汉明距离阈值必须为 0 到 64 的整数")
    return value


def hamming_distance(first, second):
    """异或后统计不同的位数；64 位 pHash 的汉明距离范围为 0～64。"""
    for value in (first, second):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{16}", value):
            raise ValueError("pHash 必须是 16 位十六进制字符串")
    return (int(first, 16) ^ int(second, 16)).bit_count()


def compare_photo(row, candidates):
    """候选仅包含更早入库记录（按 id）；并列时关联最早的一条。

    不按学号、窗口或基础有效性过滤，兼顾本人重复提交和跨学号复用。
    当前哈希及历史哈希异常仅影响本条比对，不中断后续记录。
    """
    result = dict(duplicate_status="未校验", duplicate_reason="照片尚无可用 pHash",
                  duplicate_record_id=None, duplicate_distance=None,
                  duplicate_threshold=row["duplicate_threshold"])
    try:
        threshold = validate_threshold(row["duplicate_threshold"])
        if row["phash_status"] == "校验异常":
            result.update(duplicate_status="校验异常", duplicate_reason=row.get("phash_reason") or "照片 pHash 计算失败")
            return result
        if row["phash_status"] != "已计算":
            return result
        # 即使没有历史记录，也检查当前哈希，避免错误地显示“未发现重复”。
        hamming_distance(row["photo_phash"], row["photo_phash"])
        best = None
        damaged = 0
        for candidate in candidates:
            if candidate["source_key"] == row["source_key"]:
                continue  # 幂等重试绝不把自己判为重复。
            try:
                distance = hamming_distance(row["photo_phash"], candidate["photo_phash"])
            except ValueError:
                log.exception("历史记录 #%s 的 pHash 损坏，跳过该候选。", candidate["id"])
                damaged += 1
                continue
            key = (distance, candidate["id"])
            if best is None or key < best:
                best = key
        if best is not None and best[0] <= threshold:
            distance, record_id = best
            result.update(duplicate_status="疑似重复", duplicate_record_id=record_id,
                          duplicate_distance=distance,
                          duplicate_reason=f"与历史记录 #{record_id} 相似：汉明距离 {distance} ≤ 阈值 {threshold}，待人工核验")
            if damaged:
                result["duplicate_reason"] += f"；另有 {damaged} 条历史哈希损坏未参与比对"
        elif damaged:
            result.update(duplicate_status="校验异常", duplicate_reason=f"{damaged} 条历史哈希损坏，比对不完整，请人工核验")
        else:
            result.update(duplicate_status="未发现重复", duplicate_reason="未发现阈值范围内的历史照片")
        return result
    except Exception:
        log.exception("照片相似度比对异常，当前记录转人工核验，继续处理后续照片。")
        result.update(duplicate_status="校验异常", duplicate_reason="照片相似度比对失败，请人工核验",
                      duplicate_record_id=None, duplicate_distance=None)
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
SUBJECT_RE = re.compile(r"^(?P<name>[^+\r\n]+)\+(?P<id>[0-9]+)$")


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
        log.info("跳过 UID %s：主题不符合姓名+学号（例如 张三+0020230001）。", uid)
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
                   software_check="未校验", duplicate_threshold=config.phash_distance_threshold,
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
                    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
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
        """整批事务追加；同学号同姓名跳过，不覆盖冲突名单。"""
        rows = normalize_students(students)
        inserted = 0
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for row in rows:
                previous = connection.execute("SELECT student_name FROM students WHERE student_id = ?",
                                              (row["student_id"],)).fetchone()
                if previous is not None:
                    if previous["student_name"] != row["student_name"]:
                        raise MVPError(f"学号 {row['student_id']} 与已有名单姓名冲突，本批名单未导入。")
                    continue
                connection.execute("INSERT INTO students(student_id, student_name) VALUES (?, ?)",
                                   (row["student_id"], row["student_name"]))
                inserted += 1
            total = connection.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        return {"inserted": inserted, "skipped": len(rows) - inserted, "total": total}

    def load_students(self) -> list:
        with self._connection() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM students ORDER BY student_id")]

    def student_attendance(self, day: str) -> dict:
        """按北京时间收件日期汇总；多附件只计一人，姓名冲突不计为通过。"""
        try:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError
        except (ValueError, TypeError):
            raise MVPError("统计日期必须为 YYYY-MM-DD。") from None
        with self._connection() as connection:
            # 两个查询使用同一读事务快照，避免拉取/导入中途导致统计不一致。
            connection.execute("BEGIN")
            rows = connection.execute("""
                SELECT s.student_id, s.student_name, COUNT(r.id) AS submission_count,
                       COALESCE(SUM(CASE WHEN r.student_name = s.student_name AND r.is_valid = 1
                                         THEN 1 ELSE 0 END), 0) AS valid_count,
                       COALESCE(SUM(CASE WHEN r.student_name != s.student_name THEN 1 ELSE 0 END), 0) AS mismatched_count,
                       GROUP_CONCAT(DISTINCT r.student_name) AS submitted_names,
                       GROUP_CONCAT(DISTINCT CASE WHEN r.is_valid = 0 THEN r.reason END) AS reasons,
                       MAX(datetime(r.email_time, '+8 hours')) AS latest_email_time
                FROM students s LEFT JOIN attendance_records r
                  ON s.student_id = r.student_id AND date(r.email_time, '+8 hours') = ?
                GROUP BY s.student_id, s.student_name ORDER BY s.student_id
            """, (day,)).fetchall()
            outsiders = connection.execute("""
                SELECT r.student_id, r.student_name, COUNT(*) AS submission_count
                FROM attendance_records r LEFT JOIN students s ON s.student_id = r.student_id
                WHERE s.student_id IS NULL AND date(r.email_time, '+8 hours') = ?
                GROUP BY r.student_id, r.student_name ORDER BY r.student_id
            """, (day,)).fetchall()
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
            row.update(status=status, reason=reason, latest_email_time=row["latest_email_time"] or "")
            details.append(row)
        stats = {"total": len(details), "submitted": sum(row["submission_count"] > 0 for row in details),
                 "passed": sum(row["status"] == "校验通过" for row in details),
                 "pending": sum(row["status"] in ("姓名不匹配", "未通过") for row in details),
                 "missing": sum(row["status"] == "未提交" for row in details)}
        return {"statistics": stats, "students": details, "outsiders": [dict(row) for row in outsiders]}

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
```

## src/report_generator.py

```python
"""带颜色的 Excel 明细和学生汇总，可直接返回下载字节。"""

from datetime import datetime, timedelta, timezone
from io import BytesIO
import logging
import math
from pathlib import Path

from .common import COLUMNS, PHASH_COLUMNS, UNLIMITED_WINDOW, MVPError, atomic_path
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
        width = 36 if column == status_column or header in ("reason", "duplicate_reason", "validation_scope", "software_check", "exif_software", "校验说明") else 23
        sheet.column_dimensions[get_column_letter(column)].width = width
    return sheet

def generate_report(store: DataStore, destination=None) -> bytes:
    import pandas as pd
    from openpyxl import Workbook

    try:
        rows = store.load_records()
    except FileNotFoundError:
        rows = []
    # 保留原始十列顺序，补上数据库编号，方便在 Excel 内核对关联历史记录。
    detail_columns = COLUMNS[:-len(PHASH_COLUMNS)] + ["id"] + PHASH_COLUMNS
    records = pd.DataFrame(rows, columns=detail_columns)
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
        for column in detail_columns:
            value = row[column]
            if column == "is_valid":
                value = "有效" if row["is_valid"] else f"无效({row['reason'] or '原因缺失，待核验'})"
            elif column in ("exif_lat", "exif_lon", "distance") and value != "":
                value = float(value)
            values.append(value)
        detail_rows.append((values, bool(row["is_valid"])))
    write_sheet(workbook, "附件明细", detail_columns, detail_rows, detail_columns.index("is_valid") + 1)
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
        duplicates = int(group["duplicate_status"].eq("疑似重复").sum())
        review = int(group["duplicate_status"].isin(["校验异常", "未校验"]).sum())
        summary_rows.append(([student_id, " / ".join(names), period, len(group),
                              int(group["is_valid"].sum()), status,
                              "；".join(sorted(set(group["validation_scope"]))), duplicates, review], valid))
    write_sheet(workbook, "学生汇总", ["学号", "姓名", "时间窗口或收件日", "附件数", "通过附件数", "校验结果", "校验说明", "疑似重复附件数", "重复比对异常或未校验数"], summary_rows, 6)
    notes = workbook.create_sheet("使用说明")
    for text in (
        "本工具验证照片元数据，不证明本人到场；EXIF 可被修改，也可能因压缩而丢失。",
        "附件明细中的有效/无效仅表示配置规则的自动校验结果，无GPS等情况应人工核验。",
        "exif_software 为 Software 标签原文，software_check 为软件校验结果；历史记录未自动重新校验。",
        "Software 缺失或未命中禁用关键词不能证明照片未经编辑；命中禁用软件时自动判为无效。",
        "duplicate_status 为独立的照片重复判定，不覆盖基础校验结果；疑似重复及异常请人工核验。",
        "按入库编号与更早的所有已计算哈希比较，保留最近似记录编号和汉明距离；距离并列时关联最早记录。",
        "duplicate_record_id 对应附件明细 id，不是 Excel 行号；可按编号在后台查看关联历史照片。",
        "同一学号同一窗口至少一张通过即记一次通过；姓名冲突需人工核验。",
        "未设置时间窗口时按北京时间收件日期汇总，仅表示坐标校验通过。",
        "本报表学生汇总按实际提交生成；名单及未提交统计请查看 Web 页面的学生提交统计。",
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

## app.py

```python
"""Streamlit 本地管理后台：python -m streamlit run app.py。"""

import logging
from datetime import datetime, timedelta, timezone
import math
import os
from pathlib import Path

import pandas as pd
import streamlit as st

from src.common import DEFAULT_PHASH_THRESHOLD, MVPError, single_process
from src.config import DEFAULT_CONFIG, load_config, read_business_config, save_config
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.logger import add_secret, redact, setup_logging
from src.report_generator import generate_report
from src.photo_deduplicator import validate_threshold
from src.web_helpers import safe_photo_path
from src.student_roster import parse_student_roster


WORK_DIR = Path(os.environ.get("ATTENDANCE_WORK_DIR", Path(__file__).resolve().parent)).resolve()
log = logging.getLogger(__name__)
PAGE_SIZE = 200
ROSTER_TEMPLATE = "姓名,学号\n张三,0020230001\n李四,0020230002\n".encode("utf-8-sig")


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
        try:
            saved_phash_threshold = validate_threshold(business["phash_distance_threshold"])
        except ValueError:
            saved_phash_threshold = DEFAULT_PHASH_THRESHOLD
            st.warning("已保存的照片相似度阈值无效，请选择 0～64 的整数并保存配置。")
        if st.session_state.pop("clear_auth", False):
            st.session_state["auth_code"] = ""
        with st.form("settings"):
            st.subheader("系统配置")
            account = st.text_input("QQ 邮箱", value=business["email_account"])
            latitude = st.text_input("目标纬度", value=str(business["target_lat"]))
            longitude = st.text_input("目标经度", value=str(business["target_lon"]))
            threshold = st.text_input("距离阈值（米）", value=str(business["threshold_meters"]))
            phash_threshold = st.number_input("照片相似度阈值（汉明距离）", min_value=0, max_value=64,
                                              value=saved_phash_threshold, step=1,
                                              help="默认 5；0 仅匹配相同 pHash，值越大越容易命中。相似不等于作弊。")
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
                                 "threshold_meters": threshold, "phash_distance_threshold": phash_threshold,
                                 "attendance_start": start,
                                 "attendance_end": end, "photo_timezone": photo_tz}, auth, WORK_DIR)
                st.session_state["clear_auth"] = True
                st.session_state["flash"] = "配置已保存。"
                st.rerun()
            except Exception as error:
                show_error("保存配置", error)

        st.divider()
        st.subheader("核心操作")
        st.caption("学生发送邮件：主题为“姓名+学号”，例如 张三+0020230001；附上 JPG/JPEG 原图。")
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

        if st.button("重新比对历史照片", use_container_width=True, disabled=store is None):
            progress = None
            try:
                with st.spinner("正在按已保存的相似度阈值重新比对历史照片…"):
                    threshold_value = read_business_config(WORK_DIR)["phash_distance_threshold"]
                    progress = st.progress(0, text="正在读取历史哈希…")

                    def update_comparison(done, total):
                        progress.progress(done / total, text=f"已比对 {done} / {total} 条记录")

                    with single_process(WORK_DIR):
                        log.info("开始重新比对历史照片。")
                        counts = store.recheck_duplicates(threshold_value, update_comparison)
                    log.info("历史照片比对完成：%s", counts)
                st.session_state.pop("report_bytes", None)
                st.session_state["flash"] = (f"历史比对完成：疑似重复 {counts['疑似重复']} 条，"
                                            f"校验异常 {counts['校验异常']} 条，未校验 {counts['未校验']} 条。")
                st.rerun()
            except Exception as error:
                show_error("历史照片比对", error)
            finally:
                if progress is not None:
                    progress.empty()
        st.caption("历史比对使用已有 pHash；没有哈希的旧记录仍为未校验，不会重新下载邮件。")

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


def roster_import(store):
    with st.expander("学生名单导入", expanded=not store.load_students()):
        st.caption("支持 Excel（.xlsx）和 CSV，首行包含“姓名”“学号”。学号列请保存为文本以保留前导零。")
        st.download_button("下载学生名单模板", data=ROSTER_TEMPLATE, file_name="学生名单模板.csv", mime="text/csv")
        with st.form("student_roster_import"):
            upload = st.file_uploader("选择学生名单", type=["xlsx", "csv"], key="student_roster_file")
            submit = st.form_submit_button("导入学生名单")
        st.caption("导入会追加新学生，已有同名同学号自动跳过；同学号姓名冲突时整批取消。")
        if submit:
            try:
                if upload is None:
                    raise MVPError("请先选择学生名单文件。")
                students = parse_student_roster(upload.getvalue(), upload.name)
                with single_process(WORK_DIR):
                    result = store.import_students(students)
                st.session_state["flash"] = (f"名单导入完成：新增 {result['inserted']} 人，"
                                              f"跳过 {result['skipped']} 人，当前共 {result['total']} 人。")
                st.rerun()
            except Exception as error:
                show_error("名单导入", error)


def student_statistics(store):
    st.subheader("学生提交统计")
    if not store.load_students():
        st.info("请先导入学生名单，即可查看每名学生的提交情况和未提交名单。")
        return
    today = datetime.now(timezone(timedelta(hours=8))).date()
    day = st.date_input("统计日期（北京时间）", value=today, key="roster_day")
    result = store.student_attendance(day.isoformat())
    stats = result["statistics"]
    for column, label, key in zip(st.columns(5), ("名单人数", "已提交人数", "校验通过人数", "待核验人数", "未提交人数"),
                                  ("total", "submitted", "passed", "pending", "missing")):
        column.metric(label, stats[key])
    st.caption("按北京时间收件日期统计，单位为学生；同一学生多张照片只计一人。姓名须与名单一致，至少一张照片通过基础校验才计为通过。")
    st.caption("姓名不匹配或照片未通过归入待核验；照片重复与 pHash 结果仍在打卡记录中单独展示。")
    choice = st.selectbox("学生提交状态", ["全部学生", "校验通过", "未通过", "姓名不匹配", "未提交"], key="student_status")
    rows = [row for row in result["students"] if choice == "全部学生" or row["status"] == choice]
    if rows:
        names = {"student_id": "学号", "student_name": "姓名", "status": "提交状态",
                 "submission_count": "照片数", "valid_count": "通过照片数", "reason": "说明",
                 "latest_email_time": "最近收件时间（北京）"}
        frame = pd.DataFrame(rows)[list(names)].rename(columns=names)
        st.dataframe(frame, hide_index=True, width="stretch")
    else:
        st.info("所选日期没有符合该状态的学生。")
    if result["outsiders"]:
        st.warning(f"所选日期有 {len(result['outsiders'])} 组名单外学生提交，未计入名单人数或通过人数。")
        with st.expander("查看名单外提交"):
            st.dataframe(pd.DataFrame(result["outsiders"]).rename(columns={"student_id": "学号", "student_name": "邮件姓名",
                                                                           "submission_count": "照片数"}),
                         hide_index=True, width="stretch")
    st.divider()


def dashboard(store):
    with st.spinner("正在读取考勤数据…"):
        stats = store.statistics()
    metrics = st.columns(4)
    for column, label, key in zip(metrics[:3], ("总打卡数", "有效打卡数", "异常 / 待核验"), ("total", "valid", "invalid")):
        column.metric(label, stats[key])
    metrics[3].metric("疑似重复", store.count_records(duplicate_status="疑似重复"))
    st.caption("统计单位为照片提交记录；同一学生的多张照片会分别计数。")
    st.caption("有效/无效沿用基础校验结果；疑似重复单独统计，需人工核验，可能与有效记录重叠。")
    st.divider()
    student_statistics(store)
    st.subheader("打卡记录")
    controls = st.columns([2, 2, 1])
    choice = controls[0].selectbox("校验结果", ["全部", "有效", "无效"], key="result_filter")
    valid = {"全部": None, "有效": True, "无效": False}[choice]
    duplicate_choice = controls[1].selectbox("照片重复判定", ["全部", "疑似重复", "未发现重复", "校验异常", "未校验"],
                                             key="duplicate_filter")
    duplicate_filter = None if duplicate_choice == "全部" else duplicate_choice
    count = store.count_records(valid, duplicate_filter)
    pages = max(1, math.ceil(count / PAGE_SIZE))
    filters = (choice, duplicate_choice)
    if st.session_state.get("last_filter") != filters:
        st.session_state["page"] = 1
        st.session_state["last_filter"] = filters
    if st.session_state.get("page", 1) > pages:
        st.session_state["page"] = pages
    page = controls[2].number_input("页码", min_value=1, max_value=pages, step=1, key="page")
    with st.spinner("正在加载记录明细…"):
        rows = store.query_records(valid, limit=PAGE_SIZE, offset=(page - 1) * PAGE_SIZE, duplicate_status=duplicate_filter)
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
                 "duplicate_status": "照片重复判定", "duplicate_reason": "重复判定说明",
                 "duplicate_record_id": "关联记录编号", "duplicate_distance": "汉明距离",
                 "duplicate_threshold": "比对阈值",
                 "photo_phash": "照片 pHash", "phash_status": "pHash 计算结果", "phash_reason": "pHash 异常原因"}
        visible = ["id", "student_id", "student_name", "校验结果", "distance", "reason", "email_time",
                   "duplicate_status", "duplicate_reason", "duplicate_record_id", "duplicate_distance", "duplicate_threshold",
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
        if selected["duplicate_status"] in ("疑似重复", "校验异常"):
            st.warning(selected["duplicate_reason"])
        if selected.get("duplicate_record_id") is not None:
            related = store.get_record(selected["duplicate_record_id"])
            if related is None:
                st.warning("关联的历史记录不存在，请人工核验。")
            else:
                st.markdown("**相似历史照片**")
                st.caption(f"#{related['id']} · 学号 {related['student_id']} · {related['student_name']}")
                st.caption(f"收件时间：{related['email_time']}；汉明距离：{selected['duplicate_distance']} / 64")
                related_photo = safe_photo_path(related.get("photo_path"), WORK_DIR)
                if related_photo is None:
                    st.warning("关联历史照片文件不存在或无法安全预览，记录仍可供人工核验。")
                else:
                    try:
                        with st.spinner("正在加载相似历史照片…"):
                            st.image(str(related_photo), caption=related["photo_name"], width="stretch")
                    except Exception as error:
                        show_error("历史照片预览", error)


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
            roster_import(store)
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
        print("pHash 及重复判定字段已就绪。历史结果与邮件进度已保留；可执行 recheck_photo_duplicates.py 比对已有哈希。")
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

## scripts/recheck_photo_duplicates.py

```python
#!/usr/bin/env python3
"""用已有 pHash 重新判定历史重复照片，不修改基础校验结果或邮件进度。"""

import argparse
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.common import single_process
from src.config import read_business_config
from src.data_store import SqliteDataStore
from src.logger import close_logging, setup_logging


def main(argv=None):
    parser = argparse.ArgumentParser(description="按入库顺序重新比对历史 pHash；无哈希记录保留为未校验。")
    parser.add_argument("--work-dir", type=Path, default=ROOT)
    parser.add_argument("--db", type=Path, default=None)
    parser.add_argument("--threshold", type=int, choices=range(65), metavar="0..64",
                        help="默认读取 config.json 的 phash_distance_threshold（缺省 5）")
    args = parser.parse_args(argv)
    folder = args.work_dir.resolve()
    try:
        setup_logging(folder / "logs", folder / ".env")
        threshold = args.threshold
        if threshold is None:
            threshold = read_business_config(folder)["phash_distance_threshold"]

        def progress(done, total):
            if done == total or done % 100 == 0:
                print(f"已比对 {done} / {total} 条记录。", flush=True)

        with single_process(folder):
            store = SqliteDataStore(args.db or folder / "data/attendance.db")
            print("正在重新比对已有哈希…", flush=True)
            result = store.recheck_duplicates(threshold, progress)
        print("比对完成：" + "，".join(f"{status} {count} 条" for status, count in result.items()))
        logging.getLogger(__name__).info("历史照片比对完成：%s", result)
        return 0
    except Exception:
        logging.getLogger(__name__).exception("历史照片比对失败。")
        print("比对未完成，数据库事务已回滚。请检查配置和数据库，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
```
