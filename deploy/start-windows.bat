@echo off
rem ASCII-only on purpose: cmd parses .bat with the system codepage (GBK on zh-CN
rem Windows), so Chinese comments here get misread and corrupt execution.
rem Port-occupied pre-check: EADDRINUSE stack trace is user-hostile.
cd /d "%~dp0"
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if %errorlevel%==0 (
  echo [X] Port 3000 is already in use. Occupied by:
  netstat -ano | findstr /R /C:":3000 .*LISTENING"
  echo.
  echo Fix:
  echo   1. Kill the stale node.exe:  taskkill /PID pid-above /F
  echo   2. Or change PORT in .env, then run this script again.
  echo.
  pause
  exit /b 1
)
node server.js
