# 从本地到试运行

> 当前项目目标是单机本地版。你不需要 Linux 服务器、域名、Docker 或公网 HTTPS。管理员电脑安装 MySQL 8.0，运行 API、IMAP Agent 和 A 端即可。

## 当前推荐：单机本地运行

管理员电脑需要安装 Node.js 22.12+、MySQL 8.0，并准备一个可通过 IMAP 读取的归档邮箱。学生直接向该邮箱发送打卡邮件；日常 A 端只在管理员电脑的 `http://127.0.0.1:3000` 打开，`5173` 是开发调试端口。

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
5. 本地直收模式下，学生无需登录网页，直接按私发的专属主题发邮件；网页拍照提交仅适用于非本地直收模式。
6. 非本地直收模式下，网页提交后状态为 EMAIL_PENDING；最多自动重试 SMTP 5 次。发送成功 → EMAIL_SENT；签名/照片摘要校验通过 → REVIEWING；辅导员审核后 → APPROVED/REJECTED。失败或驳回可在任务时间内重拍。本地直收模式下，邮件入库后直接进入 REVIEWING。
7. 任务结束且无待发送/待收件/待审核记录后归档，材料中心可以下载统计与照片。

worker 每分钟按开始/结束时间推进任务状态；提交接口始终直接校验时间窗口，不依赖定时任务是否准时执行。

权限规则：学生只访问自己的记录；辅导员只创建所管班级任务，并管理自己发布的任务；管理员可管理全部任务。撤销班级分配影响新任务发布，不改变既有任务负责人；辅导员离职时先停用账号，由管理员管理其历史任务。

## 日常维护辅导员与学生名单

在管理员电脑运行 `npm.cmd run local:start`，打开 `http://127.0.0.1:3000`，用管理员账号登录“人员与任务管理”。修改大量名单前，先按下文完成备份。辅导员可查看所管班级的学生，但创建和修改账号、班级分配需要管理员权限。

1. **新增辅导员**：在“创建账号”选择“辅导员”，设置账号和至少 12 位的临时密码；然后在“班级与辅导员”输入该账号，为相应班级点击“分配”。辅导员首次登录后应修改密码。
2. **调整辅导员**：可继续给班级添加辅导员，或用“清空分配”移除该班级的**全部**辅导员。当前页面不能只移除其中一位；不要为了移除一人而误清空其他人的分配。离职时停用其账号。班级分配变化只影响之后的任务发布，已有任务仍归原发布人管理；管理员可管理这些历史任务。
3. **新增学生**：单个使用“创建账号”，或按班级批量导入 UTF-8 CSV，表头必须为 `studentId,name,email,password`，每批最多 100 人。CSV 只新增账号，不会更新已有学生；本地直收模式必须登记发件邮箱。系统只验证邮箱格式，管理员须自行核对是否确属该学生的可信学校邮箱。
4. **调整学生**：在人员列表搜索姓名、学号或邮箱，对已有学生使用“调班”“更新邮箱”“重置密码”或“停用账号”。重置密码后该账号原会话失效，下次登录需修改临时密码。停用学生会阻止其当前任务的邮件继续入库，操作前先核对未结束的任务；不要直接修改数据库或删除重建账号。

任务发布时会固定成员的学号、姓名、班级和邮箱。之后调班、新增学生或修改账号邮箱，**不会自动修改已发布任务的名单**。本地直收模式如需修改某个既有任务的发件邮箱，在该任务的“本地直收邮件凭据”中单独更新；系统会轮换其专属验证码，旧主题立即失效，须把新主题私发给该学生。已发布任务目前不能直接增删成员；名单有误时应核对已收到的邮件和审核状态，必要时发布新任务。

当前页面也不支持修改既有账号的姓名、学号、角色，或删除账号。此类历史身份信息不能通过 CSV 覆盖或直接改 MySQL；确需更正时，应先确认受影响的已发布任务及历史记录，再增加受审计的更正流程。

## 可选：Linux 服务器备份与恢复

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

日常运行 `npm.cmd run local:start`，A 端地址为 `http://127.0.0.1:3000`；`npm run local` 和 `http://localhost:5173` 仅供开发调试。Agent 每分钟抓取未读邮件，按学号和任务 ID、固定姓名、预登记发件邮箱及专属验证码匹配固定任务名单，写入审核中记录并保存照片。发布后在管理页逐一私发每名学生的主题；验证码不能群发或复用。拒绝邮件会被记录并标记处理，不会每分钟重复抓取。此模式不需要 SMTP 代发或邮件签名；它不能证明 GPS、拍摄时间或邮件内容未被修改，应结合人工审核使用。

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

## 本地直收模式上线前验收

完成迁移和 `npm.cmd run build` 后，在管理员电脑的项目根目录运行：

```powershell
npm.cmd run local:start
```

该命令检查本地模式配置和构建产物，API 连通数据库后启动邮件 Agent。本地后台地址为 `http://127.0.0.1:3000`，不再需要 Vite 开发服务器。关闭窗口或关机后进程会停止；下次开机须确认 MySQL 运行并重新执行此命令。此模式默认只监听回环地址，不要通过端口转发把它公开到校园网或互联网。

1. 用专用 IMAP 收件箱试运行，确认邮箱服务器允许按主题搜索未读邮件。不要让邮箱规则或人工操作提前把打卡邮件标记为已读或移出 INBOX；Agent 只扫描匹配主题的未读邮件。同步本机与邮箱服务器时钟。
2. 使用独立 `attendance_test` 数据库跑上述集成测试；不要把 `TEST_DATABASE_URL` 指向业务库。真实任务另用测试学生和测试邮箱各发送一封有效、无效和重复邮件，核对审核状态、拒收日志、照片和 Agent 心跳；重启电脑后再核对数据仍在。
3. 在任务截止前发送一封邮件，等截止后再启动 Agent，确认它按 IMAP 收件时间进入审核。截止后发送的邮件应被拒绝。归档须等待截止后的完整扫描，且待解析队列为零。
4. 发布后可在“人员与任务管理”重新查看专属主题；更改某任务成员邮箱或轮换验证码会使旧主题失效。修改账号邮箱不会自动改动已发布任务的成员邮箱，需在该任务内另行更新并私发新主题。
5. 按下方流程定期备份 MySQL 数据和 `UPLOAD_DIR` 照片目录，做一次隔离恢复演练；保护数据库、邮箱授权码和专属主题。停用邮箱、网络中断、磁盘满或 Agent 报错时暂停审核与归档，先排除故障并重扫未读邮件。

### Windows 本地备份与恢复

在项目根目录运行 `npm.cmd run backup:local -- --check` 检查 `mysqldump` 和系统 `tar` 是否可用。若 MySQL 的 `bin` 未加入 PATH，可在 `apps/api/.env` 设置 `MYSQLDUMP_PATH` 为 `mysqldump.exe` 的完整路径。备份前关闭运行 `local:start` 的窗口，并确认没有单独启动的 worker；等待最多 90 秒让心跳过期，再执行：

```powershell
npm.cmd run backup:local -- --stopped
# 将下面的路径换成上一条命令生成的目录
npm.cmd run backup:verify -- .\backups\local-实际目录名
```

脚本只接受本机 MySQL 地址；API 端口仍在使用或 Agent 心跳较新时会拒绝备份。成功后在 `backups/local-.../` 生成 `database.sql`、`photos.tar.gz` 和带 SHA-256 的 `manifest.json`，不会覆盖旧备份。失败目录没有有效清单，不能当作可恢复备份。把完整目录复制到受访问控制的加密异地存储；`.env` 中的邮箱授权码不包含在备份内，需另行安全保管。备份期间不能启动 API 或 Agent，否则数据库和照片可能不一致。

恢复演练只在**另一套空的 MySQL 数据库和独立项目目录**进行：先用 `backup:verify` 校验；在 MySQL 中创建目标空库，使用 MySQL 客户端的 `SOURCE` 命令导入 `database.sql`；把 `photos.tar.gz` 解压到新环境 `UPLOAD_DIR` 的父目录，确认其中的 `uploads/check-ins` 与配置一致。启动前把新环境 IMAP 配置指向测试邮箱或禁用真实收信，避免误处理正式邮件。再核对人数、审核状态、照片预览和导出。不要在正式业务库上练习恢复。

重打卡成功后，新版 Agent 会移除被替换的本地照片；已归档记录及旧版本遗留文件不会自动删除。学校仍须确定照片保存期限、到期销毁办法和申诉期，再安排正式清理，不能把整个 `UPLOAD_DIR` 直接删除。

本地直收模式不调用网页拍照上传，学生直接发邮件；界面中的邮件正文坐标为自报信息，不能作为真实 GPS 证据。邮件 `From` 地址也可能被伪造，专属验证码只能降低误匹配风险，无法替代学校统一身份认证、可信邮件网关和人工照片审核。因此在真实学生数据与考勤处分等高风险用途上线前，还需由学校确认隐私告知、数据保存期限、备份访问权限和误判申诉流程。

`test:upgrade` 额外创建独立的旧版测试库，验证升级保留历史记录，需要测试用户拥有创建测试数据库的权限；`test:pwa` 使用最近一次构建的前端产物，验证离线导航和私密内容不缓存。
