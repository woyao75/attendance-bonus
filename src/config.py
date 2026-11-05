"""合并 JSON 业务配置与 .env 凭证，并通过 Pydantic 校验。"""

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from dotenv import dotenv_values, set_key
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator, model_validator

from .common import DEFAULT_PHASH_THRESHOLD, MVPError, UNLIMITED_WINDOW, atomic_path, read_json, save_json, single_process


DEFAULT_CONFIG = {
    "email_account": "your_qq@qq.com",
    "target_lat": 39.9042,
    "target_lon": 116.4074,
    "threshold_meters": 200.0,
    "phash_distance_threshold": DEFAULT_PHASH_THRESHOLD,
    "attendance_start": "",
    "attendance_end": "",
    "photo_timezone": "+08:00",
    "max_attachment_bytes": 10 * 1024 * 1024,
    "max_email_bytes": 25 * 1024 * 1024,
}
ENV_EXAMPLE = "# QQ 邮箱 IMAP 授权码，不是登录密码。\nIMAP_AUTH_CODE=your_auth_code\n"


def parse_timezone(value):
    match = re.fullmatch(r"([+-])(\d{2}):(\d{2})", str(value))
    if not match:
        raise MVPError("时区必须为固定偏移，例如 +08:00。")
    hours, minutes = int(match[2]), int(match[3])
    if hours > 23 or minutes > 59:
        raise MVPError("时区偏移超出范围。")
    delta = timedelta(hours=hours, minutes=minutes)
    return timezone(delta if match[1] == "+" else -delta)


class AppConfig(BaseModel):
    """SecretStr 避免凭证出现在模型 repr/JSON 中；配置源由 load_config 控制。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, hide_input_in_errors=True,
                              validate_assignment=True)
    email_account: str
    imap_auth_code: SecretStr = Field(repr=False, exclude=True)
    target_lat: float = Field(ge=-90, le=90)
    target_lon: float = Field(ge=-180, le=180)
    threshold_meters: float = Field(ge=0)
    phash_distance_threshold: int = Field(default=DEFAULT_PHASH_THRESHOLD, ge=0, le=64, strict=True)
    attendance_start: str = ""
    attendance_end: str = ""
    photo_timezone: str = "+08:00"
    max_attachment_bytes: int = Field(default=10 * 1024 * 1024, gt=0, strict=True)
    max_email_bytes: int = Field(default=25 * 1024 * 1024, gt=0, strict=True)

    @field_validator("target_lat", "target_lon", "threshold_meters", mode="before")
    @classmethod
    def reject_boolean(cls, value):
        if isinstance(value, bool):
            raise ValueError("必须是数值，不能为布尔值")
        return value

    @field_validator("email_account")
    @classmethod
    def validate_account(cls, value):
        value = value.strip()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+", value) or value == DEFAULT_CONFIG["email_account"]:
            raise ValueError("请填写真实邮箱")
        return value

    @field_validator("imap_auth_code")
    @classmethod
    def validate_secret(cls, value):
        secret = value.get_secret_value()
        if not secret.strip() or secret == "your_auth_code" or secret != secret.strip():
            raise ValueError("请在 .env 中填写 IMAP 授权码")
        return value

    @model_validator(mode="after")
    def validate_times(self):
        try:
            parse_timezone(self.photo_timezone)
            if bool(self.attendance_start) != bool(self.attendance_end):
                raise ValueError("打卡起止时间必须同时填写")
            bounds = self.window
            if bounds and (any(bound.utcoffset() is None for bound in bounds) or bounds[0] > bounds[1]):
                raise ValueError("打卡时间必须包含时区，且起点不晚于终点")
        except MVPError as exc:
            raise ValueError(str(exc)) from None
        return self

    @property
    def photo_tz(self):
        return parse_timezone(self.photo_timezone)

    @property
    def window(self):
        if not self.attendance_start:
            return None
        return datetime.fromisoformat(self.attendance_start), datetime.fromisoformat(self.attendance_end)

    @property
    def window_label(self):
        if not self.window:
            return UNLIMITED_WINDOW
        return "/".join(bound.astimezone(timezone.utc).isoformat() for bound in self.window)


def load_config(config_path="config.json", env_path=".env") -> AppConfig:
    if not Path(config_path).exists() or not Path(env_path).exists():
        raise MVPError("缺少 config.json 或 .env，请先执行 init 并填写配置。")
    business = read_json(config_path)
    if "imap_auth_code" in business:
        raise MVPError("请将 config.json 中的 imap_auth_code 移至 .env 的 IMAP_AUTH_CODE，并删除 JSON 中该字段。")
    # 不读取进程环境，不做 ${VAR} 插值，确保凭证只来源于指定 .env 文件。
    secret = dotenv_values(env_path, encoding="utf-8", interpolate=False).get("IMAP_AUTH_CODE")
    if secret is None:
        raise MVPError(".env 缺少 IMAP_AUTH_CODE，请填写 QQ 邮箱 IMAP 授权码。")
    try:
        return AppConfig.model_validate({**DEFAULT_CONFIG, **business, "imap_auth_code": secret})
    except ValidationError as exc:
        # 不输出 Pydantic 的 input/context，避免配置异常泄露凭证。
        fields = sorted({".".join(map(str, error["loc"])) or "时间窗口/时区"
                         for error in exc.errors(include_input=False, include_context=False)})
        raise MVPError("配置校验失败，请检查字段：" + ", ".join(fields)) from None


def init_config():
    """只生成缺失文件，既有 JSON 和 .env 都不会被覆盖。"""
    generated = []
    if not Path("config.json").exists():
        save_json("config.json", DEFAULT_CONFIG)
        generated.append("config.json")
    if not Path(".env").exists():
        with atomic_path(".env") as temp:
            temp.write_text(ENV_EXAMPLE, encoding="utf-8")
        generated.append(".env")
    if not generated:
        raise MVPError("config.json 和 .env 已存在，未覆盖。请直接编辑配置。")
    print("已生成 " + "、".join(generated) + "。邮箱和业务参数填 config.json；IMAP 授权码填 .env。")


def read_business_config(work_dir="."):
    path = Path(work_dir) / "config.json"
    value = read_json(path) if path.exists() else {}
    if "imap_auth_code" in value:
        raise MVPError("请先将旧 JSON 的 imap_auth_code 移至 .env，再删除该字段。")
    return {**DEFAULT_CONFIG, **value}


def save_config(changes: dict, auth_code="", work_dir=".") -> AppConfig:
    """表单保存：先校验，留空保留授权码；写入失败时恢复之前的两个文件。"""
    from .logger import add_secret

    folder = Path(work_dir)
    config_path, env_path = folder / "config.json", folder / ".env"
    with single_process(folder):
        business = {**read_business_config(folder), **changes}
        if "imap_auth_code" in business:
            raise MVPError("授权码只能写入 .env。")
        old_env = env_path.read_bytes() if env_path.exists() else None
        old_config = config_path.read_bytes() if config_path.exists() else None
        saved_secret = dotenv_values(env_path, interpolate=False).get("IMAP_AUTH_CODE") if env_path.exists() else None
        secret = auth_code if auth_code else saved_secret
        add_secret(secret)
        try:
            config = AppConfig.model_validate({**business, "imap_auth_code": secret})
        except ValidationError as exc:
            labels = {"email_account": "QQ 邮箱", "imap_auth_code": "邮箱授权码", "target_lat": "目标纬度",
                      "target_lon": "目标经度", "threshold_meters": "距离阈值",
                      "phash_distance_threshold": "照片相似度阈值"}
            fields = sorted({labels.get(".".join(map(str, error["loc"])), "时间窗口或其他配置")
                             for error in exc.errors(include_input=False, include_context=False)})
            raise MVPError("配置未保存，请检查：" + ", ".join(fields)) from None
        try:
            # 两个独立文件不能组成数据库事务；错误时恢复原始字节。
            save_json(config_path, config.model_dump())
            with atomic_path(env_path) as temp:
                temp.write_bytes(old_env or b"")
                set_key(str(temp), "IMAP_AUTH_CODE", secret, quote_mode="always")
        except Exception:
            for path, previous in ((config_path, old_config), (env_path, old_env)):
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    with atomic_path(path) as temp:
                        temp.write_bytes(previous)
            raise
        return config
