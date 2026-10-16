# ============================================================================
# 操作日记 · 停止服务（杀掉服务端口的监听进程；端口从 .env 的 PORT 读取，默认 3000）
# 用法：powershell -ExecutionPolicy Bypass -File .\stop-windows.ps1
# ============================================================================
$ErrorActionPreference = "Continue"
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3000
$envFile = Join-Path $DeployDir ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object { if ($_ -match '^\s*PORT\s*=\s*(\d+)\s*$') { $Port = [int]$Matches[1] } }
}
$killed = 0
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Stop-Process -Id $_.OwningProcess -Force -Confirm:$false
    Write-Host "已停止 PID $($_.OwningProcess)"
    $killed++
  } catch { Write-Host "停止 PID $($_.OwningProcess) 失败：$($_.Exception.Message)" }
}
if ($killed -gt 0) { Write-Host "✅ 服务已停止（端口 $Port）" -ForegroundColor Green }
else { Write-Host "服务本来就没在运行（端口 $Port 无监听）" }
