# ============================================================================
# 操作日记 · 启动/重启服务（restart 语义：可反复运行，旧实例先停再启）
# 用法（普通 PowerShell 即可）：
#   powershell -ExecutionPolicy Bypass -File .\start-windows.ps1
# 服务以隐藏窗口常驻；停止用 stop-windows.ps1；看日志：deploy/logs/
# ============================================================================
$ErrorActionPreference = "Stop"
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3000

# 1. 停掉旧实例（3000 端口的监听者）
$killed = 0
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  try { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false; $killed++ } catch { }
}
if ($killed -gt 0) { Write-Host "已停止旧实例（$killed 个）"; Start-Sleep -Seconds 2 }
else { Write-Host "端口 $Port 无旧实例，直接启动" }

# 2. 启动新实例（隐藏窗口常驻）
$proc = Start-Process -FilePath "node" -ArgumentList (Join-Path $DeployDir "server.js") `
  -WorkingDirectory $DeployDir -PassThru -WindowStyle Hidden

# 3. 健康检查（最多等 10 秒）
$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  try { $r = Invoke-RestMethod "http://localhost:$Port/healthz" -TimeoutSec 2; if ($r.ok) { $ok = $true; break } } catch { }
}
if ($ok) {
  Write-Host "✅ 服务已启动并保持运行：http://localhost:$Port" -ForegroundColor Green
  Write-Host "   停止：powershell -File .\stop-windows.ps1 （或任务管理器结束 node.exe）"
  Write-Host "   日志：deploy/logs/app-日期.log（每次数据调用的明细）"
} else {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  Write-Host "✗ 健康检查未通过（10 秒内 /healthz 无响应）。排查：1) deploy/.env 是否存在  2) PostgreSQL 服务是否在跑" -ForegroundColor Red
  exit 1
}
