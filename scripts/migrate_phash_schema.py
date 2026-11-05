#!/usr/bin/env python3
"""安全升级 pHash 表结构，支持重复执行，不回填历史照片。"""

import argparse
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.data_store import SqliteDataStore
from src.logger import close_logging, setup_logging


def main(argv=None):
    parser = argparse.ArgumentParser(description="检测并补全 pHash 字段，保留所有历史数据及邮件进度。")
    parser.add_argument("--db", type=Path, default=ROOT / "data/attendance.db")
    args = parser.parse_args(argv)
    try:
        setup_logging(ROOT / "logs", ROOT / ".env")
        SqliteDataStore(args.db)
        print("pHash 及重复判定字段已就绪。历史结果与邮件进度已保留；可执行 recheck_photo_duplicates.py 比对已有哈希。")
        return 0
    except Exception:
        logging.getLogger(__name__).exception("pHash 表结构升级失败。")
        print("升级失败，请检查数据库权限或稍后重试，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
