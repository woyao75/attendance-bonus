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
