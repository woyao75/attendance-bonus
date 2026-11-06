"""Streamlit 展示组件与样式；不访问业务数据或保存凭证。"""

from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path

import streamlit as st


def load_styles():
    styles = (Path(__file__).resolve().parents[1] / "assets/workspace.css").read_text(encoding="utf-8")
    st.markdown(f"<style>{styles}</style>", unsafe_allow_html=True)


def masthead():
    now = datetime.now(timezone(timedelta(hours=8)))
    weekday = "一二三四五六日"[now.weekday()]
    st.markdown(f"""<header class="attendance-masthead">
      <div><h1>校园考勤工作台</h1><p>按班级查看提交情况，核验照片，整理每一次考勤。</p></div>
      <div class="attendance-date" aria-label="北京时间 {now:%Y年%m月%d日} 星期{weekday}">
        <div class="attendance-date-day">{now:%m/%d}</div>
        <div class="attendance-date-detail"><strong>{now:%Y} 年 · 星期{weekday}</strong>北京时间</div>
      </div>
    </header>""", unsafe_allow_html=True)


def sidebar_brand():
    st.markdown("""<div class="attendance-brand">
      <svg class="attendance-brand-mark" viewBox="0 0 40 46" fill="none" aria-hidden="true">
        <path d="M8 5h24v36H8zM5 11h6M5 20h6M5 29h6M5 38h6" stroke="currentColor" stroke-width="2"/>
        <path d="m16 16 3 3 7-7M16 27h10M16 32h7" stroke="currentColor" stroke-width="2"/>
      </svg><div><strong>校园考勤</strong><span>辅导员工作台</span></div>
    </div>""", unsafe_allow_html=True)


def section_heading(title, description=""):
    st.markdown(f'<div class="attendance-section-heading"><h2>{escape(title)}</h2>'
                f'<p>{escape(description)}</p></div>', unsafe_allow_html=True)


def photo_placeholder():
    st.markdown("""<div class="attendance-photo-empty"><div>
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M4 9h7l2-3h6l2 3h7v17H4z" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="16" cy="17" r="5" stroke="currentColor" stroke-width="1.5"/>
      </svg>暂无可用照片</div></div>""", unsafe_allow_html=True)


def photo_verdict(valid, reason):
    """用文字、图形与颜色共同展示选中照片的基础校验结果。"""
    tone, symbol, label = ("success", "✓", "基础校验通过") if valid else ("warning", "!", "需要人工核验")
    st.markdown(f'<div class="attendance-verdict attendance-verdict-{tone}" role="status">'
                f'<span class="attendance-verdict-symbol" aria-hidden="true">{symbol}</span>'
                f'<div><strong>{label}</strong><p>{escape(reason or "请查看照片校验详情")}</p></div></div>',
                unsafe_allow_html=True)


def status_style(value):
    """表格颜色是文字状态的补充，保留文本以便色觉异常用户辨识。"""
    if value in ("疑似重复", "校验异常", "无效", "未提交", "未通过", "姓名不匹配"):
        return "color: #8f4b10; background-color: #fff1db; font-weight: 600"
    if value in ("有效", "未发现重复", "校验通过", "老师代签"):
        return "color: #235c47; background-color: #edf6f0"
    if value == "请假":
        return "color: #345579; background-color: #eef3fa"
    return ""


def styled_statuses(frame):
    columns = [name for name in ("校验结果", "照片重复判定", "提交状态") if name in frame.columns]
    return frame.style.map(status_style, subset=columns) if columns else frame
