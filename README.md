# 大学生照片打卡校验 MVP

单文件 Python CLI：QQ 邮箱 → JPEG EXIF → Haversine 距离校验 → CSV → Excel。
第三方依赖只有 `exifread`、`pandas`、`openpyxl`，建议 Python 3.11 或更高版本。

## 快速运行

```bash
python -m venv .venv
source .venv/bin/activate
# Windows PowerShell：.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python mvp_agent.py init
# 编辑当前目录 config.json，填写邮箱、授权码和目标坐标
python mvp_agent.py fetch
python mvp_agent.py report
```

所有数据相对**执行命令时的当前目录**存储。`init` 无需第三方依赖，也不会覆盖已有配置。
`fetch` 固定连接 `imap.qq.com:993`（SSL），只扫描 `INBOX`，首次扫描其中全部邮件，
后续从上次成功处理的位置继续。人工标记已读不影响处理，本工具也不修改已读状态。
建议先使用只有少量测试邮件的邮箱或收件箱验证。

QQ 邮箱网页版进入“设置 → 账户”（新版可能是“账号与安全”），开启 IMAP/SMTP 服务，
按页面指引完成身份验证并生成授权码。`imap_auth_code` 填授权码，不能填 QQ 登录密码。
配置文件含凭证，不要分享。生成文件已加入 `.gitignore`。

## 规则与配置

邮件主题必须为 `【打卡】学号-姓名`，例如 `【打卡】0020230001-张三`。
学号仅接受数字并保留前导零；只处理有 `.jpg`/`.jpeg` 文件名的 MIME 图片部件。
不匹配主题的邮件会跳过并推进进度，修改规则不会自动回溯历史邮件。
附件保存在 `attachments/`，使用来源标识的 SHA-256 生成文件名；原始文件名只保存在 CSV 中。

默认只校验坐标：到目标点的距离 **小于等于** `threshold_meters` 则通过，地球半径为 6371000 米。
缺少或损坏 GPS、非 JPEG、损坏 EXIF、附件过大等均记录为未通过，供人工核验。
单附件默认上限 10 MiB、整封邮件默认上限 25 MiB。超过整封邮件上限会停止并保留进度，
调高 `max_email_bytes` 后重试，或人工将该邮件移出收件箱。

如需校验本次打卡的拍摄时间，填写两个边界（均包含端点）：

```json
{
  "attendance_start": "2026-11-05T08:00:00+08:00",
  "attendance_end": "2026-11-05T10:00:00+08:00",
  "photo_timezone": "+08:00"
}
```

这是 `config.json` 的局部示例，请保留其余配置。起止时间必须同时填写且带时区。
优先使用照片 `OffsetTimeOriginal`；没有时使用 `photo_timezone`。
时区无法从普通 EXIF 拍摄时间自动推断，使用者必须确认配置符合实际拍摄地区。
启用窗口后，缺少拍摄时间或时间格式错误的照片不能自动通过。
邮件时间使用服务器 `INTERNALDATE`，不信任发件人填写的 `Date`。

## 文件与报表

- `mvp_agent.py`：全部核心逻辑。
- `config.json`：配置和授权码。
- `state.json`：邮箱、UIDVALIDITY、最后成功处理的 UID。
- `records.csv`：原始附件级结果，UTF-8 BOM 编码；包含指定的十列，以及 `source_key`、`attendance_window`、`validation_scope`。
- `考勤汇总报表.xlsx`：附件明细、学生汇总、使用说明；表头加粗，通过行浅绿，其余行浅红。

同一学号、同一窗口至少一张照片通过则汇总一次通过；同一学号姓名冲突需人工核验。
未配置窗口时按**北京时间收件日期**汇总，明确显示未校验拍摄时间。
已有记录保留处理当时的窗口和校验结果，`report` 不重新验证 EXIF。
不同打卡活动或目标坐标请使用不同工作目录，避免混合配置。

写入 CSV 后才推进邮件进度；中断后重试按附件来源标识去重。
UIDVALIDITY 改变或更换邮箱会重新扫描，并使用新来源标识，可能产生相同内容的新记录；
请保留旧数据供核对。邮件无可处理附件时也推进进度。
CSV 会拒绝冲突的来源标识和不明确的布尔值，而不静默覆盖。

每个目录仅允许一个任务同时运行。正常结束或 Ctrl+C 会释放锁；
强制结束留下 `.mvp_agent.lock` 时，先确认没有运行中的任务，再手工删除锁文件。
不要在 Excel 占用输出文件时生成报表。

## 使用边界

EXIF 坐标和拍摄时间均可伪造，图片压缩也可能移除元数据。
**校验通过不证明学生本人到场，缺少 GPS 也不代表作弊。**
本 MVP 不绑定发件邮箱与学号、不识别重复照片、不验证邮件身份，也没有学生名单；
不能据此直接推导本人出勤或未提交者缺勤。
CSV 是本地可信工作文件，手工修改会影响报表；直接用表格软件打开 CSV 时应将外部文本按文本导入。
生成的 XLSX 会把附件名、姓名等外部文本强制写成文本，防止公式被执行。

测试无需真实邮箱：

```bash
python -m unittest discover -s tests -v
```
