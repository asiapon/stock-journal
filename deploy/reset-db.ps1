# ============================================================================
# 股票日记（操作日记）· 实验环境快速重置（秒级，不卸载任何组件）
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\reset-db.ps1
# 做的事：删掉应用数据库 stockjournal → 重建空库 + 导 schema → 创建管理员
#   （默认 admin/admin123，可用参数覆盖）。Node/PG/Python 全部不动。
# 反复实验请用这个，别走「卸载 PostgreSQL → 重装」——那是分钟级的。
# ============================================================================
param(
  [string]$AdminUser = "admin",
  [string]$AdminPwd = "admin123"
)
$ErrorActionPreference = "Stop"
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DbName = "stockjournal"
$DbUser = "stockjournal"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "✗ 请用管理员身份运行" -ForegroundColor Red; exit 1
}
Write-Host "⚠ 即将清空数据库 $DbName 的全部数据（交易/自选/问答/持仓），不可恢复！" -ForegroundColor Yellow
$a = Read-Host "确认重置？(y/N)"
if ($a -notmatch '^[Yy]') { Write-Host "已取消"; exit 0 }

# 从 .env 读连接信息与 stockjournal 角色密码
$envFile = Join-Path $DeployDir ".env"
$DbPassword = $null
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern 'DATABASE_URL=postgresql://[^:]+:([^@]+)@' | Select-Object -First 1
  if ($m) { $DbPassword = $m.Matches[0].Groups[1].Value }
}
$pgBin = $null
if (Test-Path "C:\Program Files\PostgreSQL") {
  $ver = (Get-ChildItem "C:\Program Files\PostgreSQL" | Sort-Object Name -Descending | Select-Object -First 1).Name
  $pgBin = "C:\Program Files\PostgreSQL\$ver\bin"
}
$psql = Join-Path $pgBin "psql.exe"
if (-not (Test-Path $psql)) { Write-Host "✗ 找不到 psql.exe" -ForegroundColor Red; exit 1 }

$pgPwd = Read-Host "输入 postgres 超级用户密码"
$env:PGPASSWORD = $pgPwd

# 1. 重建数据库
& $psql -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS $DbName;" | Out-Null
& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'" | Out-Null
if ($LASTEXITCODE -eq 0 -and (& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'") -ne 1) {
  & $psql -U postgres -h 127.0.0.1 -c "CREATE ROLE $DbUser LOGIN PASSWORD '$DbPassword';" | Out-Null
} elseif ($DbPassword) {
  # 角色在但密码可能对不上 .env → 同步
  & $psql -U postgres -h 127.0.0.1 -c "ALTER ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword';" | Out-Null
}
& $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE $DbName OWNER $DbUser;" | Out-Null

# 2. 导 schema
& $psql -U postgres -h 127.0.0.1 -d $DbName -v ON_ERROR_STOP=1 -f (Join-Path $DeployDir "schema.sql") 2>&1 | Out-Null

# 3. 创建管理员
$r = & $psql -U postgres -h 127.0.0.1 -d $DbName -tAc "SELECT public.app_setup_admin('$AdminUser', '$AdminPwd');"

Write-Host ""
Write-Host "✅ 实验环境已重置（秒级）：库 $DbName 重建 + schema 同步 + 管理员 $AdminUser / $AdminPwd" -ForegroundColor Green
Write-Host "   刷新 http://localhost:3000 用上述账号登录即可继续实验。"
