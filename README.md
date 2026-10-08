# 高校学生返校手势打卡与统计系统

一个通过邮件收集学生返校照片、由辅导员审核并导出统计材料的系统。本 README 以 **Windows + MySQL 8.0 + 本地直收邮件模式** 为主线，说明从安装软件到完成第一次打卡的全过程。

管理员电脑运行网页后台、API 和邮件 Agent；学生使用自己的邮箱发送照片，无需访问管理员电脑，也无需登录学生网页。本地版不需要 Linux 服务器、域名、Docker 或 GitHub Pages，但收取邮件时需要联网。

首次使用的最短路线：按第 1～4 节完成安装与启动，再按第 5 节用一个测试学生发邮件、审核并导出。之后日常只需第 6 节的启动命令；正式使用前完成第 8 节的备份与恢复演练。

> 已经安装并有业务数据？请从「6. 日常启动、停止与重启」或「9. 更新项目」开始。不要重复建库、创建管理员，也不要覆盖现有 `.env`。

## 阅读导航

- [1. 安装必需软件](#1-安装必需软件)
- [2. 获取项目并安装依赖](#2-获取项目并安装依赖)
- [3. 准备 MySQL 和收件邮箱](#3-准备-mysql-和收件邮箱)
- [4. 配置并首次启动系统](#4-配置并首次启动系统)
- [5. 完成第一次邮件打卡](#5-完成第一次邮件打卡)
- [6. 日常启动、停止与重启](#6-日常启动停止与重启)
- [7. 维护学生、辅导员与任务名单](#7-维护学生辅导员与任务名单)
- [8. 备份、校验与恢复](#8-备份校验与恢复)
- [9. 更新项目](#9-更新项目)
- [10. 常见问题与报错](#10-常见问题与报错)
- [11. 开发与验证](#11-开发与验证)
- [12. 架构、目录与使用边界](#12-架构目录与使用边界)

## 1. 安装必需软件

| 软件或资源 | 要求 | 用途 |
| --- | --- | --- |
| Windows | 推荐 Windows 10 / 11 | 运行本地管理端 |
| Node.js | 推荐 22 LTS，版本至少 22.12 | 运行项目，随安装附带 npm |
| MySQL Server | MySQL 8.0 | 保存人员、班级、任务、打卡和审核记录 |
| MySQL Workbench | 推荐安装 | 用图形界面建库、执行 SQL、检查数据 |
| Git | 使用 Git 下载、更新时需要 | 获取代码；也可以先下载 ZIP |
| Edge / Chrome | 近期版本 | 使用管理后台 |
| 一个专用收件邮箱 | 支持 IMAP，能够获取授权码或应用密码 | 保存并收取学生打卡邮件 |
| 一个学生测试邮箱 | 与收件邮箱分开 | 验证真实发信、匹配与审核流程 |

软件下载：[Node.js](https://nodejs.org/)、[MySQL Installer](https://dev.mysql.com/downloads/installer/)、[Git for Windows](https://git-scm.com/downloads/win)。请从官方站点安装，不需要额外安装 React、Prisma 或邮件 Agent。

安装 MySQL 时，选择 MySQL Server 8.0 和 Workbench，完成数据库实例配置，记住 `root` 密码。通常端口为 `3306`，建议设为 Windows 服务并自动启动。Workbench 只是管理工具，**只安装 Workbench 并不等于安装了数据库服务器**。

安装后重新打开 PowerShell，检查：

```powershell
node --version
npm.cmd --version
git --version
```

成功标准：能显示版本，Node.js 满足要求。本文使用 `npm.cmd`，以避免 PowerShell 阻止 `npm.ps1` 的执行；不需要为此放宽系统执行策略。

## 2. 获取项目并安装依赖

### 2.1 下载项目

如果项目已经在 `D:\WorkSpace\attendace-bonus`，直接进入它：

```powershell
Set-Location D:\WorkSpace\attendace-bonus
```

如果还没有项目，可以用 Git 下载：

```powershell
New-Item -ItemType Directory -Path D:\WorkSpace -Force
Set-Location D:\WorkSpace
git clone https://github.com/woyao75/attendaace-bonus.git attendace-bonus
Set-Location .\attendace-bonus
```

如果使用 GitHub 的「Code → Download ZIP」，先解压，再进入解压后的项目根目录。项目可以放在其他位置，后文的本地路径应随之调整。

**之后的 PowerShell 命令，除非特别注明，都在项目根目录执行。** 检查当前位置：

```powershell
Get-Location
Test-Path .\package.json
Test-Path .\package-lock.json
Test-Path .\apps\api\package.json
```

后三条都应返回 `True`。不要在 `C:\Users\ASUS` 或仅在 `apps\api` 中执行根目录的安装命令。

### 2.2 安装依赖

```powershell
npm.cmd ci
```

成功标准：命令结束并返回提示符，没有 `npm error`。第一次安装需要下载依赖，耗时取决于网络。

`npm ci` 使用仓库的锁文件安装依赖，不需要另行安装 Vite、Prisma、Nodemailer 等包。Windows 下跳过某些 Linux 专用可选依赖是正常现象。

如果使用 npm 12，且明确报错阻止远程依赖安装，可按提示使用：

```powershell
npm.cmd ci --allow-remote=all
```

这个开关与 npm 版本有关，普通安装不必添加。Prisma 引擎下载失败的处理见「10. 常见问题与报错」。

## 3. 准备 MySQL 和收件邮箱

### 3.1 确认 MySQL 正在运行

在 Windows 的「服务」中找到 MySQL 服务，确认状态为「正在运行」。常见名称为 `MySQL80`，实际名称以本机为准。

也可在 PowerShell 查看：

```powershell
Get-Service -Name '*mysql*'
```

打开 Workbench，连接本机数据库：主机 `127.0.0.1`、端口 `3306`、用户 `root`、密码为安装 MySQL 时设置的密码。能连接后再继续。

### 3.2 创建数据库和专用账号

先在 PowerShell 生成一个随机数据库密码：

```powershell
node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"
```

安全保存输出。这个命令只生成密码，不会创建 MySQL 用户。它生成的十六进制字符也能避免数据库连接 URL 的特殊字符问题。

接下来在 **Workbench 的 SQL 编辑窗口**执行以下 SQL，不是在 PowerShell 中执行。把 `在这里填入刚生成的数据库密码` 替换为刚才的真实输出：

```sql
CREATE DATABASE attendance_bonus
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'attendance'@'127.0.0.1'
  IDENTIFIED BY '在这里填入刚生成的数据库密码';

GRANT ALL PRIVILEGES ON attendance_bonus.*
  TO 'attendance'@'127.0.0.1';
```

这里创建的是数据库用户 `attendance`，**不是网页管理员**。权限仅限本项目数据库；不要把数据库的 `root` 密码直接用于应用。

如果库或账号已经存在，不要先删除它们。跳过已完成的创建步骤，确认原密码和授权；现有账号改密的排查见 P1000 一节。

推荐再建一个 Workbench 连接，用 `attendance` 和刚设置的密码连接 `127.0.0.1:3306`。如果 MySQL 的 `bin` 已加入 PATH，也可以在 PowerShell 测试：

```powershell
mysql -h 127.0.0.1 -P 3306 -u attendance -p attendance_bonus
```

按提示输入密码；密码不应放在命令行里。进入 `mysql>` 后用 `exit` 退出。提示「找不到 mysql 命令」只是客户端未加入 PATH，可先用 Workbench 验证。

### 3.3 准备专用收件邮箱

本系统的 Agent 是项目里的收信程序，邮箱服务商可以是 QQ 邮箱、学校邮箱或其他提供 IMAP 的服务商。建议使用专用归档邮箱，不与个人日常收件箱混用。

以 QQ 邮箱为例：

1. 在网页上登录准备用来收学生邮件的 QQ 邮箱。
2. 在邮箱设置中找到 POP3 / IMAP / SMTP 服务或相关账户安全设置。
3. 开启 IMAP 服务，按提供商要求完成验证并生成授权码。
4. 保存该授权码，后面填入 `IMAP_PASS`。它通常不是 QQ 登录密码。
5. 从另一个邮箱发一封普通测试邮件，确认归档邮箱可以收到。

QQ 邮箱常用 IMAP 参数：主机 `imap.qq.com`，端口 `993`，TLS 开启。学校邮箱和其他服务商请按其官方说明填写，不要照搬 QQ 的主机名。

不要设置规则把打卡邮件自动移出收件箱或标记已读，也不要让另一个客户端自动读掉它们。Agent 只扫描 **INBOX 中主题匹配的未读邮件**。

## 4. 配置并首次启动系统

### 4.1 创建本地配置文件

在项目根目录执行以下命令。已经存在的配置不会被覆盖：

```powershell
if (-not (Test-Path .\apps\api\.env)) {
  Copy-Item .\apps\api\.env.example .\apps\api\.env
}
notepad .\apps\api\.env
```

确保文件名是 `.env`，不是 `.env.txt`。以下是 QQ 收件邮箱下的最小配置示例；**替换所有中文占位值和示例邮箱后才可使用**：

修改模板中已有的同名配置行，缺少的行再添加，确保每个配置名只出现一次。不要在原模板后重复粘贴一套不同值，否则容易误用旧的模式、密码或收件邮箱。

```dotenv
DATABASE_URL="mysql://attendance:刚才设置的数据库密码@127.0.0.1:3306/attendance_bonus?charset=utf8mb4"

LOCAL_EMAIL_MODE=true
HOST="127.0.0.1"
PORT=3000
APP_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
UPLOAD_DIR="./uploads"

IMAP_HOST="imap.qq.com"
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER="你的归档邮箱@qq.com"
IMAP_PASS="归档邮箱的IMAP授权码"
IMAP_PROCESSED_MAILBOX=""

ADMIN_ACCOUNT="admin"
ADMIN_PASSWORD="单独生成并保存的管理员临时密码"
```

为管理员另生成一个随机密码，不要复用数据库密码：

```powershell
node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"
```

将输出填入 `ADMIN_PASSWORD`，安全保存，首次网页登录会用到。

| 参数 | 怎么填 |
| --- | --- |
| `DATABASE_URL` | 数据库用户、密码、主机、端口和库名；必须与建库时一致 |
| `LOCAL_EMAIL_MODE` | 本教程必须为 `true`；示例文件默认是 `false`，务必修改 |
| `HOST` | 保留 `127.0.0.1`，只允许本机访问 |
| `PORT` | 默认 `3000`；改动后访问地址也要改 |
| `APP_ORIGINS` | 允许网页发起请求的来源；逗号分隔，不加空格，不加末尾 `/` |
| `UPLOAD_DIR` | 本地照片存储目录；`./uploads` 相对 `apps/api`，即 `apps/api/uploads` |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` | 收件服务器地址、端口、是否开启 TLS；一般是提供商指定的 `993` 和 `true` |
| `IMAP_USER` | 专用收件邮箱的完整地址，学生发邮件的收件人也是它 |
| `IMAP_PASS` | 提供商的授权码或应用密码，不是学生密码，也不是数据库密码 |
| `IMAP_PROCESSED_MAILBOX` | 空字符串表示处理后标记已读；填现有文件夹名则尝试移入，移动失败回退为标记已读 |
| `ADMIN_ACCOUNT` | 首次创建管理员的登录账号；只用字母、数字、连字符 |
| `ADMIN_PASSWORD` | 首次管理员临时密码，12～128 字符；创建成功后从配置中移除 |

本地直收模式不需要 `SMTP_*`、`MAIL_TARGET`、`MAIL_SIGNING_SECRET`。从示例文件复制来的这些行可以保留，也可以删除；它们用于可选的网页拍照代发模式，不是本教程的依赖。邮箱地址只写纯地址，例如 `archive@qq.com`，不要写 Markdown 链接或 `mailto:`。

如果数据库密码含 `@`、`#`、`%` 等特殊字符，需要在 `DATABASE_URL` 中对**密码部分**做 URL 编码，MySQL 中的真实密码则保持原样。初次配置建议使用上面的随机十六进制密码。

`.env` 包含敏感凭据，不要上传 GitHub、发到群里或截屏公开。若 PowerShell 中曾设置同名 `$env:...` 变量，它可能优先于文件生效；更改后可重新打开一个干净的 PowerShell 窗口再运行。

### 4.2 生成数据库客户端并创建数据表

确认保存 `.env` 后，依次执行，每条成功后再执行下一条：

```powershell
npm.cmd run prisma:generate -w @attendance/api
npm.cmd run db:deploy -w @attendance/api
npm.cmd run doctor -w @attendance/api
```

这三步分别是：生成 Prisma 客户端、把仓库迁移应用到 MySQL、检查配置与数据表。

成功标准：生成成功；迁移没有失败；`doctor` 显示「数据库连接：成功」「新版数据表：可访问」。此时提示「需要运行 admin:create」是正常的。`doctor` 不会连接真实邮箱验证授权码，也不会发送邮件，真实收信仍需后面的测试。

**不要用 `prisma migrate reset` 或 `prisma db push --force-reset` 排错，它们可能清空数据。** 正常安装与升级用 `db:deploy`，不是开发用的 `prisma:migrate`。

### 4.3 创建第一个管理员

```powershell
npm.cmd run admin:create -w @attendance/api
```

看到「管理员已创建」后，重新编辑 `apps/api/.env`，删除 `ADMIN_PASSWORD` 那一行；账号和密码已经写入数据库，删掉这行不会删除管理员。保留临时密码用于首次登录，随后在网页上改成新的密码。

这个脚本只用于创建不存在的账号，**不能用于重置已有管理员密码**。已经成功创建过同名管理员时，无需重复执行。

### 4.4 构建并启动

```powershell
npm.cmd run build
npm.cmd run local:start
```

`build` 成功后会产生前后端构建文件。`local:start` 会启动本地 API，检查数据库就绪，再启动邮件 Agent；它应持续运行，不会自动返回命令提示符。

打开浏览器：[http://127.0.0.1:3000](http://127.0.0.1:3000)。使用配置过的管理员账号和临时密码登录，按提示修改密码，然后用新密码重新登录。

**这个 PowerShell 窗口要保持打开。** 不要同时再运行 `npm run dev`、`npm run local` 或单独启动 worker，否则可能重复收信或占用端口。页面能打开只说明网页服务可用，邮件连接是否成功还要看 Agent 状态和真实收信测试。

## 5. 完成第一次邮件打卡

建议先建立一个只有 1～2 名测试学生的班级，完成收信、驳回重发、通过和导出，确认无误后再录入正式名单。

### 5.1 创建班级与学生

登录管理员，点击顶部「人员与任务管理」。

1. 在「创建班级」中填写名称，例如 `测试班级`，点击「创建」。
2. 在「创建账号」中填写学号、姓名，角色选「学生」，选择刚创建的班级。
3. 「可信学校邮箱」填测试学生**实际用来发信的完整邮箱地址**，不是学校网站、邮箱域名或归档收件邮箱。
4. 填一个独立临时密码，至少 12 字符，点击「创建账号」。

本地模式的学生不需要网页登录，发送邮件也不需要用这个密码。但当前账号创建表单仍要求临时密码，不能留空。每名学生的学号和邮箱必须唯一；正式使用时由学校核实邮箱归属。字段名称虽然是「可信学校邮箱」，当前代码没有强制某个学校域名，测试可以用自己控制的邮箱。

学号 / 登录账号只支持字母、数字和连字符，不支持下划线。姓名应与登记信息一致；用于邮件主题的姓名不要包含下划线。

### 5.2 可选：创建辅导员并分配班级

管理员自己可以完成测试，不必先创建辅导员。实际分工时：

1. 在「创建账号」中填写辅导员登录账号、姓名、独立临时密码，角色选「辅导员」。
2. 在「班级与辅导员」中找到班级，在「添加辅导员账号」里输入刚创建的登录账号，点击「分配」。
3. 辅导员登录后首次改密，再为分配给自己的班级发布任务。

辅导员只能管理自己发布的任务；**管理员发布的任务不会因为班级分配而自动出现在辅导员的任务列表里**。需要谁日常审核，建议就由谁发布对应任务，管理员仍可查看全部任务。

### 5.3 发布任务

在「发布返校任务」中填写：

| 页面字段 | 第一次测试怎么填 |
| --- | --- |
| 任务名称 | 如 `返校打卡流程测试` |
| 开始时间 | 本机当前时间稍早一点，确保发送时已开始 |
| 结束时间 | 当前时间之后，留出足够的发信和驳回重发时间，例如 30 分钟后 |
| 学校中心纬度 / 经度 | 填校园中心坐标；纬度范围 -90～90，经度 -180～180 |
| 允许半径 | 默认 800 米，支持 50～20000 米 |
| 手势图 HTTPS 地址 | 可留空；填写时必须是能访问的 HTTPS 图片地址 |
| 参与班级 | 勾选测试班级，至少一个，班级中必须有启用的学生 |

页面时间按浏览器本地时间输入，请把 Windows 时区与时钟设置正确；中国校区通常使用北京时间。本地邮件模式保留了经纬度、半径字段，但**不会对直接发来的照片执行网页 GPS 围栏校验**。

点击「发布任务」后，系统固定该任务的学生名单、姓名、学号、邮箱和班级，并生成每人独立的验证码。后续录入学生不会自动补进已发布任务。

### 5.4 获取并私发学生邮件主题

发布成功后，管理页会展示「本地直收邮件凭据」。也可以在「查看已发布任务的邮件凭据」中选择任务，点击「查看凭据」。

每位学生的主题格式如下：

```text
[返校打卡] 学号_姓名_任务ID_专属验证码
```

**复制页面生成的整行主题，不要自己编写任务 ID 或验证码。** 验证码是 32 个十六进制字符，每名学生、每个任务独立。仅将对应学生自己的主题私发给本人，不能把全部名单与验证码群发。

可以给学生发送以下说明，先把收件邮箱和完整主题替换好：

```text
请在任务开始后、截止前，使用你登记的邮箱新建邮件：

收件人：辅导员指定的归档邮箱
主题：原样粘贴辅导员私发给你的完整主题
正文：可以留空
附件：一张本人按指定手势拍摄的清晰照片

不要修改主题，不要使用其他邮箱代发，不要转发别人的邮件。
照片请作为附件添加，建议使用 JPG，单张不超过 8MB。
发送成功并不等于审核通过；被驳回后按辅导员要求重新拍摄并新发邮件。
```

正文可不填。如果确实要填写结构化数据，可使用：

```json
{"taskId":"页面中的真实任务ID","studentId":"本人真实学号"}
```

正文中的身份必须与主题一致。学生不要直接复制上述占位 JSON，第一次测试留空最简单。

附件支持 JPEG、PNG、WebP，单张不超过 8MB、图片不超过 2000 万像素，整封邮件不超过 15MB。建议只附一张清晰照片；HEIC、PDF、ZIP 等不能当作打卡照片，手机拍摄的 HEIC 请先转成 JPG。

### 5.5 等待收信并审核

Agent 启动后立即尝试收取邮件，此后每分钟扫描一次，每轮最多处理 50 封。网络延迟、积压或异常重试可能使入库时间更长，不能保证发送后 60 秒内必定显示。

回到「任务审核」，选择刚发布的任务，点击「刷新数据」，确认 Agent 最近成功抓取时间在更新。合法邮件入库后，学生状态应变为「审核中」。点击学生记录打开审核抽屉，检查本人、手势与照片内容，再选择「通过」或填写原因后「驳回」。

本地模式的典型状态是：

```text
未打卡 → 邮件被 Agent 接收并验证 → 审核中 → 已通过
                                      ↓
                                   已驳回
                                      ↓
                         截止前新发照片邮件 → 审核中
```

关键规则：

- 系统按发件邮箱、固定学号、姓名、任务 ID 和专属验证码共同匹配，缺一或不一致都会拒收。
- 时间判断以邮箱服务器的 IMAP 收件时间为准，不以学生填写的正文时间为准。发信应提前，避免恰好卡在截止时刻。
- 截止前已送达、但本机停机尚未处理的邮件，在任务未归档且邮件仍未读时，可于重启后处理；截止后送达的邮件会被拒收。
- 被驳回后，学生在截止前重新拍摄，用同一个有效主题**新建并发送新邮件**。已处理的旧邮件重新标为未读不会产生新的打卡。
- 已在审核中或已通过时，新照片邮件不会覆盖现有记录。驳回通知需辅导员另行告知，当前没有自动发送审核结果邮件。
- 拒收邮件被记录后会标记为已处理，但不一定产生学生打卡记录；「未打卡」不代表一定没有发过邮件。

看板中的「实到人数」只统计审核通过的人数，「未打卡」统计未提交入库的人数。异常 / 驳回学生数与邮件拒收封数是不同指标。

### 5.6 导出材料并归档

进入左侧「材料中心」，选择任务：

- 「导出统计 Excel」包含固定名单里的所有学生，包括未打卡人员，以及班级、时间、状态、驳回原因等；日期标注北京时间。
- 「一键打包照片 ZIP」只包含当前审核通过的照片；文件名包含学号、姓名和记录 ID。缺失照片会写入 ZIP 中的「缺失照片清单.txt」，应排查而不是忽略。

当前任务无需先归档也可以导出。最终归档前，应等待任务结束、截止后的成功邮件扫描、队列清空，并完成全部待审核记录。再点击「归档任务」；归档后不能继续审核或接受新打卡。

第一次测试的成功标准：学生合法邮件进入审核中，审核通过后实到人数增加，Excel 有对应记录，ZIP 能打开对应照片。至少再验证一封发件邮箱错误的邮件被拒收，以及一次「驳回 → 截止前新发邮件 → 通过」的流程。

## 6. 日常启动、停止与重启

### 6.1 每天或重新开机后启动

确认 MySQL 服务运行，打开 PowerShell：

```powershell
Set-Location D:\WorkSpace\attendace-bonus
npm.cmd run local:start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，保持命令窗口打开、电脑不休眠，收信时保持联网。没有更新代码或依赖时，不必每天重新 `npm ci`、迁移或创建管理员。

项目目前没有安装开机自动运行服务。MySQL 自动启动不代表 API 和 Agent 也自动启动。

### 6.2 正常停止

在运行 `local:start` 的窗口按 `Ctrl+C`。如果 Windows 询问是否终止批处理，输入 `Y`。不要在其他窗口输入 `Ctrl+C` 期待停止这个进程，也不要直接结束所有 `node.exe`。

可以检查默认网页端口是否已经停止监听：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

没有输出表示该端口已停止监听；如果修改过 `PORT`，改成对应端口。备份前还需确认没有单独启动的 worker。

### 6.3 关闭电脑后哪些数据还在

| 内容 | 保留位置 / 重启后行为 |
| --- | --- |
| 人员、班级、任务、状态、审核和日志 | 保存在 MySQL，不因关闭 Node 进程而清空 |
| 学生照片 | 默认在 `apps/api/uploads`，需要和数据库一起备份 |
| 配置与授权码 | 保存在 `apps/api/.env`，需要单独安全保管 |
| 原始邮件 | 保存在邮箱服务器，是否长期保留取决于邮箱规则与容量 |
| 本地备份 | 在根目录 `backups`，重启不会自动删除 |
| API、Agent、定时收信 | 停止运行，需要重新 `local:start` |
| 登录会话 | 受会话有效期影响，可能需要重新登录 |

管理员电脑关机期间，学生仍可发邮件到邮箱服务器，但后台不会实时更新。开机后保留原邮件在 INBOX 未读状态，让 Agent 补扫。已归档任务不再接受补扫入库。

`127.0.0.1` 指当前电脑，不是可供学生远程访问的网址；学生使用邮件流程，不需要打开这个网址。

## 7. 维护学生、辅导员与任务名单

### 7.1 批量导入学生

管理员在「人员与任务管理 → 批量导入学生」中选择班级，上传 UTF-8 CSV。表头必须为：

```csv
studentId,name,email,password
20260001,张三,学生一的真实发件邮箱,为学生一单独生成的临时密码
20260002,李四,学生二的真实发件邮箱,为学生二单独生成的临时密码
```

以上只是格式示例，不可原样导入。把邮箱和密码改成真实有效值，每人密码至少 12 字符。可以在 Excel 中建立这四列，再「另存为 → CSV UTF-8」。学号列预先设为文本，避免前导零丢失或变成科学计数法。

每批最多 100 人，文件大小最多 128KB。导入用于**新建**学生，不会更新已有学生；批内或数据库中重复学号、邮箱会导致失败。CSV 含明文临时密码，请限制访问，导入完成后按学校安全要求处置。

### 7.2 修改与停用

使用管理员账号在「账号列表」搜索人员，可以修改邮箱、给学生调班、重置临时密码或停用 / 启用账号。辅导员名单通过新增辅导员账号和分配班级维护，离职账号建议停用而非直接删除数据库记录。

注意已发布任务采用固定名单：

- 新增学生、调班、修改账号邮箱，不会自动改变已经发布的任务名单与成员邮箱。
- 修改某次任务的邮箱，需在该任务的邮件凭据区域点击「更新邮箱并轮换验证码」，再私发新主题；旧主题立即失效。
- 邮箱更正或验证码轮换只允许任务尚未结束、未归档，且该学生还未有效提交、或处于驳回 / 邮件异常状态时操作。
- 停用学生会阻止该学生继续向当前任务提交邮件，不只是禁止网页登录。
- 清空班级辅导员分配不会转移旧任务负责人；管理员仍可处理原辅导员的任务。

当前界面不提供直接修改姓名 / 学号 / 角色、删除历史账号、给已发布任务增删成员或转移任务负责人。发现正式名单错误时，优先在发布前更正；已发布任务不能靠直接改 MySQL 来临时绕过规则，必要时发布新任务并明确告知学生。

## 8. 备份、校验与恢复

**导出的 Excel / ZIP 不等于系统备份。** 可恢复的备份必须包含数据库和照片，且另外保管环境配置与凭据。

### 8.1 检查备份工具

```powershell
npm.cmd run backup:local -- --check
```

备份脚本需要 MySQL 的 `mysqldump` 和 Windows 的 `tar`。如果找不到 `mysqldump`，在 `apps/api/.env` 增加其实际完整路径，例如：

```dotenv
MYSQLDUMP_PATH="C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe"
```

先在资源管理器确认文件存在，安装位置不同就调整路径。`--check` 只检查配置、照片目录和工具可用性，不会生成备份，也不能代替实际数据库导出测试。

### 8.2 停机后备份

1. 正常停止 `local:start`，确认没有其他 API / worker 在运行。
2. 保持 MySQL 运行；等待 90 秒，让 Agent 的旧心跳过期。
3. 在项目根目录执行：

```powershell
npm.cmd run backup:local -- --stopped
```

**是 `--stopped`，不是 `--stoped`。** 备份只支持本机 MySQL。端口仍活跃或心跳过新时脚本会拒绝运行，按提示检查，不要绕过。

成功后会输出一个备份目录，并生成：

```text
backups/
  local-时间-随机标识/
    database.sql
    photos.tar.gz
    manifest.json
```

脚本不会覆盖旧备份；失败后残留的目录不应当作有效备份。备份期间不要重新启动 API 或 Agent，以免数据库和照片不一致。

### 8.3 校验备份并保存到另一处

可以将命令输出的完整目录传给 `backup:verify`。为避免误把「实际目录名」当作文件夹，下面直接选择最新一个有清单的备份目录：

```powershell
$backupDirectory = Get-ChildItem .\backups -Directory -Filter 'local-*' |
  Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($null -eq $backupDirectory) { throw '没有找到带清单的备份目录' }
npm.cmd run backup:verify -- "$($backupDirectory.FullName)"
```

看到 `Backup checksum verified`，表示 SQL 和照片压缩包的 SHA-256 与清单一致，且文件非空。**这不表示已经验证 SQL 可以恢复、照片完整或业务一定可用。** 还应做隔离恢复演练。

校验成功后，把整个备份目录复制到受访问控制的加密移动盘或其他独立存储。`.env` 不包含在备份中，数据库密码、邮箱授权码、管理员账号信息应另行安全保存。数据库备份本身含学生信息与任务验证码，也属于敏感资料。

复制与校验完成后，可重新执行 `npm.cmd run local:start` 恢复日常使用。

### 8.4 隔离恢复演练

首次正式使用前，至少验证一次恢复。**不要在正式业务库中练习，也不要覆盖当前 `uploads`。**

1. 先对选定备份运行 `backup:verify`。
2. 在 Workbench 用有建库权限的账号创建一个新的空库，例如 `attendance_restore_test`，字符集仍为 `utf8mb4`。
3. 在 Workbench 的「Server → Data Import」选择该备份的 `database.sql` 自包含文件，确认默认目标库是新建的演练库，再导入。不要选正式库 `attendance_bonus`。
4. 也可用 MySQL 客户端连接演练库，执行 `SOURCE 完整SQL文件路径;`。路径换成真实备份路径，Windows 下建议使用 `/`；`SOURCE` 是 MySQL 客户端命令，不是 PowerShell 命令。
5. 使用 `tar -tzf` 检查照片包内容，再将它解压到一个新的演练目录。默认包中含 `uploads` 目录，不能解压覆盖正式文件。
6. 比对演练库中的 `User`、`Task`、`TaskMember`、`CheckIn` 数量和抽样审核状态，检查照片文件是否存在并能打开。
7. 需要进一步验证页面、Excel 和 ZIP 时，使用独立项目副本、演练库和演练照片目录。**不要直接启动第二个 `local:start` 连接正式收件邮箱**；它会自动收信。可在副本中配置测试邮箱和不同端口，或仅启动 API，绝不启动正式邮箱 worker。

实际灾难恢复还应核对程序版本、配置与照片路径，并在确认恢复成功前保留原数据和备份。更完整的运维说明见 [部署手册](docs/DEPLOYMENT.md)。

## 9. 更新项目

更新前先完成上一节的停机备份与校验。使用 Git 获取项目时，可以按以下顺序操作：

```powershell
git status --short
git pull --ff-only
npm.cmd ci
npm.cmd run prisma:generate -w @attendance/api
npm.cmd run db:deploy -w @attendance/api
npm.cmd run doctor -w @attendance/api
npm.cmd run build
npm.cmd run local:start
```

每条命令成功后再继续。若 `git status` 显示本地修改，先保存并处理它们，不要用强制重置覆盖。若 Git 拒绝快进合并，先检查分支差异，不要直接强推或清空目录。

使用 ZIP 下载更新时，也必须保留旧数据、配置和可用备份；不要把整个旧项目删除后再想起照片只存在 `uploads`。

`.env`、`uploads` 和 `backups` 已在 Git 忽略规则中，但这不保证手工覆盖文件夹时不会丢失它们。升级不需要重新 `admin:create`。

## 10. 常见问题与报错

### `npm ci` 报 EUSAGE，找不到锁文件

先检查当前目录，必须同时存在根目录 `package.json` 和 `package-lock.json`。如果命令提示符是 `PS C:\Users\ASUS>`，先 `Set-Location` 到项目根目录。如果下载的项目没有锁文件，重新获取完整仓库；不要为排错随意删除仓库锁文件。

### PowerShell 提示不能运行 `npm.ps1`

用本文的 `npm.cmd` 代替 `npm`。不需要关闭系统安全策略。

### Prisma 引擎或校验文件下载失败

这是网络下载问题，不是 MySQL 登录失败。可先在当前 PowerShell 中设置镜像后重试失败的安装或生成步骤：

```powershell
$env:PRISMA_ENGINES_MIRROR = 'https://registry.npmmirror.com/-/binary/prisma'
npm.cmd run prisma:generate -w @attendance/api
```

如果失败的是 `npm ci`，设置变量后重新执行 `npm.cmd ci`。也可在 `apps/api/.env` 加入同名配置供后续 Prisma 命令使用。镜像是第三方服务，需确认网络可达；不要通过关闭 TLS 证书验证解决下载问题。

### P1000：数据库认证失败

依次核对 `DATABASE_URL` 的用户名、密码、端口、库名以及 `127.0.0.1`，并用 Workbench 或 `mysql ... -p` 直接验证同一账号。`attendance` 密码必须与创建数据库账号时一致，不是 `root` 密码或管理员登录密码。

如果需要修正数据库账号密码，先在 Workbench 用管理员权限确认该账号存在，再执行：

```sql
ALTER USER 'attendance'@'127.0.0.1'
  IDENTIFIED BY '新生成的数据库密码';
```

随后同步修改 `.env`，再重跑失败的 `db:deploy`。不要删除库或迁移来解决认证问题。特殊字符密码需按前文编码，`'attendance'@'localhost'` 与 `'attendance'@'127.0.0.1'` 的账号和授权也应核实。

### P1001：无法连接数据库

检查 MySQL 服务是否运行，主机与端口是否正确。Workbench 连接也失败时，先解决数据库本身，不要反复修改 Prisma Schema。

### P3018：迁移执行失败

这代表某个迁移未完成，**必须查看完整数据库错误和迁移名称**。已有业务数据时先保留备份，再检查权限、现有表结构和迁移记录；不要盲目 `migrate reset`，也不要不核实结构就标记 `--applied`。仅有 P3018 这一行无法确定修复 SQL。

### 创建管理员提示「密码至少 12 位」或「账号已存在」

把 `ADMIN_PASSWORD` 改为 12～128 字符的真实临时密码后重新运行。若账号已存在，说明不能通过该脚本覆盖它；已有账号用原密码登录，其他账号密码由管理员在后台重置。为防止丢失唯一管理员入口，正式使用前安全保管管理员凭据。

### `local:start` 提示模式错误或缺少构建产物

确认 `.env` 的 `LOCAL_EMAIL_MODE=true`，并运行 `npm.cmd run build`。`.env.example` 默认是 `false`，仅复制而不修改无法使用本教程的启动方式。

### 端口被占用 / EADDRINUSE

检查是否已经开了另一个运行窗口，先正常停止旧实例。用 `Get-NetTCPConnection` 查询对应端口和 `OwningProcess`，核实进程后处理，不要直接终止所有 Node 进程。如果改 `PORT`，相应访问地址也要修改。

### 网页没变化、访问 5173 没反应、提示缺少 taskId / userId

日常使用 `local:start` 的地址是 **3000**，不是 Vite 开发端口 5173。代码更新后需要重新构建并重启，浏览器再刷新；仍是旧页面时，检查是否访问了另一份项目或旧版 PWA，可在浏览器开发者工具中注销本站旧 Service Worker，再重新打开页面。

当前版本从登录页进入任务列表，不需要手工拼接 `taskId` / `userId`。本地邮件流程中学生无需访问拍照网页。

### 邮件收到了，后台仍然是未打卡

按以下顺序检查：

1. `local:start` 窗口仍在运行，电脑联网且没有休眠，MySQL 服务正常。
2. 后台选中了正确任务，点过「刷新数据」，Agent 最近成功时间在更新。
3. 邮件在 `IMAP_USER` 的 INBOX 中且未读，没有被规则、其他客户端提前读掉或移走。
4. 邮件主题完整，发件人是本任务登记邮箱，学生在固定名单里且账号启用，验证码未轮换。
5. 收件时间处于任务开始与结束之间，任务未归档，附件格式、大小和像素数符合要求。
6. IMAP 主机、端口、TLS、授权码有效。QQ 等邮箱授权码与登录密码不同，重新生成后要更新配置并重启。

队列较长时多等几轮扫描。格式不匹配主题前缀的邮件可能根本不会被扫描；已被拒收并记录的旧邮件，仅标回未读不会修正打卡。纠正原因后，新建并发送新邮件；若已截止，联系管理员，不要擅自更改系统时间或数据绕过规则。

### 归档失败

检查是否已到结束时间、是否仍有审核中记录、Agent 是否报错 / 正在扫描、队列是否清空，以及截止后是否完成成功扫描。归档保护是为了避免漏掉已送达邮件，不应绕过。

### 备份报错或 `--stoped` 不识别

正确参数是 `--stopped`。先检查工具，正常停止 API 和 worker 并等待 90 秒。`--check` 成功不代表备份已生成；校验时选择带清单的真实目录，不能照抄 `local-实际目录名`。

### Git 提示 LF 将替换成 CRLF

这是换行符提示，不是提交失败。它与数据库、邮件服务没有关系；不要为此改动全部文件。

## 11. 开发与验证

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm.cmd ci` | 按锁文件安装依赖 |
| `npm.cmd run prisma:generate -w @attendance/api` | 生成 Prisma 客户端 |
| `npm.cmd run db:deploy -w @attendance/api` | 应用正式数据库迁移 |
| `npm.cmd run doctor -w @attendance/api` | 检查配置和数据库，不显示凭据 |
| `npm.cmd run admin:create -w @attendance/api` | 首次创建管理员，不覆盖旧账号 |
| `npm.cmd run build` | 构建前后端 |
| `npm.cmd run local:start` | 日常运行本地版，默认 3000 |
| `npm.cmd run dev` | 开发模式，同时启动 API、Vite 和 worker；网页默认 5173 |
| `npm.cmd run local` | 开发模式别名，不是日常构建版入口 |
| `npm.cmd run lint` | TypeScript 静态检查 |
| `npm.cmd test` | 后端测试 |
| `npm.cmd run backup:local -- --check` | 检查本地备份前置条件 |
| `npm.cmd run backup:local -- --stopped` | 停机后备份数据库和照片 |
| `npm.cmd run backup:verify -- "备份完整路径"` | 校验一个已有备份，路径需替换 |

开发时先停止日常运行实例，再启动开发模式。不要同时运行两套邮件 worker。开发模式也会使用 `.env` 中的数据库和邮箱，修改与试验应使用专用测试环境。

### 自动测试与人工验收

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd test
```

未配置 `TEST_DATABASE_URL` 时，真实数据库集成测试会跳过。要执行该组测试，需预先创建并迁移**独立的本机测试库**，库名以 `attendance_test` 开头，再设置测试连接；不能指向正式业务库。具体说明见 [部署手册](docs/DEPLOYMENT.md)。

另有 `test:browser`、`test:upgrade`、`test:pwa`：分别验证浏览器流程、旧库升级和 PWA 行为；升级测试还需要测试账号具有创建测试库权限。Windows 浏览器测试使用本机 Edge，浏览器测试中的模拟摄像头不能替代真机验收。

GitHub Actions 通过只证明对应自动检查通过，不会为你部署或启动本地系统，也不能代替真实邮箱收发、权限分工和恢复演练。首次正式使用前，应完成：

- 专用测试学生的合法、错误邮箱、重复、超时邮件与驳回重发验收。
- 不同辅导员和班级的任务访问权限检查。
- Excel 与照片 ZIP 内容检查，重启后记录和照片仍可访问。
- 数据库加照片备份，并在独立环境中验证恢复。
- 学校确认隐私告知、保存期限、备份权限及误判申诉流程。

## 12. 架构、目录与使用边界

### 数据流程与技术栈

```text
学生邮箱 → 专用收件邮箱 → 本机 IMAP Agent → MySQL 记录 + 本地照片
                                                   ↓
                                      管理后台审核 → Excel / ZIP
```

前端使用 React、Vite、TypeScript、TailwindCSS 和 Zustand，提供 PWA 页面；后端使用 Node.js、Express、Prisma 和 MySQL 8.0。收信使用 imapflow / mailparser 和 node-cron，材料导出使用 exceljs / jszip。Nodemailer 用于可选的非本地直收代发模式。

MySQL 存的是业务记录，照片另存磁盘，原始邮件存邮箱；只保存其中一个不能完整恢复系统。当前不是 SQLite 版，也不是完全脱离数据库的纯网页 Demo。

### 项目目录

```text
attendace-bonus/
  apps/
    api/
      .env.example            配置模板，不是真实凭据
      .env                    本机配置，不提交 Git
      prisma/                 MySQL Schema 与版本迁移
      src/                    API、权限、邮件 Agent、导出逻辑
      uploads/                运行后产生的照片与 Agent 心跳
      dist/                   构建后的后端
    web/
      src/                    登录、管理、审核与拍照页面
      public/                 PWA 静态资源
      dist/                   构建后的网页
  scripts/                    本地启动、备份与测试脚本
  backups/                    本地备份，不提交 Git
  docs/                       部署与交付说明
  deploy/                     可选服务器部署配置
  compose.yaml                可选 Docker Compose
  Dockerfile                  可选容器构建
  package.json                根目录命令与 workspace 定义
  package-lock.json           依赖锁文件，应保留并提交 Git
```

### 当前边界

本地直收模式接收学生自己拍摄并发送的图片，不强制使用网页摄像头、不自动加 Canvas 水印，也没有可信 GPS 或拍摄时间证明。网页拍照、GPS 围栏和 SMTP 代发属于另一种工作模式，不能把那些限制当作直收邮件的安全保证。

邮件的 `From` 地址可能被伪造，专属验证码只降低误匹配与冒用风险，不等于学校统一身份认证。当前没有人脸 / 活体或自动手势识别，实际有效打卡需人工审核；涉及处分等高风险结论时须有复核与申诉机制。

PWA 可缓存页面壳，但不会让离线时继续收邮件、审核或同步业务数据。完整的 Web Push 订阅与主动推送、OSS、逆地理编码、学校统一认证不是默认启用功能。

本地模式只面向本机访问，请勿直接开放数据库端口或把本地 API 端口转发到互联网。GitHub Pages 只能托管静态网页，不能运行本项目的 MySQL、API 和邮件 Agent；需要多人远程管理时应重新规划服务器、HTTPS 和安全运维方案。

照片保存期限与删除仍需学校制定。新版重打卡会尝试删除被替换的本地照片，但已归档照片和旧版遗留文件不会自动清理；不要直接删除整个 `uploads`。

进一步阅读：[部署与运维手册](docs/DEPLOYMENT.md)、[交付记录与验收项](docs/HANDOFF.md)。其中 Linux、Docker 和公网章节是可选扩展，**不属于本教程的本地使用前置条件**。
