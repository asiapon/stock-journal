# ============================================================================
# 操作日记 · Windows 一键部署脚本（v3.10.2）
# 用法（管理员 PowerShell）：
#   cd deploy
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
# 可选参数：
#   -DbPassword "xxx"      数据库角色密码（缺省随机生成，写入 .env）
#   -PgSuperPassword "xxx" postgres 超级用户密码（已装 PG 时用于建库；缺省会提示）
#   -AutoStart             注册开机/登录自启（计划任务）
# 幂等：重复执行安全（已装的跳过，schema.sql 可重复执行）。
# ============================================================================
param(
  [string]$DbPassword = "",
  [string]$PgSuperPassword = "",
  [switch]$AutoStart
)
$ErrorActionPreference = "Stop"
# 控制台切 UTF-8：psql/npm/python 的中文输出不再乱码
try {
  chcp 65001 > $null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $env:PGCLIENTENCODING = 'UTF8'
} catch { # 老控制台不支持也不影响功能
}
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $DeployDir
$DbName = "stockjournal"
$DbUser = "stockjournal"
$Port = 3000

Write-Host "=== 操作日记一键部署（Windows）===" -ForegroundColor Cyan
Write-Host "仓库: $RootDir"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) { Write-Host "✗ 请用管理员身份运行 PowerShell" -ForegroundColor Red; exit 1 }

# ---------- 1. Node.js >= 18 ----------
Write-Host "--- [1/6] Node.js"
$nodeOk = $false
try { $v = (& node -v) 2>$null; if ($v -match '^v(\d+)') { if ([int]$Matches[1] -ge 18) { $nodeOk = $true; Write-Host "  已有 node $v，跳过" } } } catch {}
if (-not $nodeOk) {
  Write-Host "  安装 Node.js LTS（winget）…"
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
    # 刷新当前会话 PATH
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "  已安装 node $(& node -v)"
  } else {
    Write-Host "✗ 未检测到 winget。请手动安装 Node.js LTS（https://nodejs.org）后重跑本脚本。" -ForegroundColor Red
    exit 1
  }
}

# ---------- 2. PostgreSQL ----------
Write-Host "--- [2/6] PostgreSQL"
$pgBin = $null
if (Test-Path "C:\Program Files\PostgreSQL") {
  $ver = (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending | Select-Object -First 1).Name
  $pgBin = "C:\Program Files\PostgreSQL\$ver\bin"
  Write-Host "  已有 PostgreSQL $ver，跳过安装"
} else {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Write-Host "✗ 未检测到 winget。请手动安装 PostgreSQL（https://www.postgresql.org/download/windows/）后重跑。" -ForegroundColor Red; exit 1 }
  Write-Host "  安装 PostgreSQL 16（winget，耗时几分钟）…"
  winget install -e --id PostgreSQL.PostgreSQL.16 --accept-source-agreements --accept-package-agreements | Out-Null
  $ver = (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending | Select-Object -First 1).Name
  $pgBin = "C:\Program Files\PostgreSQL\$ver\bin"
}
$psql = Join-Path $pgBin "psql.exe"
if (-not (Test-Path $psql)) { Write-Host "✗ 找不到 psql.exe（$pgBin）" -ForegroundColor Red; exit 1 }
if (-not $PgSuperPassword) {
  $secure = Read-Host "  输入 postgres 超级用户密码（安装 PG 时设置的那个）" -AsSecureString
  $PgSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
# 密码验证 + 重试（3 次）；连不上多半是 winget 静默安装未按你输入设置密码 → 跑 reset-pg.ps1 重置
$pwOk = $false
for ($attempt = 1; $attempt -le 3 -and -not $pwOk; $attempt++) {
  $env:PGPASSWORD = $PgSuperPassword
  $t = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1") 2>$null
  if ("$t".Trim() -eq "1") { $pwOk = $true; break }
  if ($attempt -lt 3) {
    Write-Host "  ✗ 第 $attempt 次认证失败。若忘记密码：另开管理员 PowerShell 运行  .\reset-pg.ps1  重置后再试" -ForegroundColor Yellow
    $secure = Read-Host "  重新输入 postgres 密码" -AsSecureString
    $PgSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
}
if (-not $pwOk) {
  Write-Host "✗ 连续 3 次认证失败。请运行救援脚本重置密码后重跑本脚本：" -ForegroundColor Red
  Write-Host "    powershell -ExecutionPolicy Bypass -File .\reset-pg.ps1" -ForegroundColor Red
  exit 1
}
Write-Host "  postgres 认证通过"

# ---------- 3. 角色 / 数据库 / schema ----------
Write-Host "--- [3/6] 数据库初始化"
if (-not $DbPassword) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  $DbPassword = -join (1..20 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
  $GeneratedPw = $true
} else { $GeneratedPw = $false }
$existsRole = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'") 2>$null
if ("$existsRole".Trim() -ne "1") {
  & $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE $DbUser LOGIN PASSWORD '$DbPassword'" | Out-Null
}
$existsDb = (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'") 2>$null
if ("$existsDb".Trim() -ne "1") {
  & $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE $DbName OWNER $DbUser" | Out-Null
}
& $psql -U postgres -h 127.0.0.1 -d $DbName -v ON_ERROR_STOP=1 -f (Join-Path $DeployDir "schema.sql") | Out-Null
Write-Host "  数据库 $DbName 就绪（schema 已同步）"

# ---------- 4. 后端依赖 + .env ----------
Write-Host "--- [4/6] 后端依赖与配置"
# Python：整包安装 SKILL.md 技能包（a-stock-data 等）需要
$pyOk = $false
try { $pv = (& python --version) 2>$null; if ($pv -match '^Python 3') { $pyOk = $true; Write-Host "  已有 $pv，跳过安装" } } catch {}
if (-not $pyOk) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    Write-Host "  已安装 $(& python --version)"
  } else {
    Write-Host "  ⚠ 未装 Python 且无 winget —— SKILL.md 技能包不可用，其余功能不受影响" -ForegroundColor Yellow
  }
}
# pip 会往 stderr 写进度 → EAP=Stop 下会被误判为终止错误，这里局部降级并静默
$eapSaved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& python -m pip install --quiet requests pandas stockstats mootdx baostock xlrd openpyxl 2>&1 | Out-Null
$ErrorActionPreference = $eapSaved
if ($LASTEXITCODE -ne 0) { Write-Host "  ⚠ Python 依赖安装失败，请手动: python -m pip install requests pandas stockstats mootdx baostock xlrd openpyxl" -ForegroundColor Yellow }
Push-Location $DeployDir
& npm install --omit=dev --no-fund --no-audit 2>$null | Out-Null
Pop-Location
$envFile = Join-Path $DeployDir ".env"
if (-not (Test-Path $envFile)) {
  @"
PORT=$Port
DATABASE_URL=postgresql://${DbUser}:${DbPassword}@localhost:5432/${DbName}
SYNC_AT=17:30
REQUIRE_KEY=0
ACCESS_KEY=
"@ | Set-Content -Path $envFile -Encoding ASCII
  Write-Host "  已生成 .env（数据库密码已写入，无需记忆）"
} else {
  Write-Host "  .env 已存在，保持不变"
}

# ---------- 5. 启动脚本 + 可选自启 ----------
Write-Host "--- [5/6] 启动方式 + 防火墙"
netsh advfirewall firewall add rule name="StockJournal3000" dir=in action=allow protocol=TCP localport=$Port | Out-Null
Write-Host "  已放行入站端口 $Port"
$bat = Join-Path $DeployDir "start-windows.bat"
@"
@echo off
cd /d "%~dp0"
node server.js
"@ | Set-Content -Path $bat -Encoding ASCII
if ($AutoStart) {
  $action = New-ScheduledTaskAction -Execute "node.exe" -Argument (Join-Path $DeployDir "server.js") -WorkingDirectory $DeployDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName "StockJournal" -Action $action -Trigger $trigger -Force | Out-Null
  Write-Host "  已注册登录自启（计划任务 StockJournal）"
}

# 试启动并健康检查（通过则保持运行，不再停止 —— 装完即可访问）
$proc = Start-Process -FilePath "node" -ArgumentList (Join-Path $DeployDir "server.js") -WorkingDirectory $DeployDir -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$health = "✗ 健康检查未通过（端口 $Port 可能被占用）"
try { $r = Invoke-RestMethod "http://localhost:$Port/healthz" -TimeoutSec 3; if ($r.ok) { $health = "✓ 健康检查通过，服务保持运行中" } } catch {}
if ($proc -and -not $proc.HasExited -and $health -notlike '*✗*') {
  Write-Host "  服务已保持运行（如需停止：任务管理器结束 node.exe，或直接关机重启后用计划任务/bat 启动）"
} elseif ($proc -and -not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force
}

Write-Host ""
Write-Host "==================== 部署完成 ====================" -ForegroundColor Green
Write-Host "  访问地址:  http://localhost:$Port"
Write-Host "  $health"
Write-Host "  启动:      双击 deploy\start-windows.bat（或重启后计划任务自启）"
Write-Host "  下次升级:  git pull 后重跑本脚本（schema 幂等，数据不受影响）"
Write-Host "  首次使用:  打开网页 → 首次初始化 → 设置管理员账号"
Write-Host "=================================================="
