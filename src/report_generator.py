"""带颜色的 Excel 明细和学生汇总，可直接返回下载字节。"""

from datetime import datetime, timedelta, timezone
from io import BytesIO
import logging
import math
from pathlib import Path

from .common import COLUMNS, PHASH_COLUMNS, UNLIMITED_WINDOW, MVPError, atomic_path
from .data_store import DataStore

log = logging.getLogger(__name__)


def generate_student_attendance_report(store, day, class_name=None) -> bytes:
    """导出当前日期及班级的最终考勤；原照片报表仍保留原始校验结果。"""
    from openpyxl import Workbook

    result = store.student_attendance(day, class_name)
    workbook = Workbook()
    workbook.remove(workbook.active)
    fields = ["class_name", "student_id", "student_name", "status", "base_status", "submission_count",
              "valid_count", "reason", "teacher", "manual_created_at", "latest_email_time"]
    headers = ["班级", "学号", "姓名", "考勤结果", "照片校验状态", "照片数", "通过照片数", "原因",
               "经办老师", "人工登记时间（UTC）", "最近收件时间（北京）"]
    rows = []
    for student in result["students"]:
        values = [student[field] if field != "class_name" else student[field] or "未分班" for field in fields]
        rows.append((values, student["status"] in ("校验通过", "老师代签", "请假")))
    write_sheet(workbook, "学生考勤", headers, rows, 4)
    keys = ["class_name", "total", "submitted", "passed", "signed", "leave", "present", "pending", "missing"]
    class_rows = [([row[key] if key != "class_name" else row[key] or "未分班" for key in keys], True)
                  for row in result["classes"]]
    write_sheet(workbook, "班级汇总", ["班级", "名单人数", "已提交人数", "校验通过人数", "老师代签人数",
                                     "请假人数", "出勤人数（含代签）", "待核验人数", "未提交人数"], class_rows, 1)
    notes = workbook.create_sheet("统计说明")
    class_label = "全部班级" if class_name is None else class_name or "未分班"
    for value in (f"考勤日期：{day}（北京时间）", f"班级：{class_label}",
                  "已提交人数为收到照片的学生人数；最终状态以最后一次人工登记为准。",
                  "出勤人数=照片校验通过人数+老师代签人数；请假独立统计，不计为出勤或未提交。",
                  "人工登记不改变原始照片和校验结果。经办老师姓名为页面填写值。"):
        notes.append([value])
    notes.column_dimensions["A"].width = 100
    buffer = BytesIO()
    try:
        workbook.save(buffer)
    finally:
        workbook.close()
    return buffer.getvalue()


def write_sheet(workbook, title, headers, rows, status_column):
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

    sheet = workbook.create_sheet(title)
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="D9EAF7")
    for row_index, (values, valid) in enumerate(rows, 2):
        color = "E2F0D9" if valid else "FCE4D6"
        for column, value in enumerate(values, 1):
            cell = sheet.cell(row=row_index, column=column)
            if isinstance(value, str):
                # openpyxl 默认把 = 开头的字符串当公式，必须显式强制为文本。
                cell.value = ILLEGAL_CHARACTERS_RE.sub("", value)[:32767]
                cell.data_type = "s"
            else:
                cell.value = value
            cell.fill = PatternFill("solid", fgColor=color)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if headers[column - 1] in ("distance", "exif_lat", "exif_lon"):
                cell.number_format = "0.00" if headers[column - 1] == "distance" else "0.000000"
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for column, header in enumerate(headers, 1):
        width = 36 if column == status_column or header in ("reason", "duplicate_reason", "validation_scope", "software_check", "exif_software", "校验说明") else 23
        sheet.column_dimensions[get_column_letter(column)].width = width
    return sheet

def generate_report(store: DataStore, destination=None) -> bytes:
    import pandas as pd
    from openpyxl import Workbook

    try:
        rows = store.load_records()
    except FileNotFoundError:
        rows = []
    # 保留原始十列顺序，补上数据库编号，方便在 Excel 内核对关联历史记录。
    detail_columns = COLUMNS[:-len(PHASH_COLUMNS)] + ["id"] + PHASH_COLUMNS
    records = pd.DataFrame(rows, columns=detail_columns)
    records = records.astype(object).where(pd.notna(records), "")
    if records.empty:
        raise MVPError("没有可导出的记录，请先执行 fetch。")
    for column in ("student_id", "student_name", "attendance_window", "validation_scope"):
        if records[column].str.strip().eq("").any():
            raise MVPError(f"考勤记录的 {column} 存在空值，请先核对。")
    # 检查已有数值，避免手工修改的 CSV 把非法值带入报表。
    for column in ("exif_lat", "exif_lon", "distance"):
        for value in records[column]:
            if value:
                try:
                    number = float(value)
                    if not math.isfinite(number):
                        raise ValueError
                except (TypeError, ValueError):
                    raise MVPError(f"考勤记录的 {column} 包含非法数值。") from None
    workbook = Workbook()
    workbook.remove(workbook.active)
    detail_rows = []
    for row in records.to_dict("records"):
        values = []
        for column in detail_columns:
            value = row[column]
            if column == "is_valid":
                value = "有效" if row["is_valid"] else f"无效({row['reason'] or '原因缺失，待核验'})"
            elif column in ("exif_lat", "exif_lon", "distance") and value != "":
                value = float(value)
            values.append(value)
        detail_rows.append((values, bool(row["is_valid"])))
    write_sheet(workbook, "附件明细", detail_columns, detail_rows, detail_columns.index("is_valid") + 1)
    summary_rows = []
    # 未设置窗口的记录按收件日期汇总，防止跨天提交被算成一次。
    records["_group"] = records["attendance_window"]
    for index, row in records.iterrows():
        if row["attendance_window"] == UNLIMITED_WINDOW:
            try:
                received = datetime.fromisoformat(row["email_time"])
                if received.utcoffset() is None:
                    raise ValueError
                day = received.astimezone(timezone(timedelta(hours=8))).date().isoformat()
            except ValueError:
                raise MVPError("未设置窗口的记录必须具有含时区的 email_time。") from None
            records.at[index, "_group"] = f"{day}（北京时间收件日，未校验拍摄时间）"
    for (student_id, period), group in records.groupby(["student_id", "_group"], sort=True):
        names = sorted(set(group["student_name"]))
        conflict = len(names) > 1
        valid = bool(group["is_valid"].any()) and not conflict
        status = "待人工核验(同一学号姓名冲突)" if conflict else ("校验通过" if valid else "未通过，待核验")
        duplicates = int(group["duplicate_status"].eq("疑似重复").sum())
        review = int(group["duplicate_status"].isin(["校验异常", "未校验"]).sum())
        summary_rows.append(([student_id, " / ".join(names), period, len(group),
                              int(group["is_valid"].sum()), status,
                              "；".join(sorted(set(group["validation_scope"]))), duplicates, review], valid))
    write_sheet(workbook, "学生汇总", ["学号", "姓名", "时间窗口或收件日", "附件数", "通过附件数", "校验结果", "校验说明", "疑似重复附件数", "重复比对异常或未校验数"], summary_rows, 6)
    notes = workbook.create_sheet("使用说明")
    for text in (
        "本工具验证照片元数据，不证明本人到场；EXIF 可被修改，也可能因压缩而丢失。",
        "附件明细中的有效/无效仅表示配置规则的自动校验结果，无GPS等情况应人工核验。",
        "exif_software 为 Software 标签原文，software_check 为软件校验结果；历史记录未自动重新校验。",
        "Software 缺失或未命中禁用关键词不能证明照片未经编辑；命中禁用软件时自动判为无效。",
        "duplicate_status 为独立的照片重复判定，不覆盖基础校验结果；疑似重复及异常请人工核验。",
        "按入库编号与更早的所有已计算哈希比较，保留最近似记录编号和汉明距离；距离并列时关联最早记录。",
        "duplicate_record_id 对应附件明细 id，不是 Excel 行号；可按编号在后台查看关联历史照片。",
        "同一学号同一窗口至少一张通过即记一次通过；姓名冲突需人工核验。",
        "未设置时间窗口时按北京时间收件日期汇总，仅表示坐标校验通过。",
        "本报表学生汇总按实际提交生成；名单及未提交统计请查看 Web 页面的学生提交统计。",
        "未绑定发件邮箱与学号，主题中的身份由提交者填写，需人工核对。",
        "照片无时区时使用提交处理时配置的 photo_timezone；不会自动推断实际拍摄地时区。",
        "考勤存储是可信工作数据，手工修改会影响结果；跨不同校验配置的记录请使用不同工作目录。",
    ):
        notes.append([text])
    notes.column_dimensions["A"].width = 120
    buffer = BytesIO()
    try:
        workbook.save(buffer)
    finally:
        workbook.close()
    content = buffer.getvalue()
    if destination is not None:
        with atomic_path(destination) as temp:
            temp.write_bytes(content)
    log.info("报表已生成：%s 条附件明细，%s 条学生汇总。", len(records), len(summary_rows))
    return content
