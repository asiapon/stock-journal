#!/usr/bin/env bash
# ============================================================================
# 股票日记 · Ubuntu/Debian 一键部署脚本（v3.10.2）
# 用法：  sudo bash install-ubuntu.sh
# 可选环境变量：
#   DB_PASSWORD=xxx    数据库角色 stockjournal 的密码（缺省随机生成，见输出）
#   PORT=3000          服务端口
# 幂等：重复执行安全（已装的跳过，schema.sql 可重复执行）。
# ============================================================================
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$DEPLOY_DIR")"
DB_NAME="${DB_NAME:-stockjournal}"
DB_USER="${DB_USER:-stockjournal}"
DB_PASSWORD="${DB_PASSWORD:-}"
PORT="${PORT:-3000}"

[ "$(id -u)" -eq 0 ] || { echo "✗ 请用 sudo 运行"; exit 1; }
echo "=== 股票日记一键部署（$(date '+%F %T')）==="
echo "仓库: $ROOT_DIR"

# ---------- 1. 基础依赖 ----------
echo "--- [1/6] 系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg >/dev/null

# ---------- 2. Node.js >= 18 ----------
echo "--- [2/6] Node.js"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ]; then
  echo "  已有 node $(node -v)，跳过"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  echo "  已安装 node $(node -v)"
fi

# ---------- 3. PostgreSQL ----------
echo "--- [3/6] PostgreSQL"
if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y -qq postgresql postgresql-contrib >/dev/null
fi
systemctl enable --now postgresql >/dev/null 2>&1 || service postgresql start
PG_VER="$(ls /etc/postgresql | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VER}/bin"
if [ -z "$DB_PASSWORD" ]; then
  DB_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  GENERATED_PW=1
else
  GENERATED_PW=0
fi
# 角色 / 库（幂等）
sudo -u postgres "${PG_BIN}/psql" -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres "${PG_BIN}/psql" -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
sudo -u postgres "${PG_BIN}/psql" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres "${PG_BIN}/psql" -qc "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
# schema（幂等；以属主角色执行，函数/表归它所有）
sudo -u postgres "${PG_BIN}/psql" -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
  -f "${DEPLOY_DIR}/schema.sql" >/dev/null
echo "  数据库 ${DB_NAME} 就绪（schema 已同步）"

# ---------- 4. 后端依赖 ----------
echo "--- [4/6] npm 依赖"
cd "$DEPLOY_DIR"
npm install --omit=dev --no-fund --no-audit >/dev/null 2>&1
echo "  node_modules 就绪"

# ---------- 5. .env ----------
echo "--- [5/6] 配置"
if [ ! -f .env ]; then
  cat > .env <<EOF
PORT=${PORT}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
SYNC_AT=17:30
REQUIRE_KEY=0
ACCESS_KEY=
EOF
  echo "  已生成 .env"
else
  echo "  .env 已存在，保持不变（如需重建请删除后重跑）"
fi
# systemd 用到的密码即 .env 内的，这里只在新生成时打印
[ "$GENERATED_PW" = 1 ] && echo "  （随机生成的数据库密码已写入 .env，无需记忆）"

# ---------- 6. systemd 服务 ----------
echo "--- [6/6] systemd 服务"
cat > /etc/systemd/system/stock-journal.service <<EOF
[Unit]
Description=Stock Journal (股票日记) self-hosted server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${DEPLOY_DIR}
ExecStart=$(command -v node) ${DEPLOY_DIR}/server.js
Restart=always
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now stock-journal >/dev/null 2>&1
sleep 1
if curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
  HEALTH='✓ 健康检查通过'
else
  HEALTH='✗ 健康检查未通过，请查看: journalctl -u stock-journal -n 50'
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "==================== 部署完成 ===================="
echo "  访问地址:  http://localhost:${PORT}  （局域网: http://${IP:-<本机IP>}:${PORT}）"
echo "  $HEALTH"
echo "  服务管理:  systemctl restart|stop|status stock-journal"
echo "  查看日志:  journalctl -u stock-journal -f"
echo "  下次升级:  git pull 后重跑本脚本（schema 幂等，数据不受影响）"
echo "  首次使用:  打开网页 → 首次初始化 → 设置管理员账号"
echo "=================================================="
