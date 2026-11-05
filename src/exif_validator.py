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
