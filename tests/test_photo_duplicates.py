"""照片相似比对的边界、事务、并发、历史迁移及真实页面交互。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
from io import BytesIO, StringIO
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from PIL import Image
from streamlit.testing.v1 import AppTest

from scripts.recheck_photo_duplicates import main as recheck_main
from src.common import DUPLICATE_COLUMNS, MVPError, save_json
from src.config import DEFAULT_CONFIG, load_config
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.exif_validator import calculate_photo_phash
from src.logger import close_logging
from src.photo_deduplicator import compare_photo, hamming_distance
from src.report_generator import generate_report
from tests.helpers import FakeIMAP, message_bytes
from tests.test_phash import jpeg_bytes
from tests.test_sqlite import record

ROOT = Path(__file__).resolve().parents[1]


def hashed(key, value="0000000000000000", threshold=5, **changes):
    return {**record(key), "photo_phash": value, "phash_status": "已计算", "phash_reason": "",
            "duplicate_threshold": threshold, **changes}


class DuplicateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(close_logging)
        self.folder = Path(self.temp.name)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")

    def test_hamming_distance_and_exclude_same_source(self):
        self.assertEqual(hamming_distance("0" * 16, "f" * 16), 64)
        self.assertEqual(hamming_distance("A" * 16, "a" * 16), 0)
        self.assertEqual(hamming_distance("0" * 16, "000000000000001f"), 5)
        for value in ("0", "z" * 16, None):
            with self.assertRaises(ValueError):
                hamming_distance(value, "0" * 16)
        result = compare_photo(hashed("same"), [dict(id=1, source_key="same", photo_phash="0" * 16)])
        self.assertEqual(result["duplicate_status"], "未发现重复")

    def test_threshold_inclusive_nearest_and_tie_break(self):
        self.store.save_records([hashed("first", threshold=1), hashed("second", "0000000000000003", 1),
                                 hashed("third", "0000000000000007", 1)])
        rows = self.store.load_records()
        self.assertEqual([row["duplicate_status"] for row in rows], ["未发现重复", "未发现重复", "疑似重复"])
        self.assertEqual(rows[2]["duplicate_record_id"], rows[1]["id"])
        self.assertEqual(rows[2]["duplicate_distance"], 1)
        # 距离恰好等于阈值算命中，超过一位不命中。
        other = SqliteDataStore(self.folder / "bounds.db")
        other.save_records([hashed("base"), hashed("edge", "000000000000001f"),
                            hashed("outside", "00000000000007e0")])
        self.assertEqual([r["duplicate_status"] for r in other.load_records()], ["未发现重复", "疑似重复", "未发现重复"])
        tied = compare_photo(hashed("new"), [dict(id=9, source_key="b", photo_phash="0" * 16),
                                                 dict(id=2, source_key="a", photo_phash="0" * 16)])
        self.assertEqual(tied["duplicate_record_id"], 2)

    def test_cross_student_window_and_idempotent_import(self):
        first = hashed("first", student_id="0001")
        second = hashed("second", student_id="0002", attendance_window="另一窗口")
        self.assertEqual(self.store.save_records([first, second]), 2)
        before = self.store.load_records()
        self.assertEqual(before[1]["duplicate_status"], "疑似重复")
        self.assertEqual(before[1]["duplicate_distance"], 0)
        self.assertTrue(before[1]["is_valid"])
        self.assertEqual(before[1]["reason"], "有效")
        self.assertEqual(self.store.save_records([first, second]), 0)
        self.assertEqual(before, self.store.load_records())
        self.assertEqual(self.store.count_records(True, "疑似重复"), 1)
        self.assertEqual(self.store.query_records(duplicate_status="疑似重复")[0]["student_id"], "0002")
        for options in ({"duplicate_status": "' OR 1=1"}, {"is_valid": 1}):
            with self.assertRaises(MVPError):
                self.store.count_records(**options)

    def test_concurrent_equal_photos_cannot_both_pass(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda n: self.store.save_records([hashed(f"source:{n}")]), range(12)))
        self.assertEqual(sum(results), 12)
        rows = self.store.load_records()
        self.assertEqual(rows[0]["duplicate_status"], "未发现重复")
        self.assertTrue(all(row["duplicate_record_id"] == rows[0]["id"] for row in rows[1:]))

    def test_comparison_failure_isolated_and_hash_failure_visible(self):
        calls = 0

        def fail_once(first, second):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("模拟相似比对故障")
            return hamming_distance(first, second)

        with patch("src.photo_deduplicator.hamming_distance", side_effect=fail_once), self.assertLogs("src.photo_deduplicator", "ERROR"):
            self.store.save_records([hashed("broken"), hashed("next")])
        self.assertEqual([r["duplicate_status"] for r in self.store.load_records()], ["校验异常", "疑似重复"])
        self.store.save_records([{**record("hash-error"), "phash_status": "校验异常", "phash_reason": "图片损坏"}, record("missing")])
        self.assertEqual([r["duplicate_status"] for r in self.store.load_records()][-2:], ["校验异常", "未校验"])

    def test_corrupt_historical_hash_does_not_silently_pass(self):
        self.store.save_records([hashed("old")])
        with closing(sqlite3.connect(self.store.path)) as connection, connection:
            connection.execute("UPDATE attendance_records SET photo_phash = 'broken'")
        with self.assertLogs("src.photo_deduplicator", "ERROR"):
            self.store.save_records([hashed("new"), hashed("another")])
        rows = self.store.load_records()
        self.assertEqual(rows[1]["duplicate_status"], "校验异常")
        self.assertEqual(rows[2]["duplicate_status"], "疑似重复")
        self.assertEqual(rows[2]["duplicate_record_id"], rows[1]["id"])

    def test_real_recompressed_and_resized_photo_matches(self):
        original = self.folder / "original.jpg"
        variant = self.folder / "variant.jpg"
        original.write_bytes(jpeg_bytes())
        with Image.open(original) as image:
            with image.resize((96, 72)) as resized:
                resized.save(variant, quality=55)
        first, second = calculate_photo_phash(original), calculate_photo_phash(variant)
        self.assertLessEqual(hamming_distance(first["photo_phash"], second["photo_phash"]), 5)
        self.store.save_records([{**record("original"), **first}, {**record("variant"), **second}])
        self.assertEqual(self.store.load_records()[1]["duplicate_status"], "疑似重复")

    def test_fetch_uses_config_threshold_and_continues_after_error(self):
        save_json(self.folder / "config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "phash_distance_threshold": 0})
        (self.folder / ".env").write_text("IMAP_AUTH_CODE=TEST-SECRET\n")
        config = load_config(self.folder / "config.json", self.folder / ".env")
        image = jpeg_bytes()
        messages = {10: message_bytes(photos=[("a.jpg", image), ("b.jpg", image)]),
                    11: message_bytes("李四+0002", [("c.jpg", image)])}
        actual_distance = hamming_distance
        calls = 0

        def fail_once(first, second):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("比对故障")
            return actual_distance(first, second)

        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=FakeIMAP(messages)), \
                patch("src.photo_deduplicator.hamming_distance", side_effect=fail_once), \
                self.assertLogs("src.photo_deduplicator", "ERROR"):
            result = fetch_emails(config, self.store, self.folder)
        self.assertEqual(result, {"emails": 2, "records": 3})
        rows = self.store.load_records()
        self.assertEqual([r["duplicate_status"] for r in rows], ["校验异常", "疑似重复", "疑似重复"])
        self.assertTrue(all(row["duplicate_threshold"] == 0 for row in rows))
        self.assertTrue(all(row["is_valid"] for row in rows))
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 11)

    def test_recheck_threshold_progress_and_rollback_preserve_base_results(self):
        state = dict(account="teacher@qq.com", mailbox="INBOX", uidvalidity="101", last_uid=10)
        self.store.commit_batch([hashed("one", threshold=0), hashed("two", "0000000000000001", 0)], state)
        before = self.store.load_records()
        progress = []
        counts = self.store.recheck_duplicates(1, lambda done, total: progress.append((done, total)))
        self.assertEqual(counts["疑似重复"], 1)
        self.assertEqual(progress, [(1, 2), (2, 2)])
        after = self.store.load_records()
        for old, new in zip(before, after):
            self.assertEqual({k: v for k, v in old.items() if k not in DUPLICATE_COLUMNS},
                             {k: v for k, v in new.items() if k not in DUPLICATE_COLUMNS})
        self.assertEqual(self.store.load_checkpoint(), state)
        with self.assertRaises(RuntimeError):
            self.store.recheck_duplicates(0, lambda *_: (_ for _ in ()).throw(RuntimeError("进度回调故障")))
        self.assertEqual(self.store.load_records(), after)
        for threshold in (-1, 65, True, 2.5, "5"):
            with self.assertRaises(MVPError):
                self.store.recheck_duplicates(threshold)

    def test_cli_recheck_and_invalid_config(self):
        self.store.save_records([hashed("one", threshold=0), hashed("two", "0000000000000001", 0)])
        with redirect_stdout(StringIO()):
            self.assertEqual(recheck_main(["--work-dir", str(self.folder), "--threshold", "1"]), 0)
        self.assertEqual(self.store.load_records()[1]["duplicate_status"], "疑似重复")
        for threshold in (-1, 65, True, "5", 2.5):
            save_json(self.folder / "config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "phash_distance_threshold": threshold})
            (self.folder / ".env").write_text("IMAP_AUTH_CODE=TEST-SECRET\n")
            with self.assertRaises(MVPError):
                load_config(self.folder / "config.json", self.folder / ".env")

    def test_bad_threshold_in_local_config_does_not_crash_ui(self):
        save_json(self.folder / "config.json", {"phash_distance_threshold": "bad"})
        with patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)}):
            app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=20).run()
        self.assertFalse(app.exception)
        self.assertTrue(any("相似度阈值无效" in item.value for item in app.warning))

    def test_ui_filter_related_preview_recheck_and_excel(self):
        (self.folder / "attachments").mkdir()
        (self.folder / "attachments/first.jpg").write_bytes(jpeg_bytes())
        self.store.save_records([hashed("one", photo_path="attachments/first.jpg"),
                                 hashed("two", student_id="0002", photo_path="attachments/missing.jpg")])
        with patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)}):
            app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=20).run()
            self.assertFalse(app.exception)
            self.assertEqual(app.metric[3].value, "1")
            app.selectbox(key="duplicate_filter").select("疑似重复").run()
            self.assertFalse(app.exception)
            self.assertEqual(len(app.dataframe[0].value), 1)
            self.assertEqual(app.dataframe[0].value.iloc[0]["照片重复判定"], "疑似重复")
            self.assertEqual(app.dataframe[0].value.iloc[0]["汉明距离"], 0)
            self.assertTrue(any("学号 0020230001" in item.value for item in app.caption))
            self.assertTrue(app.get("image"))
            # 历史比对不要求配置邮箱凭证。
            next(button for button in app.button if button.label == "重新比对历史照片").click().run()
            self.assertFalse(app.exception)
            self.assertTrue(any("历史比对完成" in item.value for item in app.success))
        workbook = load_workbook(BytesIO(generate_report(self.store)))
        self.addCleanup(workbook.close)
        values = list(workbook["附件明细"].values)
        header = values[0]
        self.assertEqual(values[2][header.index("duplicate_status")], "疑似重复")
        self.assertEqual(values[2][header.index("duplicate_record_id")], 1)
        self.assertEqual(values[1][header.index("id")], 1)
        summary = list(workbook["学生汇总"].values)
        self.assertIn("疑似重复附件数", summary[0])


class DuplicateMigrationTests(unittest.TestCase):
    def test_wal_lock_race_retries_but_other_errors_propagate(self):
        from unittest.mock import Mock

        connection = Mock()
        busy = sqlite3.OperationalError("database is locked")
        busy.sqlite_errorcode = sqlite3.SQLITE_BUSY
        connection.execute.side_effect = [busy, Mock()]
        with patch("src.data_store.time.sleep") as pause:
            SqliteDataStore._enable_wal(connection)
        self.assertEqual(connection.execute.call_count, 2)
        pause.assert_called_once_with(0.05)
        connection.execute.side_effect = sqlite3.OperationalError("disk failure")
        with self.assertRaises(sqlite3.OperationalError):
            SqliteDataStore._enable_wal(connection)
        connection.execute.side_effect = busy
        with patch("src.data_store.time.monotonic", side_effect=[0, 11]), self.assertRaises(sqlite3.OperationalError):
            SqliteDataStore._enable_wal(connection)

    def test_legacy_phash_schema_upgrade_is_repeatable_and_transactional(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "old.db"
            with closing(sqlite3.connect(path)) as connection, connection:
                connection.executescript("""
                    CREATE TABLE attendance_records (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT, student_name TEXT,
                        email_time TEXT, photo_name TEXT, exif_lat REAL, exif_lon REAL, shoot_time TEXT,
                        distance REAL, is_valid INTEGER, reason TEXT, created_at TEXT DEFAULT 'original-time',
                        source_key TEXT UNIQUE, attendance_window TEXT, validation_scope TEXT, photo_path TEXT,
                        exif_software TEXT, software_check TEXT,
                        photo_phash TEXT, phash_status TEXT, phash_reason TEXT
                    );
                    INSERT INTO attendance_records(source_key, photo_phash, phash_status, is_valid)
                    VALUES('old', '0000000000000000', '已计算', 1);
                """)
                connection.row_factory = sqlite3.Row

                class FailingConnection:
                    def execute(self, sql):
                        if "ADD COLUMN duplicate_distance" in sql:
                            raise sqlite3.OperationalError("模拟升级失败")
                        return connection.execute(sql)

                with self.assertRaises(sqlite3.OperationalError):
                    with connection:
                        SqliteDataStore._migrate_validation_columns(FailingConnection())
                fields = {row["name"] for row in connection.execute("PRAGMA table_info(attendance_records)")}
                self.assertFalse(set(DUPLICATE_COLUMNS) & fields)
                connection.execute("ALTER TABLE attendance_records ADD COLUMN duplicate_status TEXT NOT NULL DEFAULT '未校验'")
            with ThreadPoolExecutor(max_workers=4) as pool:
                rows = list(pool.map(lambda _: SqliteDataStore(path).load_records()[0], range(8)))
            for row in rows:
                self.assertEqual(row["duplicate_status"], "未校验")
                self.assertIsNone(row["duplicate_record_id"])
                self.assertEqual(row["photo_phash"], "0" * 16)
                self.assertEqual(row["created_at"], "original-time")
                self.assertTrue(row["is_valid"])


if __name__ == "__main__":
    unittest.main()
