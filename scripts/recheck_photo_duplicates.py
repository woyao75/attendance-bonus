#!/usr/bin/env python3
"""用已有 pHash 重新判定历史重复照片，不修改基础校验结果或邮件进度。"""

import argparse
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.common import single_process
from src.config import read_business_config
from src.data_store import SqliteDataStore
from src.logger import close_logging, setup_logging


def main(argv=None):
    parser = argparse.ArgumentParser(description="按入库顺序重新比对历史 pHash；无哈希记录保留为未校验。")
    parser.add_argument("--work-dir", type=Path, default=ROOT)
    parser.add_argument("--db", type=Path, default=None)
    parser.add_argument("--threshold", type=int, choices=range(65), metavar="0..64",
                        help="默认读取 config.json 的 phash_distance_threshold（缺省 5）")
    args = parser.parse_args(argv)
    folder = args.work_dir.resolve()
    try:
        setup_logging(folder / "logs", folder / ".env")
        threshold = args.threshold
        if threshold is None:
            threshold = read_business_config(folder)["phash_distance_threshold"]

        def progress(done, total):
            if done == total or done % 100 == 0:
                print(f"已比对 {done} / {total} 条记录。", flush=True)

        with single_process(folder):
            store = SqliteDataStore(args.db or folder / "data/attendance.db")
            print("正在重新比对已有哈希…", flush=True)
            result = store.recheck_duplicates(threshold, progress)
        print("比对完成：" + "，".join(f"{status} {count} 条" for status, count in result.items()))
        logging.getLogger(__name__).info("历史照片比对完成：%s", result)
        return 0
    except Exception:
        logging.getLogger(__name__).exception("历史照片比对失败。")
        print("比对未完成，数据库事务已回滚。请检查配置和数据库，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
