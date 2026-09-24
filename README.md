# 高校返校手势打卡系统

React + TypeScript + PWA，Express + Prisma + MySQL 8.0。支持单机本地模式：学生直接向归档邮箱发邮件，由 IMAP worker 解析并推进审核状态。

已提供登录与 Cookie 会话、首次改密、角色/任务范围权限、班级与人员管理、CSV 导入、任务名单快照、邮件重试、照片保护、审核、Excel/ZIP 导出和 Docker Compose 部署。

**当前使用本地版，不需要 Linux 服务器。请从 [本地部署与使用手册](docs/DEPLOYMENT.md) 开始。** Linux、Docker 和公网域名章节属于以后需要多人远程访问时的可选方案。测试证据与人工验收项见 [交付记录](docs/HANDOFF.md)。

## 本地启动

需要 Node.js 22.12+ 和 MySQL 8.0。填写 `apps/api/.env`（参考 `.env.example`），保留现有凭据。

```powershell
npm ci
# 若官方 Prisma 引擎下载超时，在 apps/api/.env 添加：
# PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma"
npm run prisma:generate -w @attendance/api
npm run db:deploy -w @attendance/api
npm run admin:create -w @attendance/api
npm run local
```

`admin:create` 需临时设置 ADMIN_ACCOUNT、ADMIN_PASSWORD；创建后移除密码配置。首次登录必须改密。打开 http://localhost:5173 ，学生、辅导员和管理员均从登录页进入。

已有数据库先备份再升级。可运行 `npm run doctor -w @attendance/api` 检查缺少的配置和数据表，检查过程不显示凭据、不发送邮件。

## 项目目录

- `apps/api`：API、邮件 worker、MySQL schema 和升级迁移。
- `apps/web`：登录、学生拍照、后台管理、Dashboard 与 PWA。
- `deploy`、`compose.yaml`、`Dockerfile`：单机 HTTPS 部署。
- `scripts`：浏览器测试、图标生成和备份。
- `docs`：部署、权限规则、验收与运维说明。

## 验证

```powershell
npm run lint
npm run build
npm test
```

真实数据库集成测试必须配置独立的 `TEST_DATABASE_URL`；未配置时会跳过该组测试。具体步骤见部署手册。不要将测试连接设置为真实业务数据库。

## 单机直收邮箱模式

将 `apps/api/.env` 的 `LOCAL_EMAIL_MODE` 设为 `true`，只配置 IMAP。学生直接向 `IMAP_USER` 发邮件，主题使用 `[返校打卡] 学号_姓名_任务ID_专属验证码`，附件放照片；本机 Agent 每分钟抓取并在 A 端显示为“审核中”。发布任务后，管理页会列出每名学生的专属主题，必须逐人私发，不可群发。运行 `npm run local` 启动本地 API、A 端和 Agent。
