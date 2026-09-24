#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="backups/$stamp"
mkdir -p "$destination"
dc=(docker compose --env-file .env.production)
# 暂停写入确保数据库与照片一致；备份失败也会尝试恢复服务。
trap '"${dc[@]}" up -d api worker' EXIT
"${dc[@]}" stop api worker
"${dc[@]}" exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -u root --single-transaction --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 attendance_bonus' > "$destination/database.sql"
"${dc[@]}" run --rm --no-deps --user root --entrypoint tar api -czf - -C /app/apps/api/uploads . > "$destination/photos.tar.gz"
sha256sum "$destination/database.sql" "$destination/photos.tar.gz" > "$destination/SHA256SUMS"
printf 'Backup saved to %s. Copy it to encrypted off-server storage.\n' "$destination"
