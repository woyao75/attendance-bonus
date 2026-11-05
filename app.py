"""Streamlit 本地管理后台：python -m streamlit run app.py。"""

import logging
from datetime import datetime, timedelta, timezone
import math
import os
from pathlib import Path

import pandas as pd
import streamlit as st

from src.common import DEFAULT_PHASH_THRESHOLD, MVPError, single_process
from src.config import DEFAULT_CONFIG, load_config, read_business_config, save_config
from src.data_store import SqliteDataStore
from src.email_fetcher import fetch_emails
from src.logger import add_secret, redact, setup_logging
from src.report_generator import generate_report, generate_student_attendance_report
from src.photo_deduplicator import validate_threshold
from src.web_helpers import safe_photo_path
from src.student_roster import parse_student_roster
from src.ui import load_styles, masthead, photo_placeholder, section_heading, sidebar_brand, styled_statuses


WORK_DIR = Path(os.environ.get("ATTENDANCE_WORK_DIR", Path(__file__).resolve().parent)).resolve()
log = logging.getLogger(__name__)
PAGE_SIZE = 200
ROSTER_TEMPLATE = "姓名,学号,班级\n张三,0020230001,计算机一班\n李四,0020230002,计算机二班\n".encode("utf-8-sig")


def show_error(action, error):
    log.exception("%s失败。", action)
    if isinstance(error, MVPError):
        message = redact(str(error))
    else:
        message = "请检查邮箱连接、文件权限或稍后重试。详细原因已记录到运行日志。"
    st.error(f"{action}失败：{message}")


def settings_panel():
    try:
        business = read_business_config(WORK_DIR)
    except Exception as error:
        show_error("读取配置", error)
        business = DEFAULT_CONFIG.copy()
    try:
        saved_phash_threshold = validate_threshold(business["phash_distance_threshold"])
    except ValueError:
        saved_phash_threshold = DEFAULT_PHASH_THRESHOLD
        st.warning("已保存的照片相似度阈值无效，请选择 0～64 的整数并保存配置。")
    if st.session_state.pop("clear_auth", False):
        st.session_state["auth_code"] = ""
    with st.form("settings"):
        st.subheader("系统配置")
        account = st.text_input("QQ 邮箱", value=business["email_account"])
        latitude = st.text_input("目标纬度", value=str(business["target_lat"]))
        longitude = st.text_input("目标经度", value=str(business["target_lon"]))
        threshold = st.text_input("距离阈值（米）", value=str(business["threshold_meters"]))
        phash_threshold = st.number_input("照片相似度阈值（汉明距离）", min_value=0, max_value=64,
                                          value=saved_phash_threshold, step=1,
                                          help="默认 5；0 仅匹配相同 pHash，值越大越容易命中。相似不等于作弊。")
        auth = st.text_input("QQ 邮箱授权码", type="password", key="auth_code",
                             help="首次使用请填写；留空则保留已保存的授权码。")
        with st.expander("拍摄时间校验"):
            start = st.text_input("窗口开始", value=business["attendance_start"], placeholder="2026-11-05T08:00:00+08:00")
            end = st.text_input("窗口结束", value=business["attendance_end"], placeholder="2026-11-05T10:00:00+08:00")
            photo_tz = st.text_input("照片默认时区", value=business["photo_timezone"])
            st.caption("开始与结束均留空时，校验照片软件信息及坐标。")
        save = st.form_submit_button("保存配置", use_container_width=True)
    st.caption("新配置用于后续新提交，已有校验结果不会重新计算。")
    if save:
        try:
            add_secret(auth)
            with st.spinner("正在保存配置…"):
                save_config({"email_account": account, "target_lat": latitude, "target_lon": longitude,
                             "threshold_meters": threshold, "phash_distance_threshold": phash_threshold,
                             "attendance_start": start,
                             "attendance_end": end, "photo_timezone": photo_tz}, auth, WORK_DIR)
            st.session_state["clear_auth"] = True
            st.session_state["flash"] = "配置已保存。"
            st.rerun()
        except Exception as error:
            show_error("保存配置", error)


def sidebar(store):
    with st.sidebar:
        sidebar_brand()

        st.subheader("日常操作")
        if st.button("一键拉取并校验", type="primary", use_container_width=True, disabled=store is None):
            progress = None
            try:
                with st.spinner("正在连接邮箱、读取照片并校验…"):
                    config = load_config(WORK_DIR / "config.json", WORK_DIR / ".env")
                    add_secret(config.imap_auth_code.get_secret_value())
                    progress = st.progress(0, text="正在搜索新邮件…")

                    def update(done, total):
                        progress.progress(done / total, text=f"已处理 {done} / {total} 封邮件")

                    with single_process(WORK_DIR):
                        log.info("开始从 Web 拉取邮件。")
                        result = fetch_emails(config, store, WORK_DIR, update)
                    log.info("Web 拉取完成。")
                st.session_state.pop("report_bytes", None)
                st.session_state["flash"] = f"拉取完成：处理 {result['emails']} 封邮件，新增 {result['records']} 条记录。"
                st.rerun()
            except Exception as error:
                show_error("邮件拉取", error)
            finally:
                if progress is not None:
                    progress.empty()

        if st.button("重新比对历史照片", use_container_width=True, disabled=store is None):
            progress = None
            try:
                with st.spinner("正在按已保存的相似度阈值重新比对历史照片…"):
                    threshold_value = read_business_config(WORK_DIR)["phash_distance_threshold"]
                    progress = st.progress(0, text="正在读取历史哈希…")

                    def update_comparison(done, total):
                        progress.progress(done / total, text=f"已比对 {done} / {total} 条记录")

                    with single_process(WORK_DIR):
                        log.info("开始重新比对历史照片。")
                        counts = store.recheck_duplicates(threshold_value, update_comparison)
                    log.info("历史照片比对完成：%s", counts)
                st.session_state.pop("report_bytes", None)
                st.session_state["flash"] = (f"历史比对完成：疑似重复 {counts['疑似重复']} 条，"
                                            f"校验异常 {counts['校验异常']} 条，未校验 {counts['未校验']} 条。")
                st.rerun()
            except Exception as error:
                show_error("历史照片比对", error)
            finally:
                if progress is not None:
                    progress.empty()

        if st.button("生成并下载报表", use_container_width=True, disabled=store is None):
            try:
                with st.spinner("正在汇总记录并生成 Excel…"):
                    st.session_state["report_bytes"] = generate_report(store)
                st.success("报表已生成，请点击下方下载。")
            except Exception as error:
                st.session_state.pop("report_bytes", None)
                show_error("生成报表", error)
        if "report_bytes" in st.session_state:
            st.download_button("下载考勤汇总报表", data=st.session_state["report_bytes"],
                               file_name="考勤汇总报表.xlsx",
                               mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                               use_container_width=True)
        if st.button("刷新数据", use_container_width=True):
            st.rerun()
        st.divider()
        with st.expander("邮箱与校验配置", expanded=not (WORK_DIR / ".env").exists()):
            settings_panel()
        with st.expander("学生如何提交？"):
            st.write("邮件主题填写“姓名+学号”，例如 张三+0020230001，附上 JPG/JPEG 原图。")
            st.caption("请发送原图，聊天软件压缩或截图可能丢失定位和拍摄时间。")
        st.caption("授权码保存在本机，页面不会回显。")


def roster_import(store):
    with st.expander("学生名单导入", expanded=not store.load_students()):
        st.caption("支持 Excel（.xlsx）和 CSV，首行包含“姓名”“学号”“班级”。兼容旧的两列名单；未填班级归为“未分班”。学号列请保存为文本以保留前导零。")
        st.download_button("下载学生名单模板", data=ROSTER_TEMPLATE, file_name="学生名单模板.csv", mime="text/csv")
        with st.form("student_roster_import"):
            upload = st.file_uploader("选择学生名单", type=["xlsx", "csv"], key="student_roster_file")
            submit = st.form_submit_button("导入学生名单")
        st.caption("导入会追加新学生，并更新同名同学号的班级；班级留空保留原归属。同学号姓名冲突时整批取消。")
        if submit:
            try:
                if upload is None:
                    raise MVPError("请先选择学生名单文件。")
                students = parse_student_roster(upload.getvalue(), upload.name)
                with single_process(WORK_DIR):
                    result = store.import_students(students)
                st.session_state["flash"] = (f"名单导入完成：新增 {result['inserted']} 人，"
                                              f"更新班级 {result['updated']} 人，跳过 {result['skipped']} 人，当前共 {result['total']} 人。")
                st.rerun()
            except Exception as error:
                show_error("名单导入", error)


def teacher_attendance_panel(store, day, students):
    with st.expander("请假登记 / 老师代签"):
        st.caption(f"考勤日期：{day.isoformat()}。可登记请假，或为已核实到场的学生代签；也可对历史日期补签。")
        if not students:
            st.info("当前班级没有学生，请先导入名单。")
            return
        by_id = {student["student_id"]: student for student in students}
        if st.session_state.get("manual_student") not in by_id:
            st.session_state["manual_student"] = next(iter(by_id))
        selected_id = st.selectbox("办理学生", list(by_id), key="manual_student",
                                   format_func=lambda value: f"{by_id[value]['class_name'] or '未分班'} · {by_id[value]['student_name']} · {value}")
        student = by_id[selected_id]
        st.write(f"当前状态：{student['status']}；照片校验：{student['base_status']}")
        st.caption("同一学生同一天以最后一次人工登记为准；撤销后恢复照片校验结果。")
        with st.form("teacher_attendance_form", clear_on_submit=True):
            action = st.selectbox("办理类型", ["老师代签", "请假", "撤销"], key="manual_action")
            teacher = st.text_input("经办老师姓名", max_chars=100, key="manual_teacher")
            reason = st.text_area("办理原因", max_chars=1000, key="manual_reason")
            save = st.form_submit_button("保存考勤登记")
        if save:
            try:
                with single_process(WORK_DIR):
                    store.record_teacher_attendance(selected_id, day.isoformat(), action, reason, teacher)
                log.info("人工考勤登记完成：学号 %s，日期 %s，操作 %s。", selected_id, day.isoformat(), action)
                st.session_state["flash"] = f"已保存：{student['student_name']} · {day.isoformat()} · {action}。"
                st.session_state.pop("student_attendance_bytes", None)
                st.rerun()
            except Exception as error:
                show_error("考勤登记", error)
        history = store.teacher_attendance_history(selected_id, day.isoformat())
        if history:
            st.markdown("**当天人工登记记录**")
            frame = pd.DataFrame(history)[["action", "reason", "teacher", "created_at"]]
            st.dataframe(frame.rename(columns={"action": "操作", "reason": "原因", "teacher": "经办老师",
                                              "created_at": "记录时间（UTC）"}), hide_index=True, width="stretch")


def student_statistics(store):
    section_heading("学生考勤", "按收件日期和班级查看提交情况，快速找到尚未提交的学生。")
    students = store.load_students()
    if not students:
        st.info("还没有学生名单。请打开“名单管理”，下载模板并导入姓名、学号和班级，再回到这里查看提交情况。")
        return
    today = datetime.now(timezone(timedelta(hours=8))).date()
    date_control, class_control = st.columns(2)
    day = date_control.date_input("统计日期（北京时间）", value=today, key="roster_day")
    classes = [None, *sorted({student["class_name"] for student in students})]
    if st.session_state.get("roster_class") not in classes:
        st.session_state["roster_class"] = None
    selected_class = class_control.selectbox("统计班级", classes, key="roster_class",
                                  format_func=lambda value: "全部班级" if value is None else value or "未分班")
    result = store.student_attendance(day.isoformat(), class_name=selected_class)
    stats = result["statistics"]
    for column, label, key in zip(st.columns(5), ("名单人数", "已提交人数", "校验通过人数", "待核验人数", "未提交人数"),
                                  ("total", "submitted", "passed", "pending", "missing")):
        column.metric(label, stats[key])
    for column, label, key in zip(st.columns(3), ("老师代签人数", "请假人数", "出勤人数（含代签）"),
                                  ("signed", "leave", "present")):
        column.metric(label, stats[key])
    st.caption("按北京时间收件日期统计，单位为学生；同一学生多张照片只计一人。姓名须与名单一致，至少一张照片通过基础校验才计为通过。")
    st.caption("姓名不匹配或照片未通过归入待核验；照片重复与 pHash 结果仍在打卡记录中单独展示。")
    st.caption("老师代签计为出勤，请假单独统计；两者均不再计入未提交或待核验。已提交人数仅表示收到照片。")
    teacher_attendance_panel(store, day, result["students"])
    if result["classes"]:
        st.markdown("**班级汇总**")
        class_frame = pd.DataFrame(result["classes"])
        class_frame["class_name"] = class_frame["class_name"].replace("", "未分班")
        st.dataframe(class_frame.rename(columns={"class_name": "班级", "total": "名单人数", "submitted": "已提交人数",
                                                "passed": "校验通过人数", "pending": "待核验人数", "missing": "未提交人数",
                                                "signed": "老师代签人数", "leave": "请假人数", "present": "出勤人数（含代签）"}),
                     hide_index=True, width="stretch")
    choice = st.selectbox("学生提交状态", ["全部学生", "校验通过", "老师代签", "请假", "未通过", "姓名不匹配", "未提交"], key="student_status")
    rows = [row for row in result["students"] if choice == "全部学生" or row["status"] == choice]
    if rows:
        names = {"class_name": "班级", "student_id": "学号", "student_name": "姓名", "status": "提交状态",
                 "base_status": "照片校验状态", "teacher": "经办老师", "manual_created_at": "人工登记时间（UTC）",
                 "submission_count": "照片数", "valid_count": "通过照片数", "reason": "说明",
                 "latest_email_time": "最近收件时间（北京）"}
        frame = pd.DataFrame(rows)[list(names)].rename(columns=names)
        frame["班级"] = frame["班级"].replace("", "未分班")
        st.dataframe(styled_statuses(frame), hide_index=True, width="stretch")
    else:
        st.info("所选日期没有符合该状态的学生。")
    if st.button("生成学生考勤报表", key="generate_student_attendance"):
        try:
            st.session_state["student_attendance_bytes"] = (day.isoformat(), selected_class,
                generate_student_attendance_report(store, day.isoformat(), selected_class))
        except Exception as error:
            st.session_state.pop("student_attendance_bytes", None)
            show_error("生成学生考勤报表", error)
    report = st.session_state.get("student_attendance_bytes")
    if report and report[:2] == (day.isoformat(), selected_class):
        st.download_button("下载学生考勤报表（含请假和代签）", data=report[2], file_name=f"学生考勤_{day.isoformat()}.xlsx",
                           mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    if result["outsiders"]:
        st.warning(f"所选日期全部班级共有 {len(result['outsiders'])} 组名单外学生提交，班级归属未知，未计入班级统计。")
        with st.expander("查看名单外提交"):
            st.dataframe(pd.DataFrame(result["outsiders"]).rename(columns={"student_id": "学号", "student_name": "邮件姓名",
                                                                           "submission_count": "照片数"}),
                         hide_index=True, width="stretch")
    st.divider()


def overview(store):
    with st.spinner("正在读取考勤数据…"):
        stats = store.statistics()
    with st.container(key="overview"):
        metrics = st.columns(4)
        for column, label, key in zip(metrics[:3], ("总打卡数", "有效打卡数", "异常 / 待核验"), ("total", "valid", "invalid")):
            column.metric(label, stats[key])
        metrics[3].metric("疑似重复", store.count_records(duplicate_status="疑似重复"))
    st.caption("按照片提交计数；有效表示基础校验通过，疑似重复单独统计，需人工核验。")


def dashboard(store):
    section_heading("照片核验", "筛选提交记录，查看原图与相似历史照片。有效与重复判定分别展示。")
    controls = st.columns([2, 2, 1])
    choice = controls[0].selectbox("校验结果", ["全部", "有效", "无效"], key="result_filter")
    valid = {"全部": None, "有效": True, "无效": False}[choice]
    duplicate_choice = controls[1].selectbox("照片重复判定", ["全部", "疑似重复", "未发现重复", "校验异常", "未校验"],
                                             key="duplicate_filter")
    duplicate_filter = None if duplicate_choice == "全部" else duplicate_choice
    count = store.count_records(valid, duplicate_filter)
    pages = max(1, math.ceil(count / PAGE_SIZE))
    filters = (choice, duplicate_choice)
    if st.session_state.get("last_filter") != filters:
        st.session_state["page"] = 1
        st.session_state["last_filter"] = filters
    if st.session_state.get("page", 1) > pages:
        st.session_state["page"] = pages
    page = controls[2].number_input("页码", min_value=1, max_value=pages, step=1, key="page")
    with st.spinner("正在加载记录明细…"):
        rows = store.query_records(valid, limit=PAGE_SIZE, offset=(page - 1) * PAGE_SIZE, duplicate_status=duplicate_filter)
    st.caption(f"共 {count} 条记录，第 {page} / {pages} 页；每页最多 {PAGE_SIZE} 条，可点击表头排序当前页。")
    if not rows:
        if store.count_records():
            st.info("当前筛选下没有记录。请切换校验结果或照片重复判定，查看其他提交。")
        else:
            st.info("还没有打卡记录。请在左侧保存邮箱配置，收到学生照片后点击“一键拉取并校验”。")
        return
    with st.container(key="record_workspace", border=True):
        table, preview = st.columns([1.9, 1], gap="large")
        with table:
            frame = pd.DataFrame(rows)
            frame["校验结果"] = frame["is_valid"].map({True: "有效", False: "无效"})
            names = {"id": "编号", "student_id": "学号", "student_name": "姓名", "email_time": "收件时间",
                     "photo_name": "照片", "distance": "距离（米）", "reason": "原因", "shoot_time": "拍摄时间",
                     "exif_lat": "照片纬度", "exif_lon": "照片经度", "created_at": "入库时间",
                     "exif_software": "EXIF 软件信息", "software_check": "软件校验结果",
                     "duplicate_status": "照片重复判定", "duplicate_reason": "重复判定说明",
                     "duplicate_record_id": "关联记录编号", "duplicate_distance": "汉明距离",
                     "duplicate_threshold": "比对阈值",
                     "photo_phash": "照片 pHash", "phash_status": "pHash 计算结果", "phash_reason": "pHash 异常原因"}
            visible = ["id", "student_id", "student_name", "校验结果", "distance", "reason", "email_time",
                       "duplicate_status", "duplicate_reason", "duplicate_record_id", "duplicate_distance", "duplicate_threshold",
                       "software_check", "exif_software", "phash_status", "phash_reason", "photo_phash",
                       "shoot_time", "photo_name", "exif_lat", "exif_lon", "created_at"]
            st.dataframe(styled_statuses(frame[visible].rename(columns=names)), hide_index=True, width="stretch",
                         height=min(540, 42 + 35 * len(rows)),
                         column_order=["姓名", "学号", "校验结果", "照片重复判定", "距离（米）"],
                         column_config={"距离（米）": st.column_config.NumberColumn(format="%.2f"),
                                        "照片重复判定": st.column_config.TextColumn(width="medium"),
                                        "姓名": st.column_config.TextColumn(width="small"),
                                        "学号": st.column_config.TextColumn(width=110)})
            st.caption("默认显示常用信息；可在表格工具栏中显示更多列。在照片预览区选择记录查看原图。")
        with preview, st.container(key="photo_review"):
            st.markdown("**照片预览**")
            record_ids = [row["id"] for row in rows]
            if st.session_state.get("photo_record") not in record_ids:
                st.session_state["photo_record"] = record_ids[0]
            selected_id = st.selectbox("选择本页记录", record_ids, key="photo_record",
                                       format_func=lambda value: next(f"{row['student_id']} · {row['student_name']}（#{value}）"
                                                                      for row in rows if row["id"] == value))
            selected = next(row for row in rows if row["id"] == selected_id)
            photo = safe_photo_path(selected.get("photo_path"), WORK_DIR)
            if photo is None:
                photo_placeholder()
                st.warning("这条记录没有可预览的照片，或本地文件已不存在。")
            else:
                try:
                    with st.spinner("正在加载照片…"):
                        st.image(str(photo), caption=selected["photo_name"], width="stretch")
                except Exception as error:
                    show_error("照片预览", error)
            st.caption(selected["reason"])
            with st.expander("查看照片校验详情"):
                st.write("照片：", selected["photo_name"])
                st.write("软件校验：", selected["software_check"])
                st.write("拍摄时间：", selected["shoot_time"] or "未提供")
                st.write("照片位置：", f"{selected['exif_lat']}, {selected['exif_lon']}" if selected["exif_lat"] is not None else "未提供")
                st.write("相似度比对：", selected["duplicate_reason"] or "未校验")
                st.caption(f"照片指纹：{selected['photo_phash'] or '未计算'}")
            if selected.get("phash_status") == "校验异常":
                st.warning(selected.get("phash_reason") or "pHash 计算异常，请人工核验。")
            if selected["duplicate_status"] in ("疑似重复", "校验异常"):
                st.warning(selected["duplicate_reason"])
            if selected.get("duplicate_record_id") is not None:
                related = store.get_record(selected["duplicate_record_id"])
                if related is None:
                    st.warning("关联的历史记录不存在，请人工核验。")
                else:
                    st.markdown("**相似历史照片**")
                    st.caption(f"#{related['id']} · 学号 {related['student_id']} · {related['student_name']}")
                    st.caption(f"收件时间：{related['email_time']}；汉明距离：{selected['duplicate_distance']} / 64")
                    related_photo = safe_photo_path(related.get("photo_path"), WORK_DIR)
                    if related_photo is None:
                        st.warning("关联历史照片文件不存在或无法安全预览，记录仍可供人工核验。")
                    else:
                        try:
                            with st.spinner("正在加载相似历史照片…"):
                                st.image(str(related_photo), caption=related["photo_name"], width="stretch")
                        except Exception as error:
                            show_error("历史照片预览", error)


def main():
    st.set_page_config(page_title="校园考勤工作台", page_icon="📋", layout="wide")
    load_styles()
    masthead()
    if flash := st.session_state.pop("flash", None):
        st.success(flash)
    store = None
    try:
        setup_logging(WORK_DIR / "logs", WORK_DIR / ".env")
        with st.spinner("正在连接考勤数据库…"):
            store = SqliteDataStore(WORK_DIR / "data/attendance.db")
    except Exception as error:
        show_error("初始化后台", error)
    sidebar(store)
    if store is not None:
        try:
            overview(store)
            photos, students, roster = st.tabs(["照片核验", "学生考勤", "名单管理"])
            with photos:
                dashboard(store)
            with students:
                student_statistics(store)
            with roster:
                section_heading("名单管理", "导入姓名、学号与班级，为学生提交统计建立依据。")
                roster_import(store)
                students_list = store.load_students()
                if students_list:
                    st.caption(f"当前名单共 {len(students_list)} 人。学号按文本保存，保留前导零。")
                    st.dataframe(pd.DataFrame(students_list)[["class_name", "student_id", "student_name"]]
                                 .replace({"class_name": {"": "未分班"}})
                                 .rename(columns={"class_name": "班级", "student_id": "学号", "student_name": "姓名"}),
                                 hide_index=True, width="stretch")
            with st.expander("校验结果如何理解？"):
                st.write("有效表示照片通过了当前配置的软件信息、位置及时间规则。照片元数据可以修改，校验结果不能证明本人到场。")
                st.write("疑似重复表示照片与历史提交相似，需要查看关联照片并人工核验；未校验或校验异常也应人工确认。")
        except Exception as error:
            show_error("读取考勤记录", error)


if __name__ == "__main__":
    main()

# Linux：.venv/bin/python -m streamlit run app.py --server.address=0.0.0.0
# 后台：nohup .venv/bin/python -m streamlit run app.py --server.address=0.0.0.0 > logs/web.log 2>&1 &
# 详细部署、访问范围和停止方法见 README.md 的《Linux 部署与运行指南》。
