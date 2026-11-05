#!/usr/bin/env python3
"""大学生照片打卡 MVP：init → fetch → report。

QQ 授权码：登录 QQ 邮箱网页版，在“设置 → 账户”（新版可能位于
“账号与安全”）开启 IMAP/SMTP 服务，按页面指引验证身份并生成授权码。
将授权码填入 config.json 的 imap_auth_code；它不是 QQ 登录密码。
照片元数据可以被修改，本工具不证明学生本人到场。
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
import hashlib
import imaplib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile


DEFAULT_CONFIG = {
    "email_account": "your_qq@qq.com",
    "imap_auth_code": "your_auth_code",
    "target_lat": 39.9042,
    "target_lon": 116.4074,
    "threshold_meters": 200.0,
    "attendance_start": "",
    "attendance_end": "",
    "photo_timezone": "+08:00",
    "max_attachment_bytes": 10 * 1024 * 1024,
    "max_email_bytes": 25 * 1024 * 1024,
}
COLUMNS = [
    "student_id", "student_name", "email_time", "photo_name", "exif_lat",
    "exif_lon", "shoot_time", "distance", "is_valid", "reason",
    "source_key", "attendance_window", "validation_scope",
]
SUBJECT_RE = re.compile(r"^【打卡】(?P<id>[0-9]+)-(?P<name>[^\r\n]+)$")
UNLIMITED_WINDOW = "未设置时间窗口"


class MVPError(Exception):
    """适合直接向命令行用户展示的错误。"""


@contextmanager
def single_process():
    """防止两个进程同时覆盖 CSV 或处理进度。异常退出后需人工清理锁。"""
    lock = Path(".mvp_agent.lock")
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
    """在同一目录写临时文件，再原子替换，避免中断留下半个 CSV/配置。"""
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
    except (ValueError, UnicodeError) as exc:
        raise MVPError(f"{path} 不是有效的 UTF-8 JSON，请检查文件。") from exc
    if not isinstance(value, dict):
        raise MVPError(f"{path} 顶层必须是 JSON 对象。")
    return value


def init_config():
    if Path("config.json").exists():
        raise MVPError("config.json 已存在，未覆盖。请直接编辑配置。")
    save_json("config.json", DEFAULT_CONFIG)
    print("已生成 config.json。请填写邮箱、IMAP 授权码和目标坐标，再执行 fetch。")


def parse_timezone(value):
    match = re.fullmatch(r"([+-])(\d{2}):(\d{2})", str(value))
    if not match:
        raise MVPError("photo_timezone 必须为固定时区偏移，例如 +08:00。")
    hours, minutes = int(match[2]), int(match[3])
    if hours > 23 or minutes > 59:
        raise MVPError("photo_timezone 的时区偏移超出范围。")
    delta = timedelta(hours=hours, minutes=minutes)
    return timezone(delta if match[1] == "+" else -delta)


def load_config():
    if not Path("config.json").exists():
        raise MVPError("缺少 config.json，请先执行 init。")
    config = {**DEFAULT_CONFIG, **read_json("config.json")}
    for key in ("target_lat", "target_lon", "threshold_meters"):
        try:
            if isinstance(config[key], bool):
                raise ValueError
            config[key] = float(config[key])
            if not math.isfinite(config[key]):
                raise ValueError
        except (TypeError, ValueError):
            raise MVPError(f"{key} 必须为有限数值。") from None
    if not -90 <= config["target_lat"] <= 90 or not -180 <= config["target_lon"] <= 180:
        raise MVPError("目标经纬度超出合法范围。")
    if config["threshold_meters"] < 0:
        raise MVPError("threshold_meters 不能为负数。")
    for key in ("max_attachment_bytes", "max_email_bytes"):
        if type(config[key]) is not int or config[key] <= 0:
            raise MVPError(f"{key} 必须为正整数。")
    config["_photo_tz"] = parse_timezone(config["photo_timezone"])
    start, end = config["attendance_start"], config["attendance_end"]
    if not isinstance(start, str) or not isinstance(end, str) or bool(start) != bool(end):
        raise MVPError("attendance_start 和 attendance_end 必须同时填写或同时留空。")
    config["_window"] = None
    config["_window_label"] = UNLIMITED_WINDOW
    if start:
        try:
            bounds = (datetime.fromisoformat(start), datetime.fromisoformat(end))
            if any(bound.utcoffset() is None for bound in bounds) or bounds[0] > bounds[1]:
                raise ValueError
        except (ValueError, TypeError):
            raise MVPError("打卡时间需包含时区且起点不晚于终点，例如 2026-11-05T08:00:00+08:00。") from None
        config["_window"] = bounds
        config["_window_label"] = "/".join(bound.astimezone(timezone.utc).isoformat() for bound in bounds)
    return config


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


def evaluate_photo(path, config):
    import exifread

    result = dict(exif_lat="", exif_lon="", shoot_time="", distance="", is_valid=False, reason="")
    try:
        with Path(path).open("rb") as stream:
            tags = exifread.process_file(stream, details=False, strict=True)
    except Exception:
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
    distance = haversine(lat, lon, config["target_lat"], config["target_lon"])
    result["distance"] = distance  # 原始精度参与判断，Excel 中仅显示两位小数。
    if distance > config["threshold_meters"]:
        result["reason"] = "距离超限"
        return result
    if config["_window"]:
        try:
            offset = str(tags.get("EXIF OffsetTimeOriginal", "")).strip()
            tz = parse_timezone(offset) if offset else config["_photo_tz"]
            shoot = datetime.strptime(raw_time, "%Y:%m:%d %H:%M:%S").replace(tzinfo=tz)
        except (ValueError, MVPError):
            result["reason"] = "缺少可用拍摄时间，待人工核验"
            return result
        result["shoot_time"] = shoot.isoformat()
        start, end = config["_window"]
        if not start <= shoot <= end:
            result["reason"] = "拍摄时间不在打卡窗口内"
            return result
    result.update(is_valid=True, reason="有效")
    return result


def read_records():
    import pandas as pd

    path = Path("records.csv")
    if not path.exists():
        return pd.DataFrame(columns=COLUMNS)
    try:
        frame = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    except (ValueError, UnicodeError, pd.errors.ParserError) as exc:
        raise MVPError("records.csv 无法解析，请检查文件，原文件未覆盖。") from exc
    missing = set(COLUMNS) - set(frame.columns)
    if missing:
        raise MVPError("records.csv 缺少字段：" + ", ".join(sorted(missing)))
    if frame["source_key"].eq("").any():
        raise MVPError("records.csv 存在空 source_key，无法安全去重，请先修复。")
    # 禁止 bool('False')：非空字符串在 Python 中也会被判为真。
    flags = frame["is_valid"].str.strip().str.lower()
    if not flags.isin(["true", "false"]).all():
        raise MVPError("records.csv 的 is_valid 只能为 True 或 False。")
    frame["is_valid"] = flags.eq("true")
    duplicates = frame[frame.duplicated("source_key", keep=False)]
    if not duplicates.empty and duplicates.drop_duplicates().duplicated("source_key").any():
        raise MVPError("records.csv 中同一 source_key 存在冲突记录，请先核对。")
    return frame.drop_duplicates("source_key").reset_index(drop=True)


def save_records(frame):
    with atomic_path("records.csv") as temp:
        frame.to_csv(temp, index=False, encoding="utf-8-sig", columns=COLUMNS)


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


def attachment_rows(raw_email, metadata, config, validity, uid, known):
    message = BytesParser(policy=policy.default).parsebytes(raw_email)
    subject = str(message.get("Subject", "")).strip()
    # fullmatch 限定整行；学号保留字符串类型，防止丢失前导零。
    match = SUBJECT_RE.fullmatch(subject)
    if not match or not match["name"].strip():
        print(f"跳过 UID {uid}：主题不符合【打卡】学号-姓名。")
        return []
    received = email_received_time(metadata)
    rows = []
    for index, part in enumerate(message.walk()):
        if part.is_multipart():
            continue
        filename = part.get_filename()
        if not filename or Path(filename).suffix.lower() not in (".jpg", ".jpeg"):
            continue
        key = source_key(config["email_account"], validity, uid, index)
        if key in known:
            continue
        row = dict.fromkeys(COLUMNS, "")
        row.update(student_id=match["id"], student_name=match["name"].strip(),
                   email_time=received, photo_name=filename, source_key=key,
                   is_valid=False, attendance_window=config["_window_label"],
                   validation_scope="坐标及拍摄时间校验" if config["_window"] else "仅坐标校验，未校验拍摄时间")
        payload = part.get_payload(decode=True)
        if not payload:
            row["reason"] = "附件为空或无法解码"
        elif len(payload) > config["max_attachment_bytes"]:
            row["reason"] = "附件超过大小限制"
        elif not payload.startswith(b"\xff\xd8\xff"):
            row["reason"] = "附件不是可识别的JPEG图片"
        else:
            # 永远不把邮件附件名拼入本地路径，阻断路径穿越和同名覆盖。
            folder = Path("attachments")
            folder.mkdir(mode=0o700, exist_ok=True)
            target = folder / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".jpg")
            with atomic_path(target) as temp:
                temp.write_bytes(payload)
            row.update(evaluate_photo(target, config))
        rows.append(row)
    if not rows:
        print(f"UID {uid}：没有新的 JPG/JPEG 附件。")
    return rows


def require_ok(status, operation):
    if status != "OK":
        raise MVPError(f"邮箱{operation}失败，未推进处理进度。")


def fetch_emails():
    import pandas as pd
    import exifread  # 在连接邮箱前检查依赖。

    config = load_config()
    account, auth = config["email_account"], config["imap_auth_code"]
    if not isinstance(account, str) or "@" not in account or account == DEFAULT_CONFIG["email_account"]:
        raise MVPError("请先在 config.json 填写真实的 email_account。")
    if not isinstance(auth, str) or not auth.strip() or auth == DEFAULT_CONFIG["imap_auth_code"]:
        raise MVPError("请先在 config.json 填写 QQ 邮箱的 IMAP 授权码。")
    state = read_json("state.json") if Path("state.json").exists() else {}
    if state:
        if (not isinstance(state.get("account"), str) or state.get("mailbox") != "INBOX"
                or not isinstance(state.get("uidvalidity"), str) or not state["uidvalidity"].isdigit()
                or type(state.get("last_uid")) is not int or state["last_uid"] < 0):
            raise MVPError("state.json 结构错误，请先检查，未修改记录。")
        if not Path("records.csv").exists():
            raise MVPError("存在邮件进度但 records.csv 丢失，请恢复 CSV，或在新目录重新开始。")
    records = read_records()
    known = set(records["source_key"])
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
            raise MVPError("state.json 中 last_uid 非法，请先检查。")
        if state and not same_mailbox:
            print("邮箱或 UIDVALIDITY 发生变化，将重新扫描收件箱，并使用新的来源标识。")
        # 不依赖已读状态；过滤大于游标的 UID，兼容服务器对 n:* 的范围解释。
        status, data = connection.uid("SEARCH", None, "UID", f"{last_uid + 1}:*")
        require_ok(status, "搜索邮件")
        uids = sorted({int(value) for value in (data[0] or b"").split() if int(value) > last_uid})
        for uid in uids:
            status, size_data = connection.uid("FETCH", str(uid), "(RFC822.SIZE)")
            require_ok(status, "读取邮件大小")
            size_metadata = b" ".join(item for item in size_data if isinstance(item, bytes))
            size_match = re.search(rb"RFC822.SIZE (\d+)", size_metadata)
            if not size_match:
                raise MVPError(f"UID {uid} 无法读取大小，停止处理；下次可重试。")
            if int(size_match[1]) > config["max_email_bytes"]:
                # 不推进此邮件，以便调高配置后可直接重试，避免静默永久漏掉。
                raise MVPError(f"UID {uid} 超过 max_email_bytes；请调高限制后重试，或人工移出收件箱。")
            status, data = connection.uid("FETCH", str(uid), "(BODY.PEEK[] INTERNALDATE)")
            require_ok(status, "下载邮件")
            body = next((item for item in data if isinstance(item, tuple) and isinstance(item[1], bytes)), None)
            if body is None:
                raise MVPError(f"UID {uid} 下载不完整，停止处理；下次可重试。")
            rows = attachment_rows(body[1], body[0], config, validity, uid, known)
            if rows:
                records = pd.concat([records, pd.DataFrame(rows, columns=COLUMNS)], ignore_index=True)
            if rows or not Path("records.csv").exists():
                save_records(records)
            if rows:
                known.update(row["source_key"] for row in rows)
                total += len(rows)
            # 必须先持久化记录，再保存游标；两步之间崩溃时由 source_key 保证幂等。
            save_json("state.json", dict(account=account, mailbox="INBOX", uidvalidity=validity, last_uid=uid))
        print(f"处理完成：检查 {len(uids)} 封邮件，新增 {total} 条附件记录。")
        if not config["_window"]:
            print("当前仅校验照片坐标，未校验拍摄时间；结果不证明本人到场。")
    finally:
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                pass


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


def generate_report():
    from openpyxl import Workbook

    records = read_records()
    if records.empty:
        raise MVPError("没有可导出的记录，请先执行 fetch。")
    for column in ("student_id", "student_name", "attendance_window", "validation_scope"):
        if records[column].str.strip().eq("").any():
            raise MVPError(f"records.csv 的 {column} 存在空值，请先核对。")
    # 检查已有数值，避免手工修改的 CSV 把非法值带入报表。
    for column in ("exif_lat", "exif_lon", "distance"):
        for value in records[column]:
            if value:
                try:
                    number = float(value)
                    if not math.isfinite(number):
                        raise ValueError
                except (TypeError, ValueError):
                    raise MVPError(f"records.csv 的 {column} 包含非法数值。") from None
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
        "CSV 是本地可信工作文件，手工修改会影响结果；跨不同校验配置的记录请使用不同工作目录。",
    ):
        notes.append([text])
    notes.column_dimensions["A"].width = 120
    destination = Path("考勤汇总报表.xlsx")
    try:
        with atomic_path(destination) as temp:
            workbook.save(temp)
    finally:
        workbook.close()
    print(f"已生成 {destination}：{len(records)} 条附件明细，{len(summary_rows)} 条学生汇总。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="照片打卡校验 MVP（元数据不能证明本人到场）")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="生成默认配置，不覆盖已有文件")
    subparsers.add_parser("fetch", help="从 QQ 邮箱收件箱增量处理照片附件")
    subparsers.add_parser("report", help="生成带颜色的 Excel 明细与汇总")
    args = parser.parse_args(argv)
    try:
        with single_process():
            {"init": init_config, "fetch": fetch_emails, "report": generate_report}[args.command]()
        return 0
    except ModuleNotFoundError:
        print("错误：缺少依赖，请执行 python -m pip install -r requirements.txt。", file=sys.stderr)
    except imaplib.IMAP4.error:
        # 不直接显示服务器异常，避免异常正文中含有账户/认证信息。
        print("错误：邮箱操作失败。请检查 IMAP 服务是否启用、授权码与连接状态；已保存数据可重试。", file=sys.stderr)
    except MVPError as exc:
        print(f"错误：{exc}", file=sys.stderr)
    except (OSError, EOFError):
        print("错误：网络或文件读写失败。请检查连接、目录权限、磁盘空间以及报表是否被占用，然后重试。", file=sys.stderr)
    except KeyboardInterrupt:
        print("\n操作已中断，已保存的数据可在下次继续处理。", file=sys.stderr)
        return 130
    return 1


if __name__ == "__main__":
    sys.exit(main())
