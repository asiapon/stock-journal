@echo off
rem Trading Journal - local static server
cd /d %~dp0
echo ========================================
echo  Journal local server
echo  http://localhost:8080
echo  Press Ctrl+C to stop
echo ========================================
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server 8080
  goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server 8080
  goto :eof
)
echo Python not found. Install Python 3, or serve this folder with any static server
echo (for example: npx serve .)
pause
