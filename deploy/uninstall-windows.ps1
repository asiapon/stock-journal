# ============================================================================
# 股票日记（操作日记）· Windows 卸载脚本（配合 install-windows.ps1 使用）
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
# 原则：应用自身的东西逐项确认后卸载；Node/PostgreSQL/Python 等公共组件
#       默认【保留】，只有你明确回答 Y 才卸载。
# ============================================================================
param(
  [switch]$RemoveNode,    # 跳过询问，直接卸载 Node.js
  [switch]$RemovePg,      # 跳过询问，直接卸载 PostgreSQL（⚠ 连数据库一起删）
  [switch]$RemovePython   # 跳过询问，直接卸载 Python
)
$ErrorActionPreference = "Continue"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "✗ 请用管理员身份运行" -ForegroundColor Red; exit 1
}
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3000

function Ask($label) {
  # 返回 $true 仅当用户明确输入 Y/y；回车 = 否
  $a = Read-Host "  卸载 $label ？(y/N)"
  return ($a -match '^[Yy]')
}

Write-Host "=== 操作日记 · 卸载 ===" -ForegroundColor Cyan
Write-Host "以下组件将被逐项确认；公共组件（Node/PostgreSQL/Python）默认保留。"

# ---------- 1. 停止应用 ----------
Write-Host "--- [1/6] 停止服务"
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false; Write-Host "  已停止占用端口 $Port 的进程" }
  else { Write-Host "  端口 $Port 无进程在跑" }
} catch { Write-Host "  （无运行中的实例）" }
try { Unregister-ScheduledTask -TaskName "StockJournal" -Confirm:$false -ErrorAction Stop; Write-Host "  已移除登录自启计划任务" } catch { Write-Host "  无自启计划任务" }
netsh advfirewall firewall delete rule name="StockJournal3000" | Out-Null
Write-Host "  已移除防火墙放行规则"

# ---------- 2. 应用文件 ----------
Write-Host "--- [2/6] 应用文件（.env / node_modules / packs）"
if (Ask "deploy 下的 .env（含数据库密码，删后需重新跑安装脚本生成）") {
  Remove-Item (Join-Path $DeployDir ".env") -Force -ErrorAction SilentlyContinue
  Write-Host "  已删除 .env"
}
if (Ask "node_modules（后端依赖，重装 = npm install，很快）") {
  Remove-Item (Join-Path $DeployDir "node_modules") -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  已删除 node_modules"
}
if (Test-Path (Join-Path $DeployDir "packs")) {
  if (Ask "packs（已安装的 SKILL.md 技能包，含合成模块）") {
    Remove-Item (Join-Path $DeployDir "packs") -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  已删除 packs"
  }
}

# ---------- 3. 计划任务之外的应用数据：数据库 ----------
Write-Host "--- [3/6] 数据库（stockjournal）"
Write-Host "  ⚠ 删除数据库 = 交易记录/自选/问答历史/持仓全部清空，不可恢复！" -ForegroundColor Yellow
if (Ask "删除数据库 stockjournal 与角色 stockjournal（默认否）") {
  $pgBin = $null
  if (Test-Path "C:\Program Files\PostgreSQL") {
    $ver = (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending | Select-Object -First 1).Name
    $pgBin = "C:\Program Files\PostgreSQL\$ver\bin"
  }
  if ($pgBin -and (Test-Path (Join-Path $pgBin "psql.exe"))) {
    $env:PGPASSWORD = Read-Host "  输入 postgres 超级用户密码"
    & (Join-Path $pgBin "psql.exe") -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS stockjournal;" | Out-Null
    & (Join-Path $pgBin "psql.exe") -U postgres -h 127.0.0.1 -c "DROP ROLE IF EXISTS stockjournal;" | Out-Null
    Write-Host "  数据库与角色已删除"
  } else { Write-Host "  未找到 psql，跳过（可之后手动删）" }
} else { Write-Host "  已保留数据库（推荐 —— 下次实验还能用）" }

# ---------- 4~6. 公共组件（默认保留） ----------
Write-Host "--- 公共组件（默认保留，回车 = 保留）"
if ($RemovePg -or (Ask "卸载 PostgreSQL 16 ？⚠ 会删除服务器上全部数据库")) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  # EDB 卸载器本身是 GUI 向导；找到它的 uninstall-postgresql.exe 用 --mode unattended 静默执行，不弹窗
  $unExe = $null
  if (Test-Path "C:\Program Files\PostgreSQL") {
    $ver = (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending | Select-Object -First 1).Name
    $cand = "C:\Program Files\PostgreSQL\$ver\uninstall-postgresql.exe"
    if (Test-Path $cand) { $unExe = $cand }
  }
  if ($unExe) {
    Write-Host "  静默卸载中（约 1-2 分钟，无窗口）…"
    Start-Process $unExe "--mode unattended" -Wait
    Write-Host "  PostgreSQL 已卸载"
  } elseif ($winget) {
    winget uninstall -e --id PostgreSQL.PostgreSQL.16 | Out-Null
    Write-Host "  PostgreSQL 已卸载（可能弹了官方向导，按提示点完即可）"
  } else { Write-Host "  无法自动卸载（未找到卸载器与 winget）" }
} else { Write-Host "  保留 PostgreSQL" }

if ($RemoveNode -or (Ask "卸载 Node.js LTS？（机器上可能还有别的程序在用）")) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) { winget uninstall -e --id OpenJS.NodeJS.LTS | Out-Null; Write-Host "  Node.js 已卸载" }
} else { Write-Host "  保留 Node.js" }

if ($RemovePython -or (Ask "卸载 Python？（SKILL.md 技能包需要它；别的程序也可能在用）")) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) { winget uninstall -e --id Python.Python.3.12 | Out-Null; Write-Host "  Python 已卸载" }
} else { Write-Host "  保留 Python" }

Write-Host ""
Write-Host "==================== 卸载完成 ====================" -ForegroundColor Green
Write-Host "再次实验：重跑 install-windows.ps1 即可（保留的组件会被复用，几分钟搞定）。"
Write-Host "=================================================="
