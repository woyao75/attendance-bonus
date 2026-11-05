#!/usr/bin/env bash
# 固定工作目录与 Python 环境，从任何目录启动都会使用本项目的配置和数据。
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
    printf '%s\n' '未找到项目虚拟环境。请按 README.md 的快速运行步骤安装。' >&2
    exit 1
fi

if [[ $# -eq 0 ]]; then
    set -- --help
fi

cd -- "$PROJECT_DIR"
if [[ "${1:-}" == "web" ]]; then
    shift
    exec "$PYTHON_BIN" -m streamlit run "$PROJECT_DIR/app.py" "$@"
fi
exec "$PYTHON_BIN" "$PROJECT_DIR/mvp_agent.py" "$@"
