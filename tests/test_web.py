"""使用 Streamlit 官方 AppTest 实际操作表单、筛选、拉取与报表。"""

from io import BytesIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dotenv import dotenv_values
from openpyxl import load_workbook
from PIL import Image
from streamlit.testing.v1 import AppTest

from src.common import MVPError, read_json, save_json
from src.config import DEFAULT_CONFIG, save_config
from src.data_store import SqliteDataStore
from src.logger import close_logging
from tests.helpers import FakeIMAP, exif_jpeg, message_bytes
from tests.test_sqlite import record


ROOT = Path(__file__).resolve().parents[1]


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(close_logging)
        self.folder = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"ATTENDANCE_WORK_DIR": str(self.folder)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.store = SqliteDataStore(self.folder / "data/attendance.db")
        self.app = AppTest.from_file(str(ROOT / "app.py"), default_timeout=20)

    def configured(self):
        save_json(self.folder / "config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com"})
        (self.folder / ".env").write_text("IMAP_AUTH_CODE=WEB-SECRET\nOTHER=keep\n", encoding="utf-8")

    def run_app(self):
        self.app.run()
        self.assertEqual(len(self.app.exception), 0)

    def button(self, label):
        return next(button for button in self.app.button if button.label == label)

    def input(self, label):
        return next(value for value in self.app.text_input if value.label == label)

    def test_initial_empty_state_and_metrics(self):
        self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["0", "0", "0", "0"])
        self.assertTrue(self.app.info)
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_pagination_and_filter_reset(self):
        self.store.save_records([record(f"source:{number}") for number in range(205)])
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 200)
        self.app.number_input(key="page").set_value(2)
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 5)
        self.app.selectbox(key="result_filter").select("无效")
        self.run_app()
        self.assertEqual(self.app.number_input(key="page").value, 1)
        self.assertTrue(self.app.info)

    def test_save_configuration_and_preserve_hidden_secret(self):
        self.configured()
        self.run_app()
        self.input("目标纬度").set_value("31.2304")
        self.input("目标经度").set_value("121.4737")
        self.input("距离阈值（米）").set_value("100")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.success)
        config = read_json(self.folder / "config.json")
        self.assertEqual(config["target_lat"], 31.2304)
        self.assertNotIn("imap_auth_code", config)
        self.assertEqual(dotenv_values(self.folder / ".env")["IMAP_AUTH_CODE"], "WEB-SECRET")
        self.assertEqual(dotenv_values(self.folder / ".env")["OTHER"], "keep")
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_first_time_configuration_and_invalid_form_does_not_write(self):
        self.run_app()
        self.input("QQ 邮箱").set_value("teacher@qq.com")
        self.input("QQ 邮箱授权码").set_value("NEW-WEB-SECRET")
        self.input("目标纬度").set_value("91")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.error)
        self.assertFalse((self.folder / "config.json").exists())
        self.input("目标纬度").set_value("39.9042")
        self.button("保存配置").click()
        self.run_app()
        self.assertTrue(self.app.success)
        self.assertEqual(dotenv_values(self.folder / ".env")["IMAP_AUTH_CODE"], "NEW-WEB-SECRET")
        self.assertEqual(self.input("QQ 邮箱授权码").value, "")

    def test_filter_metrics_missing_photo_and_excel_download(self):
        self.store.save_records([record("valid"), {**record("invalid", False), "exif_software": "美图秀秀",
                                                  "software_check": "未通过：命中禁用软件（美图秀秀）"}])
        self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["2", "1", "1", "0"])
        self.app.selectbox(key="result_filter").select("无效")
        self.run_app()
        self.assertEqual(len(self.app.dataframe[0].value), 1)
        self.assertEqual(self.app.dataframe[0].value.iloc[0]["校验结果"], "无效")
        self.assertEqual(self.app.dataframe[0].value.iloc[0]["EXIF 软件信息"], "美图秀秀")
        self.assertIn("命中禁用软件", self.app.dataframe[0].value.iloc[0]["软件校验结果"])
        self.assertTrue(any("没有可预览" in value.value for value in self.app.warning))
        self.button("生成并下载报表").click()
        self.run_app()
        workbook = load_workbook(BytesIO(self.app.session_state["report_bytes"]))
        self.addCleanup(workbook.close)
        self.assertEqual(workbook["附件明细"].max_row, 3)
        self.assertTrue(any(button.label == "下载考勤汇总报表" for button in self.app.get("download_button")))

    def test_pull_calls_real_pipeline_and_refreshes_metrics(self):
        self.configured()
        self.run_app()
        sample = exif_jpeg()
        length = int.from_bytes(sample[4:6], "big")
        photo = BytesIO()
        Image.new("RGB", (8, 8), "green").save(photo, format="JPEG", exif=sample[6:6 + length - 2])
        message = message_bytes(photos=[("photo.jpg", photo.getvalue())])
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", return_value=FakeIMAP({10: message})):
            self.button("一键拉取并校验").click()
            self.run_app()
        self.assertEqual([value.value for value in self.app.metric], ["1", "1", "0", "0"])
        self.assertTrue(any("新增 1 条记录" in value.value for value in self.app.success))
        self.assertEqual(self.store.load_checkpoint()["last_uid"], 10)
        self.assertFalse(self.app.error)

    def test_mail_and_database_errors_are_shown_without_page_crash(self):
        self.configured()
        self.run_app()
        with patch("src.email_fetcher.imaplib.IMAP4_SSL", side_effect=OSError("network WEB-SECRET")):
            self.button("一键拉取并校验").click()
            self.run_app()
        self.assertTrue(any("邮件拉取失败" in value.value for value in self.app.error))
        self.assertNotIn("WEB-SECRET", (self.folder / "logs/agent.log").read_text())
        with patch.object(SqliteDataStore, "statistics", side_effect=MVPError("数据库暂不可用")):
            self.run_app()
        self.assertTrue(any("数据库暂不可用" in value.value for value in self.app.error))

    def test_config_write_failure_restores_both_files(self):
        self.configured()
        old = [(self.folder / path).read_bytes() for path in ("config.json", ".env")]
        original_replace = os.replace
        failed = False

        def fail_once(source, target):
            nonlocal failed
            if Path(target).name == ".env" and not failed:
                failed = True
                raise OSError("写入失败")
            return original_replace(source, target)

        with patch("src.common.os.replace", side_effect=fail_once):
            with self.assertRaises(OSError):
                save_config({"threshold_meters": 100}, "REPLACEMENT", self.folder)
        self.assertEqual(old, [(self.folder / path).read_bytes() for path in ("config.json", ".env")])


if __name__ == "__main__":
    unittest.main()
