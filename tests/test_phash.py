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
