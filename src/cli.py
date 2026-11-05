"""命令入口与依赖组装；更换后端只需在此传入其他 DataStore。"""

import argparse
import imaplib
import logging
import sys

from .email_fetcher import fetch_emails
from .report_generator import generate_report
from .common import MVPError, single_process
from .config import init_config, load_config
from .data_store import SqliteDataStore, DataStore
from .logger import add_secret, close_logging, redact, setup_logging


log = logging.getLogger(__name__)


def main(argv=None, store: DataStore | None = None):
    parser = argparse.ArgumentParser(description="照片打卡校验（元数据不能证明本人到场）")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init", help="生成 config.json 和 .env，不覆盖已有文件")
    subparsers.add_parser("fetch", help="从 QQ 邮箱增量处理照片附件")
    subparsers.add_parser("report", help="生成带颜色的 Excel 明细与汇总")
    args = parser.parse_args(argv)
    logging_ready = False
    try:
        setup_logging()
        logging_ready = True
        with single_process():
            # CLI 与 Web 共享同一 SQLite 存储和业务模块。
            if store is None:
                store = SqliteDataStore()
            labels = {"init": "初始化配置", "fetch": "拉取邮件", "report": "生成报表"}
            log.info("开始%s...", labels[args.command])
            if args.command == "init":
                init_config()
            elif args.command == "fetch":
                config = load_config()
                add_secret(config.imap_auth_code.get_secret_value())
                fetch_emails(config, store)
            else:
                generate_report(store, "考勤汇总报表.xlsx")
            log.info("%s完成。", labels[args.command])
        return 0
    except KeyboardInterrupt:
        if logging_ready:
            log.warning("命令被用户中断，已保存的数据可在下次继续处理。")
        print("\n操作已中断。", file=sys.stderr)
        return 130
    except Exception as exc:
        # 兜底记录未预期异常与堆栈，返回失败退出码；授权码由 formatter 脱敏。
        if logging_ready:
            log.exception("命令 %s 执行失败。", args.command)
        if isinstance(exc, MVPError):
            message = str(exc)
        elif isinstance(exc, imaplib.IMAP4.error):
            message = "邮箱操作失败，请检查 IMAP 服务、授权码及连接状态。"
        elif isinstance(exc, (OSError, EOFError)):
            message = "网络或文件读写失败，请检查连接、权限、磁盘空间及文件占用。"
        else:
            message = "发生未处理异常，请查看 logs/agent.log。"
        if not logging_ready:
            message = "日志初始化失败，请检查 .env 编码和 logs 目录写入权限。"
        print("错误：" + redact(message), file=sys.stderr)
        return 1
    finally:
        close_logging()


if __name__ == "__main__":
    sys.exit(main())
