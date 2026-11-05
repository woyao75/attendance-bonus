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



def message_bytes(subject="张三+0020230001", photos=None):
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

