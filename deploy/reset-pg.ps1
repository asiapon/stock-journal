# ============================================================================
# PostgreSQL postgres 超级用户密码重置（救援脚本）
# 适用：winget/EDB 静默安装后不知道 postgres 密码，导致 install-windows.ps1 连不上库。
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\reset-pg.ps1 -NewPassword "你的新密码"
# 原理：临时把 pg_hba.conf 的本机认证改为 trust → ALTER USER 重设密码 → 恢复原配置并重启。
# 全程自动备份 pg_hba.conf（pg_hba.conf.bak-时间戳）。
# ============================================================================
param([string]$NewPassword = "")
$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "✗ 请用管理员身份运行" -ForegroundColor Red; exit 1
}
if (-not $NewPassword) {
  $secure = Read-Host "输入 postgres 的新密码" -AsSecureString
  $NewPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# 1. 找到运行中的 PostgreSQL 服务与数据目录
$svc = Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'postgresql*' } | Select-Object -First 1
if (-not $svc) { Write-Host "✗ 未找到 PostgreSQL 服务" -ForegroundColor Red; exit 1 }
Write-Host "服务: $($svc.Name)（$($svc.State)）"
if ($svc.PathName -match '-D\s+"([^"]+)"') { $dataDir = $Matches[1] }
elseif ($svc.PathName -match '-D\s+(\S+)') { $dataDir = $Matches[1] }
else { Write-Host "✗ 无法从服务路径解析数据目录：$($svc.PathName)" -ForegroundColor Red; exit 1 }
Write-Host "数据目录: $dataDir"
$hba = Join-Path $dataDir "pg_hba.conf"
if (-not (Test-Path $hba)) { Write-Host "✗ 找不到 $hba" -ForegroundColor Red; exit 1 }
$binDir = Split-Path -Parent $svc.PathName.Replace('"', '').Split('-')[0].Trim()

# 2. 停服务 → 备份并临时改为 trust（仅本机 IPv4/IPv6 行）
Write-Host "停止服务并临时开启 trust 认证…"
Stop-Service $svc.Name -Force
Copy-Item $hba "$hba.bak-reset" -Force
$lines = Get-Content $hba
$lines = $lines | ForEach-Object {
  if ($_ -match '^\s*host\s' -and $_ -match '\b(scram-sha-256|md5)\b') {
    ($_ -replace '\b(scram-sha-256|md5)\b', 'trust')
  } else { $_ }
}
Set-Content -Path $hba -Value $lines -Encoding ASCII
Start-Service $svc.Name
Start-Sleep -Seconds 2

# 3. 重设密码
$psql = Join-Path $binDir "psql.exe"
if (-not (Test-Path $psql)) { $psql = "psql" }
& $psql -U postgres -h 127.0.0.1 -c "ALTER USER postgres PASSWORD '$NewPassword';"
if ($LASTEXITCODE -ne 0) { Write-Host "✗ ALTER USER 失败" -ForegroundColor Red; exit 1 }

# 4. 恢复 pg_hba 并重启
Copy-Item "$hba.bak-reset" $hba -Force
Restart-Service $svc.Name -Force
Start-Sleep -Seconds 2

# 5. 用新密码验证
$env:PGPASSWORD = $NewPassword
& $psql -U postgres -h 127.0.0.1 -tAc "SELECT 'OK'::text" | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "✅ postgres 密码已重置并验证通过。新密码：$NewPassword" -ForegroundColor Green
  Write-Host "   请记好它（或直接重跑 install-windows.ps1，提示输入密码时填这个）。"
} else {
  Write-Host "✗ 重置后验证失败，请检查 pg_hba.conf.bak-reset 与服务状态" -ForegroundColor Red
}
