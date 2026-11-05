"""离线回归测试：真实 EXIF 字节 + 模拟 IMAP，不需要真实邮箱或新增测试依赖。"""

from contextlib import redirect_stderr, redirect_stdout
from email.message import EmailMessage
import io
import os
from pathlib import Path
import re
import struct
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
import pandas as pd

import mvp_agent as app


def exif_jpeg(lat=(39, 54, 15.12), lon=(116, 24, 26.64), refs=("N", "E"),
              shoot="2026:11:05 08:30:00", offset="+08:00", zero_denominator=False):
    """手工构造含 GPS/拍摄时间 IFD 的 JPEG 元数据样本，不模拟 EXIF 解析器。"""
    gps_at, exif_at, data_at = 38, 92, 122
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

    root = struct.pack("<H", 2)
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


class MVPTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = Path.cwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, self.original_cwd)
        config = {**app.DEFAULT_CONFIG, "email_account": "teacher@qq.com", "imap_auth_code": "TEST-SECRET"}
        app.save_json("config.json", config)

    def config(self, **updates):
        config = app.read_json("config.json")
        config.update(updates)
        app.save_json("config.json", config)
        return app.load_config()

    def fetch(self, server):
        with patch.object(app.imaplib, "IMAP4_SSL", return_value=server), redirect_stdout(io.StringIO()):
            app.fetch_emails()

    def photo(self, **options):
        path = Path("input.jpg")
        path.write_bytes(exif_jpeg(**options))
        return path

    def test_real_exif_and_server_received_time(self):
        server = FakeIMAP({10: message_bytes()})
        self.fetch(server)
        records = app.read_records()
        row = records.iloc[0]
        self.assertEqual(row["student_id"], "0020230001")
        self.assertEqual(row["student_name"], "张三")
        self.assertEqual(row["email_time"], "2026-11-05T08:05:00+08:00")
        self.assertAlmostEqual(float(row["exif_lat"]), 39.9042)
        self.assertAlmostEqual(float(row["exif_lon"]), 116.4074)
        self.assertTrue(row["is_valid"])
        self.assertTrue(server.logged_out)

    def test_repeat_fetch_is_idempotent(self):
        server = FakeIMAP({10: message_bytes()})
        self.fetch(server)
        self.fetch(server)
        self.assertEqual(len(app.read_records()), 1)
        self.assertEqual(sum(call[0] == "FETCH" for call in server.calls), 2)

    def test_recover_after_csv_saved_but_checkpoint_failed(self):
        server = FakeIMAP({10: message_bytes(), 11: message_bytes("【打卡】0020230002-李四")})
        original_save = app.save_json

        def fail_state(path, value):
            if path == "state.json":
                raise OSError("模拟磁盘错误")
            original_save(path, value)

        with patch.object(app, "save_json", side_effect=fail_state):
            with self.assertRaises(OSError):
                self.fetch(server)
        self.assertEqual(len(app.read_records()), 1)
        self.assertFalse(Path("state.json").exists())
        self.fetch(server)
        self.assertEqual(len(app.read_records()), 2)
        self.assertEqual(app.read_json("state.json")["last_uid"], 11)

    def test_uidvalidity_change_gets_distinct_sources(self):
        self.fetch(FakeIMAP({10: message_bytes()}))
        self.fetch(FakeIMAP({10: message_bytes()}, validity=b"102"))
        self.assertEqual(len(app.read_records()), 2)
        self.assertEqual(app.read_json("state.json")["uidvalidity"], "102")

    def test_missing_records_with_checkpoint_is_rejected(self):
        self.fetch(FakeIMAP({10: message_bytes()}))
        Path("records.csv").unlink()
        with self.assertRaises(app.MVPError):
            self.fetch(FakeIMAP({10: message_bytes()}))

    def test_atomic_csv_failure_keeps_old_records_and_checkpoint(self):
        self.fetch(FakeIMAP({10: message_bytes()}))
        before = Path("records.csv").read_bytes()
        original_replace = app.os.replace

        def fail_csv(source, target):
            if Path(target).name == "records.csv":
                raise OSError("模拟替换失败")
            return original_replace(source, target)

        with patch.object(app.os, "replace", side_effect=fail_csv):
            with self.assertRaises(OSError):
                self.fetch(FakeIMAP({10: message_bytes(), 11: message_bytes()}))
        self.assertEqual(Path("records.csv").read_bytes(), before)
        self.assertEqual(app.read_json("state.json")["last_uid"], 10)
        self.assertFalse(list(Path(".").glob(".mvp-*")))

    def test_invalid_subjects_and_no_jpeg_advance_cursor(self):
        self.fetch(FakeIMAP({1: message_bytes("Re: 【打卡】123-张三"),
                             2: message_bytes(photos=[("picture.png", b"png")])}))
        self.assertTrue(app.read_records().empty)
        self.assertTrue(Path("records.csv").exists())
        self.assertEqual(app.read_json("state.json")["last_uid"], 2)

    def test_attachments_are_isolated_and_paths_are_safe(self):
        original_config = Path("config.json").read_bytes()
        photos = [("../../config.json.jpg", exif_jpeg()),
                  ("bad.JPG", b"not jpeg"), ("empty.jpeg", b""),
                  ("zero.jpg", exif_jpeg(zero_denominator=True)),
                  ("last.jpg", exif_jpeg())]
        self.fetch(FakeIMAP({10: message_bytes(photos=photos)}))
        records = app.read_records()
        self.assertEqual(len(records), 5)
        self.assertEqual(list(records["is_valid"]), [True, False, False, False, True])
        self.assertEqual(Path("config.json").read_bytes(), original_config)
        self.assertEqual(len(list(Path("attachments").glob("*.jpg"))), 3)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}\.jpg", path.name)
                            for path in Path("attachments").iterdir()))

    def test_south_west_coordinates(self):
        config = self.config(target_lat=-39.9042, target_lon=-116.4074)
        row = app.evaluate_photo(self.photo(refs=("S", "W")), config)
        self.assertTrue(row["is_valid"])
        self.assertLess(row["exif_lat"], 0)
        self.assertLess(row["exif_lon"], 0)

    def test_out_of_range_and_zero_denominator_gps(self):
        for options in ({"lat": (91, 0, 0)}, {"lat": (39, 60, 0)},
                        {"zero_denominator": True}, {"refs": ("X", "E")}):
            with self.subTest(options=options):
                row = app.evaluate_photo(self.photo(**options), app.load_config())
                self.assertFalse(row["is_valid"])
                self.assertIn("待人工核验", row["reason"])

    def test_distance_formula_boundary_and_no_rounding_before_comparison(self):
        self.assertAlmostEqual(app.haversine(0, 0, 0, 1), 111194.92664455874)
        self.assertAlmostEqual(app.haversine(0, 0, 0, 180), 20015086.79602057)
        path = self.photo()
        config = self.config(target_lat=39.90)
        distance = app.evaluate_photo(path, config)["distance"]
        config["threshold_meters"] = distance
        self.assertTrue(app.evaluate_photo(path, config)["is_valid"])
        config["threshold_meters"] = distance - 0.000001
        self.assertFalse(app.evaluate_photo(path, config)["is_valid"])

    def test_time_window_old_missing_and_boundary(self):
        config = self.config(attendance_start="2026-11-05T08:00:00+08:00",
                             attendance_end="2026-11-05T10:00:00+08:00")
        for stamp, valid in [("2026:11:05 08:00:00", True), ("2026:11:05 10:00:00", True),
                             ("2025:11:05 08:30:00", False), ("", False)]:
            with self.subTest(stamp=stamp):
                self.assertEqual(app.evaluate_photo(self.photo(shoot=stamp), config)["is_valid"], valid)

    def test_exif_timezone_takes_precedence_and_config_is_fallback(self):
        config = self.config(attendance_start="2026-11-05T08:00:00+08:00",
                             attendance_end="2026-11-05T10:00:00+08:00")
        self.assertTrue(app.evaluate_photo(self.photo(shoot="2026:11:05 00:30:00", offset="+00:00"), config)["is_valid"])
        self.assertTrue(app.evaluate_photo(self.photo(offset=""), config)["is_valid"])
        self.assertFalse(app.evaluate_photo(self.photo(offset="invalid"), config)["is_valid"])

    def test_message_and_attachment_size_limits(self):
        self.config(max_attachment_bytes=20)
        self.fetch(FakeIMAP({10: message_bytes()}))
        self.assertEqual(app.read_records().iloc[0]["reason"], "附件超过大小限制")
        self.config(max_email_bytes=20)
        with self.assertRaises(app.MVPError):
            self.fetch(FakeIMAP({11: message_bytes()}))
        self.assertEqual(app.read_json("state.json")["last_uid"], 10)

    def test_report_format_formula_safety_and_student_aggregation(self):
        photos = [("=1+1.jpg", exif_jpeg()), ("bad.jpg", b"bad"), ("another.jpeg", exif_jpeg())]
        self.fetch(FakeIMAP({10: message_bytes(subject="【打卡】0020230001-=1+1", photos=photos)}))
        with redirect_stdout(io.StringIO()):
            app.generate_report()
        workbook = load_workbook("考勤汇总报表.xlsx", data_only=False)
        self.addCleanup(workbook.close)
        details, summary = workbook["附件明细"], workbook["学生汇总"]
        self.assertTrue(details["A1"].font.bold)
        self.assertEqual(details["A2"].value, "0020230001")
        self.assertEqual(details["B2"].value, "=1+1")
        self.assertEqual(details["B2"].data_type, "s")
        self.assertEqual(details["D2"].data_type, "s")
        self.assertEqual(details["I2"].value, "有效")
        self.assertTrue(details["I3"].value.startswith("无效("))
        self.assertEqual(details["A2"].fill.fgColor.rgb, "00E2F0D9")
        self.assertEqual(details["A3"].fill.fgColor.rgb, "00FCE4D6")
        self.assertEqual(summary.max_row, 2)
        self.assertEqual(summary["D2"].value, 3)
        self.assertEqual(summary["E2"].value, 2)
        self.assertEqual(summary["F2"].value, "校验通过")
        self.assertIn("未校验拍摄时间", summary["C2"].value)
        self.assertEqual(details.freeze_panes, "A2")

    def test_conflicting_student_names_require_manual_review(self):
        self.fetch(FakeIMAP({10: message_bytes(), 11: message_bytes("【打卡】0020230001-李四")}))
        with redirect_stdout(io.StringIO()):
            app.generate_report()
        workbook = load_workbook("考勤汇总报表.xlsx")
        self.addCleanup(workbook.close)
        self.assertIn("姓名冲突", workbook["学生汇总"]["F2"].value)

    def test_boolean_strings_duplicates_and_conflicts(self):
        self.fetch(FakeIMAP({10: message_bytes(photos=[("bad.jpg", b"bad")])}))
        frame = app.read_records()
        self.assertFalse(frame.iloc[0]["is_valid"])
        app.save_records(pd.concat([frame, frame], ignore_index=True))
        self.assertEqual(len(app.read_records()), 1)
        changed = frame.copy()
        changed["reason"] = "conflicting reason"
        app.save_records(pd.concat([frame, changed], ignore_index=True))
        with self.assertRaises(app.MVPError):
            app.read_records()
        frame["is_valid"] = "maybe"
        app.save_records(frame)
        with self.assertRaises(app.MVPError):
            app.read_records()

    def test_init_no_overwrite_empty_report_and_lock_cleanup(self):
        original = Path("config.json").read_bytes()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(app.main(["init"]), 1)
            self.assertEqual(app.main(["report"]), 1)
        self.assertEqual(Path("config.json").read_bytes(), original)
        self.assertFalse(Path(".mvp_agent.lock").exists())
        with app.single_process():
            with redirect_stderr(stderr):
                self.assertEqual(app.main(["init"]), 1)
        self.assertFalse(Path(".mvp_agent.lock").exists())

    def test_bad_config_returns_clear_error(self):
        for updates in ({"target_lat": 91}, {"target_lon": "NaN"}, {"threshold_meters": -1},
                        {"attendance_start": "2026-11-05T08:00:00+08:00"},
                        {"photo_timezone": "+08:99"}):
            with self.subTest(updates=updates):
                app.save_json("config.json", {**app.DEFAULT_CONFIG, **updates})
                with self.assertRaises(app.MVPError):
                    app.load_config()

    def test_auth_error_does_not_expose_credentials(self):
        stderr = io.StringIO()
        with patch.object(app.imaplib, "IMAP4_SSL", side_effect=app.imaplib.IMAP4.error("TEST-SECRET")):
            with redirect_stderr(stderr):
                self.assertEqual(app.main(["fetch"]), 1)
        self.assertNotIn("TEST-SECRET", stderr.getvalue())
        self.assertFalse(Path(".mvp_agent.lock").exists())


if __name__ == "__main__":
    unittest.main()
