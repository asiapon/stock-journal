@echo off
rem ASCII-only shim: real logic lives in stop-windows.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-windows.ps1"
