#!/usr/bin/env bash
# ============================================================================
# 股票日记（操作日记）· Ubuntu 卸载脚本（配合 install-ubuntu.sh 使用）
# 用法：sudo bash uninstall-ubuntu.sh
# 原则：应用自身的东西逐项确认后卸载；Node/PostgreSQL/Python 等公共组件
#       默认【保留】，只有你明确输入 y 才卸载。
# ============================================================================
set -u
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_NAME="${DB_NAME:-stockjournal}"
DB_USER="${DB_USER:-stockjournal}"

[ "$(id -u)" -eq 0 ] || { echo "✗ 请用 sudo 运行"; exit 1; }

ask() { # 回车 = 否，仅 y/Y = 是
  local a
  read -r -p "  卸载 $1 ？(y/N): " a
  [[ "$a" =~ ^[Yy] ]]
}

echo "=== 操作日记 · 卸载 ==="
echo "以下组件逐项确认；公共组件（Node/PostgreSQL/Python）默认保留。"

# ---------- 1. 停止服务 ----------
echo "--- [1/5] 停止服务"
systemctl stop stock-journal 2>/dev/null && echo "  已停止 stock-journal 服务" || echo "  服务未在运行"
systemctl disable stock-journal 2>/dev/null
rm -f /etc/systemd/system/stock-journal.service
systemctl daemon-reload
echo "  已移除 systemd 服务单元"

# ---------- 2. 应用文件 ----------
echo "--- [2/5] 应用文件"
if ask "deploy 下的 .env（含数据库密码，删后需重新生成）"; then
  rm -f "${DEPLOY_DIR}/.env" && echo "  已删除 .env"
fi
if ask "node_modules（后端依赖，重装 = npm install）"; then
  rm -rf "${DEPLOY_DIR}/node_modules" && echo "  已删除 node_modules"
fi
if [ -d "${DEPLOY_DIR}/packs" ] && ask "packs（已安装的 SKILL.md 技能包）"; then
  rm -rf "${DEPLOY_DIR}/packs" && echo "  已删除 packs"
fi

# ---------- 3. 数据库 ----------
echo "--- [3/5] 数据库（${DB_NAME}）"
echo "  ⚠ 删除数据库 = 交易记录/自选/问答历史/持仓全部清空，不可恢复！"
if ask "删除数据库 ${DB_NAME} 与角色 ${DB_USER}（默认否）"; then
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME};" && \
  sudo -u postgres psql -c "DROP ROLE IF EXISTS ${DB_USER};" && \
  echo "  数据库与角色已删除"
else
  echo "  已保留数据库（推荐 —— 下次实验还能用）"
fi

# ---------- 4. Python 依赖（pip 包） ----------
echo "--- [4/5] Python 依赖"
if ask "卸载 pip 包（requests pandas stockstats mootdx baostock xlrd openpyxl；别的 Python 项目可能也在用）"; then
  python3 -m pip uninstall -y requests pandas stockstats mootdx baostock xlrd openpyxl 2>/dev/null
  echo "  已卸载 pip 包"
else
  echo "  保留 Python 依赖"
fi

# ---------- 5. 公共组件 ----------
echo "--- [5/5] 公共组件（默认保留，回车 = 保留）"
if ask "卸载 Node.js？（机器上可能还有别的程序在用）"; then
  apt-get remove -y nodejs 2>/dev/null && echo "  Node.js 已卸载"
else
  echo "  保留 Node.js"
fi
if ask "卸载 PostgreSQL ？⚠ 会删除服务器上全部数据库"; then
  apt-get purge -y postgresql postgresql-contrib 2>/dev/null && echo "  PostgreSQL 已卸载"
else
  echo "  保留 PostgreSQL"
fi

echo ""
echo "==================== 卸载完成 ===================="
echo "再次实验：重跑 install-ubuntu.sh 即可（保留的组件会被复用）。"
echo "=================================================="
