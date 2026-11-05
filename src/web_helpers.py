"""Web 与测试共用的照片路径检查。"""

from pathlib import Path


def safe_photo_path(value, work_dir):
    if not value:
        return None
    root = Path(work_dir).resolve()
    folder = (root / "attachments").resolve()
    path = (root / value).resolve()
    # 仅预览附件目录下的 JPEG，不能借数据库字段读取任意本地文件。
    if not path.is_relative_to(folder) or path.suffix.lower() not in (".jpg", ".jpeg") or not path.is_file():
        return None
    return path
