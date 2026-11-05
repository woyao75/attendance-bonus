"""请假、老师代签、撤销记录以及班级统计、页面和报表。"""

from concurrent.futures import ThreadPoolExecutor
from datetime import date
from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from streamlit.testing.v1 import AppTest

from src.common import MVPError
from src.data_store import SqliteDataStore
from src.logger import close_logging
from src.report_generator import generate_student_attendance_report
from tests.test_sqlite import record


ROOT = Path(__file__).resolve().parents[1]
DAY = "2026-11-05"


class TeacherAttendanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")
        self.store.import_students([
            {"student_id": "001", "student_name": "张三", "class_name": "一班"},
            {"student_id": "002", "student_name": "李四", "class_name": "一班"},
            {"student_id": "003", "student_name": "王五", "class_name": "二班"},
        ])

    def save(self, student_id="001", action="老师代签", reason="已现场核实到场", teacher="王老师", day=DAY):
        return self.store.record_teacher_attendance(student_id, day, action, reason, teacher)

    def test_leave_and_sign_are_separate_from_photos_and_class_totals_reconcile(self):
        state = dict(account="teacher@qq.com", mailbox="INBOX", uidvalidity="101", last_uid=20)
        self.store.commit_batch([{**record("invalid", False), "student_id": "001", "student_name": "张三"}], state)
        photos = self.store.load_records()
        self.save()
        self.save("002", "请假", "病假")
        result = self.store.student_attendance(DAY)
        self.assertEqual(result["statistics"], {"total": 3, "submitted": 1, "passed": 0, "signed": 1,
                                                "leave": 1, "present": 1, "pending": 0, "missing": 1})
        signed = result["students"][0]
        self.assertEqual((signed["status"], signed["base_status"]), ("老师代签", "未通过"))
        self.assertEqual(signed["teacher"], "王老师")
        self.assertEqual(self.store.load_records(), photos)
        self.assertEqual(self.store.load_checkpoint(), state)
        self.assertEqual(self.store.student_attendance(DAY, "一班")["statistics"]["missing"], 0)
        self.assertEqual(self.store.student_attendance(DAY, "二班")["statistics"]["missing"], 1)
        for key, value in result["statistics"].items():
            self.assertEqual(sum(row[key] for row in result["classes"]), value)
        next_day = self.store.student_attendance("2026-11-06")["statistics"]
        self.assertEqual(next_day["missing"], 3)
        self.assertEqual(next_day["leave"], 0)

    def test_last_action_wins_cancel_restores_original_and_history_survives_restart(self):
        self.store.save_records([{**record(), "student_id": "001", "student_name": "张三"}])
        first = self.save(action="请假", reason="事假")
        second = self.save()
        self.assertGreater(second["id"], first["id"])
        self.assertEqual(self.store.student_attendance(DAY)["statistics"]["present"], 1)
        cancelled = self.save(action="撤销", reason="撤销误登记")
        row = self.store.student_attendance(DAY)["students"][0]
        self.assertEqual(row["status"], "校验通过")
        self.assertEqual(row["manual_action"], "")
        restarted = SqliteDataStore(self.store.path)
        history = restarted.teacher_attendance_history("001", DAY)
        self.assertEqual([row["action"] for row in history], ["撤销", "老师代签", "请假"])
        self.assertEqual(history[0]["id"], cancelled["id"])
        self.assertTrue(all(row["created_at"].endswith("Z") for row in history))
        # 同一撤销重复提交幂等；不同撤销不会无故新增。
        self.assertEqual(self.save(action="撤销", reason="撤销误登记")["id"], cancelled["id"])
        with self.assertRaises(MVPError):
            self.save(action="撤销", reason="再次撤销")

    def test_identical_concurrent_submissions_are_idempotent(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.save(), range(8)))
        self.assertEqual(len({row["id"] for row in results}), 1)
        self.assertEqual(len(self.store.teacher_attendance_history("001", DAY)), 1)
        self.assertEqual(self.store.student_attendance(DAY)["statistics"]["signed"], 1)

    def test_invalid_registration_is_rejected_without_side_effects(self):
        for options in ({"student_id": "999"}, {"action": "fake"}, {"day": "2026-02-30"},
                        {"teacher": " "}, {"reason": " "}, {"reason": "x" * 1001}, {"action": "撤销"}):
            with self.subTest(options=options), self.assertRaises(MVPError):
                self.save(**options)
        self.assertEqual(self.store.teacher_attendance_history("001", DAY), [])

    def test_report_includes_missing_leave_sign_and_formula_safe_teacher_reason(self):
        self.save(reason="=1+1", teacher="=SUM(A1)")
        self.save("002", "请假", "病假")
        workbook = load_workbook(BytesIO(generate_student_attendance_report(self.store, DAY, "一班")))
        self.addCleanup(workbook.close)
        sheet = workbook["学生考勤"]
        headers = [cell.value for cell in sheet[1]]
        self.assertEqual(sheet.max_row, 3)
        self.assertEqual(sheet.cell(2, headers.index("学号") + 1).value, "001")
        self.assertEqual(sheet.cell(2, headers.index("考勤结果") + 1).value, "老师代签")
        for name in ("原因", "经办老师"):
            self.assertEqual(sheet.cell(2, headers.index(name) + 1).data_type, "s")
        self.assertEqual(workbook["班级汇总"].cell(2, 5).value, 1)
        self.assertEqual(workbook["班级汇总"].cell(2, 6).value, 1)

    def app(self):
        self.addCleanup(close_logging)
        env = patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)})
        env.start()
        self.addCleanup(env.stop)
        return AppTest.from_file(str(ROOT / "app.py"), default_timeout=20).run()

    def test_page_sign_leave_cancel_refresh_and_export(self):
        app = self.app()
        app.date_input(key="roster_day").set_value(date(2026, 11, 5)).run()

        def submit(action, reason):
            app.selectbox(key="manual_action").select(action)
            app.text_input(key="manual_teacher").set_value("陈老师")
            app.text_area(key="manual_reason").set_value(reason)
            next(button for button in app.button if button.label == "保存考勤登记").click().run()
            self.assertFalse(app.exception)

        submit("老师代签", "现场核实")
        self.assertEqual({metric.label: metric.value for metric in app.metric}["老师代签人数"], "1")
        app.selectbox(key="manual_student").select("002").run()
        submit("请假", "病假一天")
        metrics = {metric.label: metric.value for metric in app.metric}
        self.assertEqual(metrics["请假人数"], "1")
        self.assertEqual(metrics["未提交人数"], "1")
        app.selectbox(key="student_status").select("请假").run()
        frame = next(frame.value for frame in app.dataframe if "提交状态" in frame.value.columns)
        self.assertEqual(frame["姓名"].tolist(), ["李四"])
        self.assertEqual(frame["经办老师"].tolist(), ["陈老师"])
        app.button(key="generate_student_attendance").click().run()
        self.assertIn("student_attendance_bytes", app.session_state)
        submit("撤销", "撤销测试")
        self.assertEqual({metric.label: metric.value for metric in app.metric}["请假人数"], "0")
        self.assertNotIn("student_attendance_bytes", app.session_state)

    def test_page_validation_shows_error_and_does_not_save(self):
        app = self.app()
        next(button for button in app.button if button.label == "保存考勤登记").click().run()
        self.assertFalse(app.exception)
        self.assertTrue(any("考勤登记失败" in error.value for error in app.error))
        self.assertEqual(self.store.teacher_attendance_history("001", DAY), [])


if __name__ == "__main__":
    unittest.main()
