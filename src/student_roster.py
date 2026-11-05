"""学生名单文件解析与身份校验；不修改考勤记录。"""

from io import BytesIO
import re
from pathlib import Path

import pandas as pd

from .common import MVPError


MAX_ROSTER_BYTES = 10 * 1024 * 1024
MAX_STUDENTS = 10000


def normalize_students(students):
    """校验整批名单并合并完全重复行；保留学号前导零。"""
    normalized = {}
    for number, student in enumerate(students, 2):
        if not isinstance(student, dict):
            raise MVPError(f"名单第 {number} 行格式错误。")
        student_id = str(student.get("student_id") if student.get("student_id") is not None else "").strip()
        name = str(student.get("student_name") if student.get("student_name") is not None else "").strip()
        class_name = str(student.get("class_name") or "").strip()
        if not re.fullmatch(r"[0-9]+", student_id):
            raise MVPError(f"名单第 {number} 行学号必须为数字，请将学号列保存为文本。")
        if not name or any(character in name for character in "+\r\n\x00"):
            raise MVPError(f"名单第 {number} 行姓名为空或包含加号、换行等不支持的字符。")
        if any(character in class_name for character in "\r\n\x00"):
            raise MVPError(f"名单第 {number} 行班级包含不支持的控制字符。")
        previous = normalized.get(student_id)
        if previous is not None:
            if previous["student_name"] != name:
                raise MVPError(f"名单中学号 {student_id} 对应多个姓名，未导入任何学生。")
            if previous["class_name"] and class_name and previous["class_name"] != class_name:
                raise MVPError(f"名单中学号 {student_id} 对应多个班级，未导入任何学生。")
            class_name = class_name or previous["class_name"]
        normalized[student_id] = {"student_id": student_id, "student_name": name, "class_name": class_name}
        if len(normalized) > MAX_STUDENTS:
            raise MVPError(f"单次最多导入 {MAX_STUDENTS} 名学生。")
    if not normalized:
        raise MVPError("学生名单为空，请填写姓名和学号后重新导入。")
    return list(normalized.values())


def parse_student_roster(content: bytes, filename: str) -> list:
    """支持 UTF-8/GB18030 CSV 和 xlsx，第一行为姓名/学号表头。"""
    if len(content) > MAX_ROSTER_BYTES:
        raise MVPError("学生名单文件不能超过 10 MB。")
    suffix = Path(filename).suffix.lower()
    try:
        if suffix == ".xlsx":
            frame = pd.read_excel(BytesIO(content), header=None, dtype=str, keep_default_na=False,
                                  engine="openpyxl", nrows=MAX_STUDENTS + 2)
        elif suffix == ".csv":
            try:
                text = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = content.decode("gb18030")
            frame = pd.read_csv(BytesIO(text.encode("utf-8")), header=None, dtype=str,
                                keep_default_na=False, nrows=MAX_STUDENTS + 2)
        else:
            raise MVPError("请选择 .xlsx 或 .csv 学生名单。")
    except MVPError:
        raise
    except Exception as error:
        raise MVPError("学生名单读取失败，请检查文件是否损坏、CSV 编码及表格格式。") from error
    if frame.empty:
        raise MVPError("学生名单为空。")
    headers = [str(value).strip() for value in frame.iloc[0]]
    if any(headers.count(column) != 1 for column in ("姓名", "学号")):
        raise MVPError("名单首行必须包含唯一的“姓名”和“学号”两列。")
    if headers.count("班级") > 1:
        raise MVPError("名单中“班级”列不能重复。")
    data = frame.iloc[1:].fillna("")
    if len(data) > MAX_STUDENTS:
        raise MVPError(f"单次最多导入 {MAX_STUDENTS} 行。")
    students = []
    for _, row in data.iterrows():
        name, student_id = row.iloc[headers.index("姓名")], row.iloc[headers.index("学号")]
        if not str(name).strip() and not str(student_id).strip():
            continue
        class_name = row.iloc[headers.index("班级")] if "班级" in headers else ""
        students.append({"student_name": name, "student_id": student_id, "class_name": class_name})
    return normalize_students(students)
