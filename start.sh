#!/usr/bin/env bash
# 操作日记 · 本地静态服务
cd "$(dirname "$0")"
echo "========================================"
echo " 操作日记 · 本地服务"
echo " http://localhost:8080"
echo " Ctrl+C 停止"
echo "========================================"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server 8080
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server 8080
else
  echo "未找到 python，请改用任意静态服务器，例如: npx serve ."
  exit 1
fi
