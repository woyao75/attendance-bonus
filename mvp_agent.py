"""兼容旧 MVP 命令入口。"""

from src.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
