"""SQLite 事务、并发、查询和旧数据迁移回归。"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

import pandas as pd

from scripts.migrate_csv_to_sqlite import migrate
from src.common import COLUMNS, MVPError, UNLIMITED_WINDOW
from src.data_store import SqliteDataStore
from src.web_helpers import safe_photo_path


def record(key="test:1", valid=True):
    return dict(student_id="0020230001", student_name="张三", email_time="2026-11-05T08:05:00+08:00",
                photo_name="photo.jpg", exif_lat=39.9042, exif_lon=116.4074,
                shoot_time="2026:11:05 08:00:00", distance=0, is_valid=valid, reason="有效" if valid else "距离超限",
                source_key=key, attendance_window=UNLIMITED_WINDOW, validation_scope="仅坐标校验，未校验拍摄时间", photo_path="")


class SqliteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")

    def test_roundtrip_dedup_types_created_at_and_indexes(self):
        self.assertEqual(self.store.save_records([record()]), 1)
        first = self.store.load_records()[0]
        self.assertEqual(self.store.save_records([record()]), 0)
        second = self.store.load_records()[0]
        self.assertEqual(first, second)
        self.assertEqual(first["student_id"], "0020230001")
        self.assertIs(first["is_valid"], True)
        self.assertIsInstance(first["distance"], float)
        self.assertTrue(first["created_at"].endswith("Z"))
        with closing(sqlite3.connect(self.store.path)) as connection:
            indexes = connection.execute("PRAGMA index_list(attendance_records)").fetchall()
        self.assertGreaterEqual(len(indexes), 4)

    def test_conflict_rolls_back_records_and_mail_progress_together(self):
        state = dict(account="teacher@qq.com", mailbox="INBOX", uidvalidity="101", last_uid=1)
        self.store.commit_batch([record()], state)
        conflicting = record()
        conflicting["student_name"] = "李四"
        new_state = {**state, "last_uid": 2}
        with self.assertRaises(MVPError):
            self.store.commit_batch([record("new"), conflicting], new_state)
        self.assertEqual(len(self.store.load_records()), 1)
        self.assertEqual(self.store.load_checkpoint(), state)

    def test_invalid_batch_never_partially_imports(self):
        for updates in ({"distance": "nan"}, {"exif_lat": 91}, {"is_valid": "maybe"}, {"source_key": ""}):
            with self.subTest(updates=updates):
                with self.assertRaises(MVPError):
                    self.store.save_records([record("new"), {**record(), **updates}])
                self.assertEqual(self.store.load_records(), [])

    def test_statistics_filter_pagination_and_sql_text_safety(self):
        records = [record(f"source:{index}", valid=index % 2 == 0) for index in range(5)]
        records[0]["student_name"] = "'); DROP TABLE attendance_records; --"
        self.store.save_records(records)
        self.assertEqual(self.store.statistics(), {"total": 5, "valid": 3, "invalid": 2})
        self.assertEqual(len(self.store.query_records(False)), 2)
        self.assertEqual(len(self.store.query_records(True, limit=2, offset=2)), 1)
        self.assertTrue(self.store.has_source("source:0"))
        self.assertFalse(self.store.has_source("' OR 1=1 --"))
        for options in ({"is_valid": "1 OR 1=1"}, {"limit": 0}, {"offset": -1}):
            with self.assertRaises(MVPError):
                self.store.query_records(**options)

    def test_null_gps_and_false_string_are_preserved(self):
        value = {**record(), "exif_lat": "", "exif_lon": None, "distance": "", "is_valid": "False"}
        self.store.save_records([value])
        loaded = self.store.load_records()[0]
        self.assertIsNone(loaded["exif_lat"])
        self.assertIsNone(loaded["distance"])
        self.assertIs(loaded["is_valid"], False)

    def test_multiple_threads_use_separate_connections(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda index: self.store.save_records([record(f"source:{index}")]), range(16)))
        self.assertEqual(sum(results), 16)
        self.assertEqual(self.store.statistics()["total"], 16)

    def test_schema_error_is_friendly(self):
        bad = self.folder / "bad.db"
        bad.write_bytes(b"this is not sqlite")
        with self.assertRaises(MVPError):
            SqliteDataStore(bad)

    def test_legacy_ten_columns_migrate_repeat_and_reorder_without_duplicates(self):
        source = self.folder / "records.csv"
        old = pd.DataFrame([record("one"), record("two", False)])[COLUMNS[:10]]
        old.to_csv(source, index=False, encoding="utf-8-sig")
        before = source.read_bytes()
        self.assertEqual(migrate(source, self.store.path, self.folder)["inserted"], 2)
        self.assertEqual(source.read_bytes(), before)
        old.iloc[::-1].to_csv(self.folder / "renamed.csv", index=False, encoding="utf-8-sig")
        self.assertEqual(migrate(self.folder / "renamed.csv", self.store.path, self.folder)["inserted"], 0)
        self.assertEqual(self.store.statistics()["total"], 2)
        self.assertEqual(self.store.load_records()[0]["student_id"], "0020230001")
        self.assertEqual(self.store.load_checkpoint(), {})

    def test_modular_csv_preserves_sources_and_rejects_corrupt_batch(self):
        source = self.folder / "records.csv"
        pd.DataFrame([record("old-source")]).drop(columns=["photo_path"]).to_csv(source, index=False)
        self.assertEqual(migrate(source, self.store.path, self.folder)["inserted"], 1)
        self.assertTrue(self.store.has_source("old-source"))
        pd.DataFrame([record("new"), {**record("broken"), "is_valid": "bad"}]).to_csv(source, index=False)
        with self.assertRaises(MVPError):
            migrate(source, self.store.path, self.folder)
        self.assertEqual(self.store.statistics()["total"], 1)

    def test_photo_preview_refuses_missing_files_traversal_and_symlinks(self):
        folder = self.folder / "attachments"
        folder.mkdir()
        photo = folder / "photo.jpg"
        photo.write_bytes(b"jpeg")
        outside = self.folder / "private.jpg"
        outside.write_bytes(b"private")
        (folder / "link.jpg").symlink_to(outside)
        self.assertEqual(safe_photo_path("attachments/photo.jpg", self.folder), photo)
        for value in ("", "attachments/missing.jpg", "private.jpg", "attachments/../private.jpg", "attachments/link.jpg"):
            self.assertIsNone(safe_photo_path(value, self.folder))


if __name__ == "__main__":
    unittest.main()
