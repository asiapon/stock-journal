@echo off
rem ============================================================
rem  操作日记 · 本地一键启动（Windows）
rem  双击本文件即可：自动找 Python、自动挑端口、自动开浏览器。
rem  停止：在这个窗口按 Ctrl+C
rem ============================================================
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

set PY=
for %%C in (python py python3) do (
  if not defined PY (
    where %%C >nul 2>nul && set PY=%%C
  )
)

if not defined PY (
  echo.
  echo   [X] 没有找到 Python。
  echo.
  echo   任选一种解决：
  echo     1^) 装 Python 3：https://www.python.org/downloads/   装的时候勾上 "Add python.exe to PATH"
  echo     2^) 用任意静态服务器也行，在项目目录执行：  npx serve .
  echo     3^) 装了 Node.js 的话：  npx --yes http-server -p 8080 -c-1 .
  echo.
  pause
  exit /b 1
)

%PY% serve.py
if errorlevel 1 pause
endlocal
