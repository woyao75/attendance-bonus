"""邮件、真实 EXIF 与报表业务回归，全部使用 SQLite。"""

from contextlib import redirect_stderr, redirect_stdout
import io
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
import pandas as pd

from src import cli, common, email_fetcher
from src import exif_validator as app
from src.config import DEFAULT_CONFIG, load_config
from src.data_store import SqliteDataStore
from src.report_generator import generate_report
from tests.helpers import FakeIMAP, exif_jpeg, message_bytes


class MVPTests(unittest.TestCase):
    def records(self):
        return pd.DataFrame(self.store.load_records(), columns=common.COLUMNS)

    def setUp(self):
        self.original_cwd = Path.cwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, self.original_cwd)
        config = {**DEFAULT_CONFIG, "email_account": "teacher@qq.com"}
        Path(".env").write_text("IMAP_AUTH_CODE=TEST-SECRET\n", encoding="utf-8")
        common.save_json("config.json", config)
        self.store = SqliteDataStore()


    def config(self, **updates):
        config = common.read_json("config.json")
        config.update(updates)
        common.save_json("config.json", config)
        return load_config()


    def fetch(self, server):
        with patch.object(email_fetcher.imaplib, "IMAP4_SSL", return_value=server), redirect_stdout(io.StringIO()):
            email_fetcher.fetch_emails(load_config(), self.store)


    def photo(self, **options):
        path = Path("input.jpg")
        path.write_bytes(exif_jpeg(**options))
        return path


    def test_real_exif_and_server_received_time(self):
        server = FakeIMAP({10: message_bytes()})
        self.fetch(server)
        records = self.records()
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
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(sum(call[0] == "FETCH" for call in server.calls), 2)

    def test_resume_after_second_email_save_failure(self):
        server = FakeIMAP({10: message_bytes(), 11: message_bytes("李四+0020230002")})
        original_commit = self.store.commit_batch

        def fail_second(records, checkpoint):
            if checkpoint["last_uid"] == 11:
                raise OSError("模拟第二封邮件保存失败")
            return original_commit(records, checkpoint)

        with patch.object(self.store, "commit_batch", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.fetch(server)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 10)
        self.fetch(server)
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 11)

    def test_legacy_state_does_not_skip_mail_in_new_database(self):
        common.save_json("state.json", dict(account="teacher@qq.com", mailbox="INBOX", uidvalidity="101", last_uid=1000))
        self.fetch(FakeIMAP({10: message_bytes()}))
        self.assertEqual(len(self.records()), 1)

    def test_migrated_sources_deduplicate_on_first_sqlite_fetch(self):
        from scripts.migrate_csv_to_sqlite import migrate

        self.fetch(FakeIMAP({10: message_bytes()}))
        self.records().drop(columns=["photo_path"]).to_csv("old.csv", index=False, encoding="utf-8-sig")
        migrated = SqliteDataStore("data/migrated.db")
        migrate("old.csv", migrated.path, Path.cwd())
        self.store = migrated
        self.fetch(FakeIMAP({10: message_bytes()}))
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 10)


    def test_uidvalidity_change_gets_distinct_sources(self):
        self.fetch(FakeIMAP({10: message_bytes()}))
        self.fetch(FakeIMAP({10: message_bytes()}, validity=b"102"))
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(self.store.load_checkpoint()["uidvalidity"], "102")


    def test_invalid_subjects_and_no_jpeg_advance_cursor(self):
        self.fetch(FakeIMAP({1: message_bytes("Re: 【打卡】123-张三"),
                             2: message_bytes(photos=[("picture.png", b"png")])}))
        self.assertTrue(self.records().empty)
        self.assertTrue(self.store.path.exists())
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 2)


    def test_attachments_are_isolated_and_paths_are_safe(self):
        original_config = Path("config.json").read_bytes()
        photos = [("../../config.json.jpg", exif_jpeg()),
                  ("bad.JPG", b"not jpeg"), ("empty.jpeg", b""),
                  ("zero.jpg", exif_jpeg(zero_denominator=True)),
                  ("last.jpg", exif_jpeg())]
        self.fetch(FakeIMAP({10: message_bytes(photos=photos)}))
        records = self.records()
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
                row = app.evaluate_photo(self.photo(**options), load_config())
                self.assertFalse(row["is_valid"])
                self.assertIn("待人工核验", row["reason"])


    def test_distance_formula_boundary_and_no_rounding_before_comparison(self):
        self.assertAlmostEqual(app.haversine(0, 0, 0, 1), 111194.92664455874)
        self.assertAlmostEqual(app.haversine(0, 0, 0, 180), 20015086.79602057)
        path = self.photo()
        config = self.config(target_lat=39.90)
        distance = app.evaluate_photo(path, config)["distance"]
        config.threshold_meters = distance
        self.assertTrue(app.evaluate_photo(path, config)["is_valid"])
        config.threshold_meters = distance - 0.000001
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
        self.assertEqual(self.records().iloc[0]["reason"], "附件超过大小限制")
        self.config(max_email_bytes=20)
        with self.assertRaises(app.MVPError):
            self.fetch(FakeIMAP({11: message_bytes()}))
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 10)


    def test_report_format_formula_safety_and_student_aggregation(self):
        photos = [("=1+1.jpg", exif_jpeg()), ("bad.jpg", b"bad"), ("another.jpeg", exif_jpeg())]
        self.fetch(FakeIMAP({10: message_bytes(subject="=SUM(A1)+0020230001", photos=photos)}))
        with redirect_stdout(io.StringIO()):
            generate_report(self.store, "考勤汇总报表.xlsx")
        workbook = load_workbook("考勤汇总报表.xlsx", data_only=False)
        self.addCleanup(workbook.close)
        details, summary = workbook["附件明细"], workbook["学生汇总"]
        self.assertTrue(details["A1"].font.bold)
        self.assertEqual(details["A2"].value, "0020230001")
        self.assertEqual(details["B2"].value, "=SUM(A1)")
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
        self.fetch(FakeIMAP({10: message_bytes(), 11: message_bytes("李四+0020230001")}))
        with redirect_stdout(io.StringIO()):
            generate_report(self.store, "考勤汇总报表.xlsx")
        workbook = load_workbook("考勤汇总报表.xlsx")
        self.addCleanup(workbook.close)
        self.assertIn("姓名冲突", workbook["学生汇总"]["F2"].value)


    def test_init_no_overwrite_empty_report_and_lock_cleanup(self):
        original = Path("config.json").read_bytes()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(cli.main(["init"]), 1)
            self.assertEqual(cli.main(["report"]), 1)
        self.assertEqual(Path("config.json").read_bytes(), original)
        self.assertFalse(Path(".mvp_agent.lock").exists())
        with common.single_process():
            with redirect_stderr(stderr):
                self.assertEqual(cli.main(["init"]), 1)
        self.assertFalse(Path(".mvp_agent.lock").exists())


    def test_bad_config_returns_clear_error(self):
        for updates in ({"target_lat": 91}, {"target_lon": "NaN"}, {"threshold_meters": -1},
                        {"attendance_start": "2026-11-05T08:00:00+08:00"},
                        {"photo_timezone": "+08:99"}):
            with self.subTest(updates=updates):
                common.save_json("config.json", {**DEFAULT_CONFIG, **updates})
                with self.assertRaises(app.MVPError):
                    load_config()


    def test_auth_error_does_not_expose_credentials(self):
        stderr = io.StringIO()
        with patch.object(email_fetcher.imaplib, "IMAP4_SSL", side_effect=email_fetcher.imaplib.IMAP4.error("TEST-SECRET")):
            with redirect_stderr(stderr):
                self.assertEqual(cli.main(["fetch"]), 1)
        self.assertNotIn("TEST-SECRET", stderr.getvalue())
        self.assertFalse(Path(".mvp_agent.lock").exists())



if __name__ == "__main__":
    unittest.main()
