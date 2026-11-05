"""配置来源、日志脱敏和滚动回归。"""

from contextlib import redirect_stderr, redirect_stdout
import io
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from src import cli
from src.common import MVPError, read_json, save_json
from src.config import DEFAULT_CONFIG, init_config, load_config
from src.data_store import SqliteDataStore
from src import logger as agent_logger


class ModuleTests(unittest.TestCase):
    def setUp(self):
        previous = Path.cwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, previous)
        self.addCleanup(agent_logger.close_logging)
        self.addCleanup(logging.getLogger().setLevel, logging.getLogger().level)
        save_json("config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com"})
        Path(".env").write_text("IMAP_AUTH_CODE=module-test-secret\n", encoding="utf-8")


    def test_secret_only_comes_from_dotenv_and_model_hides_it(self):
        with patch.dict(os.environ, {"IMAP_AUTH_CODE": "wrong-environment-secret"}):
            config = load_config()
        self.assertEqual(config.imap_auth_code.get_secret_value(), "module-test-secret")
        self.assertNotIn("module-test-secret", repr(config))
        self.assertNotIn("imap_auth_code", config.model_dump())
        Path(".env").unlink()
        with patch.dict(os.environ, {"IMAP_AUTH_CODE": "environment-secret"}):
            with self.assertRaises(MVPError):
                load_config()


    def test_json_cannot_supply_secret_or_unknown_fields(self):
        config = read_json("config.json")
        config["imap_auth_code"] = "legacy-secret"
        save_json("config.json", config)
        with self.assertRaises(MVPError) as error:
            load_config()
        self.assertNotIn("legacy-secret", str(error.exception))
        config.pop("imap_auth_code")
        config["target_latt"] = 40
        save_json("config.json", config)
        with self.assertRaises(MVPError):
            load_config()


    def test_dotenv_does_not_interpolate_process_environment(self):
        Path(".env").write_text("IMAP_AUTH_CODE=${OTHER_SECRET}\n", encoding="utf-8")
        with patch.dict(os.environ, {"OTHER_SECRET": "wrong-secret"}):
            self.assertEqual(load_config().imap_auth_code.get_secret_value(), "${OTHER_SECRET}")


    def test_invalid_or_empty_secret_and_business_fields(self):
        for content in ("", "IMAP_AUTH_CODE=\n", "IMAP_AUTH_CODE=your_auth_code\n"):
            with self.subTest(content=content):
                Path(".env").write_text(content, encoding="utf-8")
                with self.assertRaises(MVPError):
                    load_config()
        Path(".env").write_text("IMAP_AUTH_CODE=module-test-secret\n", encoding="utf-8")
        for updates in ({"target_lat": True}, {"target_lon": "Infinity"},
                        {"max_email_bytes": True}, {"max_attachment_bytes": 0},
                        {"attendance_start": "2026-11-05T10:00:00+08:00",
                         "attendance_end": "2026-11-05T08:00:00+08:00"},
                        {"attendance_start": "2026-11-05T08:00:00",
                         "attendance_end": "2026-11-05T10:00:00"}):
            with self.subTest(updates=updates):
                save_json("config.json", {**DEFAULT_CONFIG, "email_account": "teacher@qq.com", **updates})
                with self.assertRaises(MVPError):
                    load_config()


    def test_init_creates_only_missing_files_and_uses_private_permissions(self):
        original = Path("config.json").read_bytes()
        Path(".env").unlink()
        with redirect_stdout(io.StringIO()):
            init_config()
        self.assertEqual(Path("config.json").read_bytes(), original)
        self.assertEqual(Path(".env").stat().st_mode & 0o777, 0o600)
        original_env = Path(".env").read_bytes()
        with self.assertRaises(MVPError):
            init_config()
        self.assertEqual(Path(".env").read_bytes(), original_env)
        Path("config.json").unlink()
        with redirect_stdout(io.StringIO()):
            init_config()
        self.assertNotIn("imap_auth_code", read_json("config.json"))
        self.assertEqual(Path(".env").read_bytes(), original_env)


    def test_unexpected_exception_is_logged_with_traceback_and_redacted(self):
        stderr = io.StringIO()
        with patch.object(cli, "fetch_emails", side_effect=RuntimeError("failed module-test-secret")):
            with redirect_stderr(stderr):
                self.assertEqual(cli.main(["fetch"], store=SqliteDataStore()), 1)
        text = Path("logs/agent.log").read_text()
        self.assertIn("Traceback", text)
        self.assertIn("RuntimeError", text)
        self.assertIn("[REDACTED]", text)
        self.assertNotIn("module-test-secret", text)
        self.assertNotIn("module-test-secret", stderr.getvalue())
        self.assertFalse(Path(".mvp_agent.lock").exists())


    def test_root_logging_rotation_and_no_duplicate_handlers(self):
        with redirect_stderr(io.StringIO()):
            agent_logger.setup_logging()
            agent_logger.setup_logging()
            handlers = [h for h in logging.getLogger().handlers if getattr(h, "_attendance_handler", False)]
            self.assertEqual(len(handlers), 2)
            file_handler = next(h for h in handlers if isinstance(h, RotatingFileHandler))
            self.assertEqual(file_handler.maxBytes, 5 * 1024 * 1024)
            self.assertEqual(file_handler.backupCount, 5)
            file_handler.maxBytes = 180
            for index in range(20):
                logging.getLogger("third_party_module").info("rotation %s module-test-secret", index)
            agent_logger.close_logging()
        self.assertTrue(Path("logs/agent.log.5").exists())
        self.assertFalse(Path("logs/agent.log.6").exists())
        for path in Path("logs").glob("agent.log*"):
            text = path.read_text()
            self.assertNotIn("module-test-secret", text)
            self.assertRegex(text, r"\d{4}-\d{2}-\d{2} .*third_party_module \| INFO")



if __name__ == "__main__":
    unittest.main()
