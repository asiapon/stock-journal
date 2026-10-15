#!/usr/bin/env bash
# ============================================================
#  操作日记 · 本地一键启动（macOS / Linux）
#  用法： ./start.sh        或        bash start.sh
#  停止： Ctrl+C
# ============================================================
set -e
cd "$(dirname "$0")"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo
  echo "  [X] 没有找到 Python。"
  echo
  echo "  任选一种解决："
  echo "    1) 装 Python 3（macOS: brew install python3 / Linux: apt install python3）"
  echo "    2) 用任意静态服务器：  npx serve .  或  npx --yes http-server -p 8080 -c-1 ."
  echo
  exit 1
fi

exec "$PY" serve.py "$@"
