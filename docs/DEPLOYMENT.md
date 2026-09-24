# 从本地到试运行

> 当前项目目标是单机本地版。你不需要 Linux 服务器、域名、Docker 或公网 HTTPS。管理员电脑安装 MySQL 8.0，运行 API、IMAP Agent 和 A 端即可。

## 当前推荐：单机本地运行

管理员电脑需要安装 Node.js 22.12+、MySQL 8.0，并准备一个可通过 IMAP 读取的归档邮箱。学生直接向该邮箱发送打卡邮件，A 端只在管理员电脑的 `http://localhost:5173` 打开。

本轮交付包含账号登录、角色与任务范围校验、班级/学生管理、固定任务名单、签名邮件队列、受保护照片、PWA 和部署配置。它是可部署并进行验收的版本，不等同于已经在学校真实网络和邮箱上验收通过。

## 可选：公网部署才需要的内容

1. 一台 Linux 服务器（建议至少 2 核 4GB），安装 Docker Engine 和 Compose 插件。
2. 一个域名，将 A 记录指向服务器。开放 80/443，SSH 仅允许管理来源。数据库 3306、API 3000 不需要开放。
3. 专用 SMTP 发件账号和 IMAP 归档邮箱，开启授权码。MAIL_TARGET 必须是 IMAP 实际读取的邮箱。当前支持一个归档邮箱。
4. 学生名单、辅导员名单、班级对应关系、学校围栏中心坐标和半径。浏览器定位采用 WGS84，不能直接照搬 GCJ-02 地图坐标。
5. 确定学校允许的照片/定位保存期限、管理人员和备份存储位置。

## 先在本地验证

本地直收邮箱模式只需要数据库和 IMAP：设置 `LOCAL_EMAIL_MODE=true`、填写 `IMAP_HOST`、`IMAP_USER`、`IMAP_PASS`。SMTP、MAIL_TARGET 和 MAIL_SIGNING_SECRET 在该模式下不需要。

本地版默认只监听 `127.0.0.1`，避免把后台暴露到校园网。不要把 `HOST` 改为 `0.0.0.0`，除非已经明确配置受信任网络访问和防火墙规则。

要求 Node.js 22.12+、MySQL 8.0。已存在 apps/api/.env 时直接编辑，不要覆盖已有凭据。

```powershell
npm ci
# 仅在 .env 不存在时复制：
Copy-Item apps/api/.env.example apps/api/.env
# 若 Prisma 引擎下载超时，在 apps/api/.env 添加：
# PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
npm run prisma:generate -w @attendance/api
```

先填好 DATABASE_URL、MAIL_TARGET、MAIL_SIGNING_SECRET、SMTP/IMAP 参数。MAIL_SIGNING_SECRET 使用至少 32 字符的随机值，API 与 worker 必须相同。可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 在本机生成，勿发到群聊或提交 Git。

MySQL 尚无数据库时，由 root 在 MySQL 客户端执行（更换密码）：

```sql
CREATE DATABASE attendance_bonus CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'attendance'@'127.0.0.1' IDENTIFIED BY '替换为你自己的密码';
GRANT ALL PRIVILEGES ON attendance_bonus.* TO 'attendance'@'127.0.0.1';
```

使用 `db:deploy` 应用已审阅的迁移，不需要 shadow database 权限。不要在生产运行 `migrate dev`、`migrate reset` 或 `db push --accept-data-loss`。

配置和数据库准备好后执行下面的命令；已有业务数据库必须先完成备份，再升级：

```powershell
npm run db:deploy -w @attendance/api
npm run doctor -w @attendance/api
```

`doctor` 只读检查配置、数据库连接、新版数据表和管理员是否存在，不显示密码或授权码，也不发送邮件。首次尚无管理员时，继续下面的初始化步骤。

临时在 apps/api/.env 设置 ADMIN_ACCOUNT 与 ADMIN_PASSWORD（至少 12 位），运行：

```powershell
npm run admin:create -w @attendance/api
npm run dev
```

初始化脚本只创建账号，不覆盖已有账号。成功后删除 ADMIN_PASSWORD 配置。打开 http://localhost:5173 登录，首次修改密码。开发模式会同时启动 API、Web、worker。

## 旧数据库升级

迁移保留原有数据，把旧 role 转为枚举，旧班级字符串转为班级记录，为历史任务固定原先“全部学生”的名单。历史任务发布人未知，默认仅管理员可管理，需人工确认是否要分配负责人；本轮不猜测负责人。

旧账号没有密码，管理员登录后在“人员与任务管理”中重置。旧打卡邮件没有签名，不会被新版 Agent 自动采信；已通过记录保留，旧的待邮件/待审核记录需管理员核实。真实库升级前先备份，迁移为 MySQL DDL，不依赖事务回滚整个迁移。

## 可选：Linux 服务器部署

把项目放到服务器目录，复制 `.env.production.example` 为 `.env.production` 并逐项替换示例值。DOMAIN 只填域名，不带 https://。两个数据库密码使用不同的随机字母数字；如使用其他字符，必须按 URL 规则编码 DATABASE_URL，当前 Compose 模板建议直接用随机十六进制密码。

```bash
chmod 600 .env.production
docker compose --env-file .env.production build
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps
docker compose --env-file .env.production run --rm --no-deps api node dist/bootstrap-admin.js
```

确认管理员建立后，删除 `.env.production` 中 ADMIN_PASSWORD 行，重新运行 `up -d` 使容器移除该变量。Caddy 自动签发 HTTPS 证书，需要正确 DNS 和可访问的 80/443。

部署架构：Caddy 提供前端和 HTTPS，转发 `/api`；API 使用 MySQL 保存数据，worker 每分钟处理待发送队列和 IMAP；照片存于持久卷。API 与 worker 共用照片卷。**worker 仅支持一个副本**，不要运行第二个实例处理同一数据库/邮箱；API 限流也是单实例设计，本模板只部署一个 API。

查看运行状态：

```bash
docker compose --env-file .env.production logs --tail=100 api worker
curl --fail https://你的域名/ready
```

`/health` 检查进程，`/ready` 检查数据库。后台显示 worker 最近成功抓取时间及错误。容器 unhealthy 仅提供状态，Docker 不会因此自动重启：需要配置外部告警（例如 Uptime Kuma 检查 /ready），并关注邮件心跳。容器退出时 restart 策略会自动重启。

## 管理员首次操作

1. 登录并修改初始密码。
2. 在“人员与任务管理”创建班级、辅导员账号，将辅导员账号分配给班级。
3. 创建学生账号或导入 UTF-8 CSV：`studentId,name,email,password`；每批最多 100 人，密码至少 12 位，每名学生使用不同临时密码。本地直收模式必须填写学生可信学校邮箱。Excel 中学号列应设为文本以保留前导零。
4. 辅导员登录并修改密码，选择自己管理的班级发布任务；目标邮箱由服务端固定。
5. 学生登录后看到自己的任务，无需再填写 taskId/userId。
6. 学生提交后状态为 EMAIL_PENDING；最多自动重试 SMTP 5 次。发送成功 → EMAIL_SENT；签名/照片摘要校验通过 → REVIEWING；辅导员审核后 → APPROVED/REJECTED。失败或驳回可在任务时间内重拍。
7. 任务结束且无待发送/待收件/待审核记录后归档，材料中心可以下载统计与照片。

worker 每分钟按开始/结束时间推进任务状态；提交接口始终直接校验时间窗口，不依赖定时任务是否准时执行。

权限规则：学生只访问自己的记录；辅导员只创建所管班级任务，并管理自己发布的任务；管理员可管理全部任务。撤销班级分配影响新任务发布，不改变既有任务负责人；辅导员离职时先停用账号，由管理员管理其历史任务。

## 备份与恢复

服务器执行 `bash scripts/backup.sh` 会短暂停止 API/worker，导出数据库并打包照片，随后恢复服务。结果在 `backups/UTC时间/`，包含 SHA256 校验文件。每天在低峰执行，复制到加密的异地存储。备份包含学生照片和个人信息，应限制访问。不要仅依赖同一块服务器磁盘。

恢复演练必须在另一套隔离环境：

1. 使用独立目录、独立域名和 Compose project name 建立空实例，避免连到正式数据卷。
2. 停止新环境 API/worker，校验备份 SHA256，使用 MySQL 客户端导入 `database.sql`，把照片解压到新环境 photos 卷并恢复 node 用户的写权限。
3. 使用与备份匹配的 MAIL_SIGNING_SECRET，避免启用真实 SMTP/IMAP 误发历史邮件。启动 API 验证人数、审核状态、照片和导出。
4. 记录恢复用时。确认恢复可用前，不要认为“有备份”就足够。

程序更新先备份，再构建和 `up -d`，查看 migrate 服务结果与 /ready。数据库版本向后不兼容时，不能仅回滚镜像；应在隔离环境确认匹配的数据库及照片备份后制定恢复方案。禁止用 `docker compose down -v` 更新，它会删除持久化卷。

## 真实使用前的人工验收

- Android Chrome、iPhone Safari/PWA：HTTPS、相机授权、后置镜头、定位拒绝/恢复、拍照水印、重拍、任务倒计时、页面退后台后恢复。
- 专用 SMTP/IMAP：实际发送一张测试照片，等待 Agent 入库，确认附件、水印、审核和导出；再断开邮箱连接检查重试和错误提示。
- 使用两个班级和不同角色验证看不到他人照片和未授权任务。
- 恢复备份、重启服务器、网络中断后重新访问。
- 确认照片保留期限及删除流程。当前保留历史照片与发送队列，未自动删除，避免在期限未确定时误删资料。

Canvas 水印、GPS 是人工审核辅助，不能证明客户端未被篡改；本版本未实现人脸/活体或手势自动识别。Web Push 目前保留安全通知处理器，完整订阅/VAPID 和主动推送未启用。逆地理编码、OSS、学校统一认证不是本次默认部署的依赖。

## 单机直收邮箱模式

若不部署公网服务器，在 `apps/api/.env` 设置 `LOCAL_EMAIL_MODE=true`，只配置 IMAP_HOST、IMAP_USER 和 IMAP_PASS。学生直接发邮件到 IMAP_USER：

```text
主题：[返校打卡] 学号_姓名_任务ID_专属验证码
正文：{"taskId":"任务ID","studentId":"学号","time":"2026-09-23T18:30:00+08:00"}
附件：JPG、PNG 或 WebP 照片
```

管理员电脑运行 `npm run local`，A 端地址为 `http://localhost:5173`。Agent 每分钟抓取未读邮件，按学号和任务 ID、固定姓名、预登记发件邮箱及专属验证码匹配固定任务名单，写入审核中记录并保存照片。发布后在管理页逐一私发每名学生的主题；验证码不能群发或复用。拒绝邮件会被记录并标记处理，不会每分钟重复抓取。此模式不需要 SMTP 代发或邮件签名；它不能证明 GPS、拍摄时间或邮件内容未被修改，应结合人工审核使用。

迁移后的历史任务没有专属验证码，直收邮件会被安全拒绝。对尚未开始的旧任务，请重新发布以生成新的成员快照和验证码；不要手工给旧任务补写验证码。

## 自动验证

```powershell
npm run lint
npm run build
npm test
# 新建独立数据库 attendance_test，并迁移后设置：
$env:TEST_DATABASE_URL='mysql://测试用户:测试密码@127.0.0.1:3306/attendance_test'
npm test
npm run test:browser
npm run test:upgrade
npm run test:pwa
```

没有 TEST_DATABASE_URL 时跳过集成测试，并不会验证真实库。集成测试只允许本机且库名以 attendance_test 开头，创建带随机标识的测试数据，不清空数据库；请使用专用测试库。浏览器测试在 Windows 使用本机 Edge，Linux 需先 `npx playwright install --with-deps chromium`。浏览器测试使用模拟摄像头，不能替代真机验收。

`test:upgrade` 额外创建独立的旧版测试库，验证升级保留历史记录，需要测试用户拥有创建测试数据库的权限；`test:pwa` 使用最近一次构建的前端产物，验证离线导航和私密内容不缓存。
