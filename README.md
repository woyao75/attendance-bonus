# 高校返校手势打卡系统

MVP 一期采用 npm workspaces：`apps/web` 是 React PWA，`apps/api` 是 Express、Prisma 与邮件 Agent 服务。

## 前置条件

- Node.js 20+
- MySQL 8.0+

Create the database with `utf8mb4` before running Prisma migrations:

```sql
CREATE DATABASE attendance_bonus
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'attendance'@'localhost' IDENTIFIED BY 'password';
GRANT ALL PRIVILEGES ON attendance_bonus.* TO 'attendance'@'localhost';
FLUSH PRIVILEGES;
```

## 初始化

```bash
npm install
Copy-Item apps/api/.env.example apps/api/.env
npm run prisma:generate -w @attendance/api
npm run prisma:migrate -w @attendance/api -- --name init
```

将 `apps/api/.env` 中的数据库、SMTP 与 IMAP 参数替换为实际值后，运行：

```bash
npm run dev
```
