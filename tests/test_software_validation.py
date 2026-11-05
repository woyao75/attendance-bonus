"""Software 校验、历史数据库升级与逐附件异常隔离。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

from src.config import AppConfig, DEFAULT_CONFIG
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.exif_validator import evaluate_photo
from src.report_generator import generate_report
from tests.helpers import FakeIMAP, exif_jpeg, message_bytes
from tests.test_sqlite import record


class SoftwareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config = AppConfig(**{**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "imap_auth_code": "secret"})

    def evaluate(self, software=None, **options):
        path = self.folder / "photo.jpg"
        path.write_bytes(exif_jpeg(software=software, **options))
        return evaluate_photo(path, self.config)

    def test_real_software_tags_reject_editors_and_virtual_cameras(self):
        for software in ("美图秀秀", "P图软件 1.0", "虚拟相机", "Meitu XiuXiu 10.0",
                         "Adobe Photoshop 2026", "Virtual Camera 2.0", "ＶＩＲＴＵＡＬ ＣＡＭＥＲＡ", "pHoToShOp"):
            with self.subTest(software=software):
                row = self.evaluate(software)
                self.assertFalse(row["is_valid"])
                self.assertEqual(row["exif_software"], software)
                self.assertIn("命中禁用软件", row["software_check"])
                self.assertIn("软件信息校验未通过", row["reason"])

    def test_missing_empty_or_camera_software_keeps_original_checks(self):
        for software in (None, "", "iOS 18.0", "Android Camera"):
            with self.subTest(software=software):
                self.assertTrue(self.evaluate(software)["is_valid"])
                self.assertFalse(self.evaluate(software, lat=(40, 0, 0))["is_valid"])
        self.assertEqual(self.evaluate()["software_check"], "未提供Software标签")
        self.config = AppConfig(**{**self.config.model_dump(), "imap_auth_code": "secret",
                                   "attendance_start": "2026-11-05T09:00:00+08:00",
                                   "attendance_end": "2026-11-05T10:00:00+08:00"})
        self.assertIn("拍摄时间不在", self.evaluate("iOS 18.0")["reason"])

    def test_software_tag_failure_is_logged_and_next_attachment_still_commits(self):
        class BrokenTag:
            def __str__(self):
                raise RuntimeError("broken software value")

        import exifread
        original = exifread.process_file
        count = 0

        def process(*args, **kwargs):
            nonlocal count
            count += 1
            tags = original(*args, **kwargs)
            if count == 1:
                tags["Image Software"] = BrokenTag()
            return tags

        store = SqliteDataStore(self.folder / "test.db")
        messages = {10: message_bytes(photos=[("bad.jpg", exif_jpeg()), ("good.jpg", exif_jpeg())]),
                    11: message_bytes()}
        server = FakeIMAP(messages)
        with patch("exifread.process_file", side_effect=process), self.assertLogs("src.exif_validator", level="ERROR") as logs:
            with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=server):
                result = fetch_emails(self.config, store, self.folder)
        self.assertEqual(result, {"emails": 2, "records": 3})
        rows = store.load_records()
        self.assertEqual([row["is_valid"] for row in rows], [False, True, True])
        self.assertIn("校验异常", rows[0]["software_check"])
        self.assertIn("校验异常", rows[0]["reason"])
        self.assertIn("Traceback", "\n".join(logs.output))
        self.assertEqual(store.load_checkpoint()["last_uid"], 11)
        self.assertTrue(server.logged_out)

    def test_parser_errors_do_not_escape_validation(self):
        for error in (ValueError("corrupt EXIF"), OSError("parser failure")):
            with self.subTest(error=error), patch("exifread.process_file", side_effect=error):
                with self.assertLogs("src.exif_validator", level="ERROR"):
                    row = self.evaluate()
                self.assertFalse(row["is_valid"])
                self.assertIn("校验异常", row["reason"])

    def test_old_schema_upgrade_preserves_rows_and_checkpoint_and_is_repeatable(self):
        path = self.folder / "old.db"
        # 使用升级前的字段集合创建真实旧库，保留唯一约束和旧邮件进度。
        old_columns = list(record())
        with closing(sqlite3.connect(path)) as connection, connection:
            definitions = [f'"{key}" {"INTEGER" if key == "is_valid" else "TEXT"}' for key in old_columns]
            connection.execute("CREATE TABLE attendance_records (id INTEGER PRIMARY KEY, " +
                               ", ".join(definitions) + ", created_at TEXT DEFAULT 'old-time', UNIQUE(source_key))")
            connection.execute("INSERT INTO attendance_records (" + ", ".join(old_columns) + ") VALUES (" +
                               ", ".join("?" for _ in old_columns) + ")", list(record().values()))
            connection.execute("CREATE TABLE mail_checkpoint (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            connection.execute('INSERT INTO mail_checkpoint VALUES (1, ?)',
                               ('{"account":"teacher@qq.com","mailbox":"INBOX","uidvalidity":"101","last_uid":10}',))
        with ThreadPoolExecutor(max_workers=4) as pool:
            stores = list(pool.map(lambda _: SqliteDataStore(path), range(4)))
        store = stores[0]
        row = store.load_records()[0]
        self.assertEqual(row["created_at"], "old-time")
        self.assertEqual(row["software_check"], "未校验")
        self.assertEqual(row["exif_software"], "")
        self.assertTrue(row["is_valid"])
        self.assertEqual(store.load_checkpoint()["last_uid"], 10)
        self.assertEqual(len(SqliteDataStore(path).load_records()), 1)

    def test_software_results_roundtrip_and_excel_export(self):
        store = SqliteDataStore(self.folder / "test.db")
        row = {**record(), **self.evaluate("美图秀秀")}
        self.assertEqual(store.save_records([row]), 1)
        self.assertEqual(store.save_records([row]), 0)
        self.assertEqual(store.load_records()[0]["exif_software"], "美图秀秀")
        workbook = load_workbook(BytesIO(generate_report(store)))
        self.addCleanup(workbook.close)
        sheet = workbook["附件明细"]
        headers = [cell.value for cell in sheet[1]]
        self.assertEqual(sheet.cell(2, headers.index("exif_software") + 1).value, "美图秀秀")
        self.assertIn("未通过", sheet.cell(2, headers.index("software_check") + 1).value)


if __name__ == "__main__":
    unittest.main()
