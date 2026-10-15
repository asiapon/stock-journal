@echo off
rem ASCII-only shim: real logic lives in start-windows.ps1 (restart semantics).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1"
