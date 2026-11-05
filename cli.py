"""旧命令入口，兼容 python cli.py init/fetch/report。"""

from src.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
