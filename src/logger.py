"""Root logger：控制台 + 5 MiB 滚动日志，异常堆栈也进行凭证脱敏。"""

import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
from threading import RLock

from dotenv import dotenv_values


_secrets = set()
_lock = RLock()


def add_secret(value):
    if value:
        with _lock:
            _secrets.add(value)
            _secrets.add(repr(value)[1:-1])


def redact(text):
    with _lock:
        secrets = sorted(_secrets, key=len, reverse=True)
    for secret in secrets:
        text = text.replace(secret, "[REDACTED]")
    return text


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        # 先格式化异常链，再整体替换，覆盖异常消息中可能出现的授权码。
        return redact(super().format(record))


def setup_logging(log_dir="logs", env_path=".env"):
    with _lock:
        if Path(env_path).is_file():
            add_secret(dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE"))
        handlers = [handler for handler in logging.getLogger().handlers if getattr(handler, "_attendance_handler", False)]
        expected = str((Path(log_dir) / "agent.log").resolve())
        if len(handlers) == 2 and any(getattr(handler, "baseFilename", None) == expected for handler in handlers):
            return
        _setup_logging(log_dir, env_path)


def _setup_logging(log_dir, env_path):
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_attendance_handler", False):
            root.removeHandler(handler)
            handler.close()
    if Path(env_path).is_file():
        # 先注册密钥再读取业务配置，配置失败时的日志也能脱敏。
        add_secret(dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE"))
    folder = Path(log_dir)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / "agent.log"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    file_handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8")
    console_handler = logging.StreamHandler()
    formatter = RedactingFormatter("%(asctime)s | %(name)s | %(levelname)s | %(message)s",
                                   datefmt="%Y-%m-%d %H:%M:%S")
    for handler in (file_handler, console_handler):
        handler.setFormatter(formatter)
        handler.setLevel(logging.INFO)
        handler._attendance_handler = True
        root.addHandler(handler)
    root.setLevel(logging.INFO)


def close_logging():
    """释放本应用创建的 handler，方便同进程多次调用 CLI 或执行测试。"""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_attendance_handler", False):
            root.removeHandler(handler)
            handler.close()
