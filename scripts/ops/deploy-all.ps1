# 비밀번호 문서 → DPAPI 파일로 옮기고 평문을 지운 뒤, 신고 서버 → 사이트 순서로 배포. 비밀번호는 출력하지 않는다.
$ErrorActionPreference = 'Stop'
$txt = Join-Path $env:USERPROFILE '.ara-secrets\deploy-password.txt'
$enc = Join-Path $env:USERPROFILE '.ara-reports-admin'
$lines = Get-Content -LiteralPath $txt -Encoding UTF8
$line = $lines | Where-Object { $_ -like 'PASSWORD=*' } | Select-Object -First 1
$pw = if ($line) { $line.Substring(9) } else { '' }
if ($pw) {
  ConvertTo-SecureString $pw -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $enc
  $lines | ForEach-Object { if ($_ -like 'PASSWORD=*') { 'PASSWORD=' } else { $_ } } | Set-Content -LiteralPath $txt -Encoding UTF8
  'imported (plaintext wiped)'
} elseif (Test-Path -LiteralPath $enc) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Get-Content -LiteralPath $enc | ConvertTo-SecureString))
  try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  'using saved encrypted password'
} else { 'NO_PASSWORD'; exit 2 }
if ($args -contains '-ImportOnly') { exit 0 }
$env:ARA_DEPLOY_PW = $pw; $env:ARA_REPORTS_ADMIN_PW = $pw; Remove-Variable pw
Set-Location 'D:\AI\OFA'
'=== reports:deploy'; npm run reports:deploy; if ($LASTEXITCODE -ne 0) { 'REPORTS_DEPLOY_FAIL'; exit 3 }
'=== site:deploy'; npm run site:deploy; if ($LASTEXITCODE -ne 0) { 'SITE_DEPLOY_FAIL'; exit 4 }
'DEPLOY_OK'
