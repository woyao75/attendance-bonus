"""名单导入、邮件主题、按学生统计及 Streamlit 页面回归。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from openpyxl import Workbook
from streamlit.testing.v1 import AppTest

from src.common import MVPError
from src.config import AppConfig, DEFAULT_CONFIG
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.logger import close_logging
from src.student_roster import parse_student_roster
from tests.helpers import FakeIMAP, message_bytes
from tests.test_sqlite import record


ROOT = Path(__file__).resolve().parents[1]
CSV = "姓名,学号\n张三,0020230001\n李四,0020230002\n".encode("utf-8-sig")


class RosterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")

    def test_csv_and_excel_preserve_ids_and_support_reordered_headers(self):
        for content in (CSV, CSV.decode("utf-8-sig").encode("gb18030")):
            students = parse_student_roster(content, "名单.csv")
            self.assertEqual(students[0], {"student_name": "张三", "student_id": "0020230001", "class_name": ""})
        workbook = Workbook()
        workbook.active.append(["学号", "班级", "姓名"])
        workbook.active.append(["0020230001", "一班", "张三"])
        workbook.active.append(["0020230001", "一班", "张三"])
        buffer = BytesIO()
        workbook.save(buffer)
        workbook.close()
        self.assertEqual(parse_student_roster(buffer.getvalue(), "名单.xlsx"), [{**students[0], "class_name": "一班"}])

    def test_invalid_files_and_conflicting_rows_are_rejected(self):
        for content, filename in ((b"", "empty.csv"), (b"bad", "bad.xlsx"), (CSV, "bad.xls"),
                                  ("姓名,姓名,学号\n张三,张三,001".encode(), "bad.csv"),
                                  ("姓名,学号\n张三,1.0".encode(), "bad.csv"),
                                  ("姓名,学号\n,001".encode(), "bad.csv"),
                                  ("姓名,学号\n张三,001\n李四,001".encode(), "bad.csv")):
            with self.subTest(filename=filename, content=content), self.assertRaises(MVPError):
                parse_student_roster(content, filename)

    def test_import_is_atomic_repeatable_and_preserves_attendance(self):
        self.store.save_records([record()])
        before = self.store.load_records()
        students = parse_student_roster(CSV, "students.csv")
        self.assertEqual(self.store.import_students(students), {"inserted": 2, "updated": 0, "skipped": 0, "total": 2})
        self.assertEqual(self.store.import_students(students), {"inserted": 0, "updated": 0, "skipped": 2, "total": 2})
        with self.assertRaises(MVPError):
            self.store.import_students([{"student_id": "003", "student_name": "王五"},
                                        {"student_id": "0020230001", "student_name": "李四"}])
        restarted = SqliteDataStore(self.store.path)
        self.assertEqual(len(restarted.load_students()), 2)
        self.assertEqual(restarted.load_records(), before)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: restarted.import_students(students), range(2)))
        self.assertTrue(all(result["inserted"] == 0 for result in results))

    def test_new_subject_format_accepts_name_plus_id_and_rejects_old_format(self):
        config = AppConfig(**{**DEFAULT_CONFIG, "email_account": "teacher@qq.com", "imap_auth_code": "secret"})
        server = FakeIMAP({1: message_bytes("张三+0020230001"), 2: message_bytes("李四+0020230002"),
                           3: message_bytes("【打卡】0020230001-张三"), 4: message_bytes("张三0020230001"),
                           5: message_bytes("张三+abc"), 6: message_bytes("+0020230001")})
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=server):
            fetch_emails(config, self.store, self.folder)
        self.assertEqual([(row["student_name"], row["student_id"]) for row in self.store.load_records()],
                         [("张三", "0020230001"), ("李四", "0020230002")])
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 6)

    def populate(self):
        students = parse_student_roster(CSV, "students.csv")
        students += [{"student_id": "003", "student_name": "王五"}, {"student_id": "004", "student_name": "赵六"}]
        self.store.import_students(students)
        self.store.save_records([
            {**record("one"), "email_time": "2026-11-04T16:00:00+00:00"},
            record("one-again", False),
            {**record("two", False), "student_id": "0020230002", "student_name": "李四"},
            {**record("mismatch"), "student_id": "004", "student_name": "错误姓名"},
            {**record("matching-name"), "student_id": "004", "student_name": "赵六"},
            {**record("previous-day"), "student_id": "003", "student_name": "王五", "email_time": "2026-11-04T15:59:59+00:00"},
            {**record("following-day"), "student_id": "003", "student_name": "王五", "email_time": "2026-11-05T16:00:00+00:00"},
            {**record("outsider"), "student_id": "999", "student_name": "名单外"},
        ])

    def test_summary_counts_students_and_beijing_date_boundaries(self):
        self.populate()
        summary = self.store.student_attendance("2026-11-05")
        self.assertEqual(summary["statistics"], {"total": 4, "submitted": 3, "passed": 1, "pending": 2, "missing": 1,
                                                "signed": 0, "leave": 0, "present": 1})
        details = {row["student_id"]: row for row in summary["students"]}
        self.assertEqual(details["0020230001"]["submission_count"], 2)
        self.assertEqual(details["003"]["status"], "未提交")
        self.assertEqual(details["004"]["status"], "姓名不匹配")
        self.assertEqual(summary["outsiders"][0]["student_id"], "999")
        self.assertEqual(self.store.student_attendance("2026-11-06")["statistics"]["passed"], 1)
        self.assertEqual(self.store.student_attendance("2026-11-07")["statistics"]["missing"], 4)
        for day in ("2026-02-30", "20261105", "' OR 1=1", None):
            with self.subTest(day=day), self.assertRaises(MVPError):
                self.store.student_attendance(day)

    def app(self):
        self.addCleanup(close_logging)
        env = patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)})
        env.start()
        self.addCleanup(env.stop)
        return AppTest.from_file(str(ROOT / "app.py"), default_timeout=20)

    def test_page_import_runs_real_parser_and_database(self):
        app = self.app().run()
        upload = SimpleNamespace(name="students.csv", getvalue=lambda: CSV)
        with patch("streamlit.file_uploader", return_value=upload):
            next(button for button in app.button if button.label == "导入学生名单").click().run()
        self.assertFalse(app.exception)
        self.assertEqual(len(self.store.load_students()), 2)
        self.assertTrue(any("新增 2 人" in success.value for success in app.success))
        metrics = {metric.label: metric.value for metric in app.metric}
        self.assertEqual(metrics["名单人数"], "2")
        self.assertEqual(metrics["未提交人数"], "2")

    def test_page_filters_missing_students_and_changes_date(self):
        self.populate()
        app = self.app().run()
        app.date_input(key="roster_day").set_value(date(2026, 11, 5)).run()
        self.assertFalse(app.exception)
        metrics = {metric.label: metric.value for metric in app.metric}
        self.assertEqual(metrics["校验通过人数"], "1")
        self.assertEqual(metrics["待核验人数"], "2")
        app.selectbox(key="student_status").select("未提交").run()
        students = next(frame.value for frame in app.dataframe if "提交状态" in frame.value.columns)
        self.assertEqual(students["姓名"].tolist(), ["王五"])
        app.date_input(key="roster_day").set_value(date(2026, 11, 7)).run()
        metrics = {metric.label: metric.value for metric in app.metric}
        self.assertEqual(metrics["未提交人数"], "4")

    def assign_classes(self):
        students = parse_student_roster(CSV, "students.csv")
        self.store.import_students([{**student, "class_name": "一班"} for student in students] +
                                   [{"student_id": "003", "student_name": "王五", "class_name": "二班"}])

    def test_class_import_updates_without_erasing_classes_and_rejects_conflicts(self):
        self.store.import_students(parse_student_roster(CSV, "students.csv"))
        content = "班级,姓名,学号\n一班,张三,0020230001\n二班,李四,0020230002\n".encode()
        students = parse_student_roster(content, "classes.csv")
        result = self.store.import_students(students)
        self.assertEqual(result, {"inserted": 0, "updated": 2, "skipped": 0, "total": 2})
        self.store.import_students(parse_student_roster(CSV, "old-roster.csv"))
        self.assertEqual([row["class_name"] for row in self.store.load_students()], ["一班", "二班"])
        with self.assertRaises(MVPError):
            self.store.import_students([{**students[0], "class_name": "三班"},
                                        {**students[1], "student_name": "错误姓名"}])
        self.assertEqual(self.store.load_students()[0]["class_name"], "一班")
        for content in ("姓名,学号,班级\n张三,001,一班\n张三,001,二班",
                        "姓名,学号,班级,班级\n张三,001,一班,一班"):
            with self.assertRaises(MVPError):
                parse_student_roster(content.encode(), "bad.csv")

    def test_class_summary_reconciles_totals_and_filters_unassigned(self):
        self.populate()
        self.assign_classes()
        result = self.store.student_attendance("2026-11-05")
        classes = {row["class_name"]: row for row in result["classes"]}
        self.assertEqual(classes["一班"], {"class_name": "一班", "total": 2, "submitted": 2,
                                         "passed": 1, "pending": 1, "missing": 0, "signed": 0, "leave": 0, "present": 1})
        self.assertEqual(classes["二班"]["missing"], 1)
        self.assertEqual(classes[""]["pending"], 1)
        for key, total in result["statistics"].items():
            self.assertEqual(sum(row[key] for row in classes.values()), total)
        second = self.store.student_attendance("2026-11-05", class_name="二班")
        self.assertEqual(second["statistics"]["total"], 1)
        self.assertEqual(second["students"][0]["student_name"], "王五")
        unassigned = self.store.student_attendance("2026-11-05", class_name="")
        self.assertEqual(unassigned["students"][0]["student_name"], "赵六")
        self.assertEqual(self.store.student_attendance("2026-11-05", class_name="' OR 1=1 --")["statistics"]["total"], 0)

    def test_legacy_student_table_is_migrated_without_losing_data(self):
        path = self.folder / "legacy.db"
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE students(student_id TEXT PRIMARY KEY, student_name TEXT NOT NULL, imported_at TEXT NOT NULL)")
            connection.execute("INSERT INTO students VALUES ('001', '张三', 'legacy-time')")
        with ThreadPoolExecutor(max_workers=2) as executor:
            stores = list(executor.map(lambda _: SqliteDataStore(path), range(2)))
        self.assertEqual(stores[0].load_students(), [{"student_id": "001", "student_name": "张三",
                                                     "imported_at": "legacy-time", "class_name": ""}])
        stores[0].import_students([{"student_id": "001", "student_name": "张三", "class_name": "一班"}])
        self.assertEqual(SqliteDataStore(path).load_students()[0]["class_name"], "一班")

    def test_page_class_summary_and_missing_filter_work_together(self):
        self.populate()
        self.assign_classes()
        app = self.app().run()
        app.date_input(key="roster_day").set_value(date(2026, 11, 5)).run()
        summary = next(frame.value for frame in app.dataframe if "未提交人数" in frame.value.columns)
        self.assertEqual(set(summary["班级"]), {"一班", "二班", "未分班"})
        app.selectbox(key="roster_class").select("二班").run()
        app.selectbox(key="student_status").select("未提交").run()
        self.assertFalse(app.exception)
        metrics = {metric.label: metric.value for metric in app.metric}
        self.assertEqual(metrics["名单人数"], "1")
        self.assertEqual(metrics["未提交人数"], "1")
        details = next(frame.value for frame in app.dataframe if "提交状态" in frame.value.columns)
        self.assertEqual(details["姓名"].tolist(), ["王五"])
        self.assertEqual(details["班级"].tolist(), ["二班"])


if __name__ == "__main__":
    unittest.main()
