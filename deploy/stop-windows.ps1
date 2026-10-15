# ============================================================================
# 操作日记 · 停止服务（杀掉 3000 端口的监听进程）
# 用法：powershell -ExecutionPolicy Bypass -File .\stop-windows.ps1
# ============================================================================
$ErrorActionPreference = "Continue"
$killed = 0
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Stop-Process -Id $_.OwningProcess -Force -Confirm:$false
    Write-Host "已停止 PID $($_.OwningProcess)"
    $killed++
  } catch { Write-Host "停止 PID $($_.OwningProcess) 失败：$($_.Exception.Message)" }
}
if ($killed -gt 0) { Write-Host "✅ 服务已停止" -ForegroundColor Green }
else { Write-Host "服务本来就没在运行" }
