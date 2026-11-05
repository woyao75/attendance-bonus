#!/usr/bin/env python3
"""一次性读取旧 CSV，校验后以单事务幂等导入 SQLite，不删除源文件。"""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd

from src.common import COLUMNS, MVPError, UNLIMITED_WINDOW, single_process
from src.data_store import SqliteDataStore, normalize_records
from src.logger import close_logging, setup_logging


def prepare_records(csv_path, work_dir=ROOT):
    try:
        frame = pd.read_csv(csv_path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    except FileNotFoundError:
        raise MVPError("找不到旧 CSV，请使用 --csv 指定路径。") from None
    except (ValueError, UnicodeError, pd.errors.ParserError):
        raise MVPError("CSV 格式错误，请检查 UTF-8 编码与字段。") from None
    if set(COLUMNS[:10]) - set(frame.columns):
        raise MVPError("CSV 缺少原始十个必要字段，未执行迁移。")
    records = []
    for number, original in enumerate(frame.to_dict("records"), 2):
        row = {key: original.get(key, "") for key in COLUMNS}
        row["attendance_window"] = row["attendance_window"] or UNLIMITED_WINDOW
        row["validation_scope"] = row["validation_scope"] or "历史数据：仅坐标校验，未校验拍摄时间"
        try:
            # 最早的十列版本可能使用无时区时间，按原系统所在地北京时间解释。
            if not original.get("source_key"):
                received = datetime.fromisoformat(row["email_time"])
                if received.utcoffset() is None:
                    received = received.replace(tzinfo=timezone(timedelta(hours=8)))
                row["email_time"] = received.isoformat()
            row["source_key"] = row["source_key"] or "pending"
            row = normalize_records([row])[0]
        except (MVPError, ValueError) as exc:
            raise MVPError(f"CSV 第 {number} 行数据无效，未导入任何记录。请检查布尔值、坐标和时间。") from exc
        if not original.get("source_key"):
            # 不含路径/行号，改名或重排 CSV 后再次导入也不会重复。
            canonical = {key: row[key] for key in COLUMNS[:10]}
            row["source_key"] = "csv:" + hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if not row["photo_path"]:
            filename = hashlib.sha256(row["source_key"].encode()).hexdigest() + ".jpg"
            if (Path(work_dir) / "attachments" / filename).is_file():
                row["photo_path"] = "attachments/" + filename
        records.append(row)
    return normalize_records(records)


def migrate(csv_path, db_path, work_dir=ROOT):
    with single_process(work_dir):
        rows = prepare_records(csv_path, work_dir)
        store = SqliteDataStore(db_path)
        count = store.save_records(rows)
    return {"rows": len(rows), "inserted": count, "skipped": len(rows) - count}


def main(argv=None):
    parser = argparse.ArgumentParser(description="把旧 CSV 幂等导入 SQLite；不删除 CSV，不复制旧邮件进度。")
    parser.add_argument("--csv", type=Path, default=None, help="默认 data/records.csv；兼容回退到根目录 records.csv")
    parser.add_argument("--db", type=Path, default=ROOT / "data/attendance.db")
    args = parser.parse_args(argv)
    source = args.csv or ROOT / "data/records.csv"
    if args.csv is None and not source.exists() and (ROOT / "records.csv").exists():
        source = ROOT / "records.csv"
    try:
        setup_logging(ROOT / "logs", ROOT / ".env")
        print("正在校验并导入 CSV…")
        result = migrate(source, args.db)
        print(f"迁移完成：{result['rows']} 条记录，新增 {result['inserted']} 条，已有 {result['skipped']} 条。源 CSV 已保留。")
        return 0
    except Exception:
        logging.getLogger(__name__).exception("CSV 迁移失败。")
        print("迁移失败，未提交本批记录。请检查 CSV 格式和路径，详情见 logs/agent.log。", file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    raise SystemExit(main())
