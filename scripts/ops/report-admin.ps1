# 신고 관리 일괄 적용. 비밀번호는 DPAPI 로 잠긴 파일(%USERPROFILE%\.ara-reports-admin)에서만 읽고 출력하지 않는다.
param([string]$Actions)
$ErrorActionPreference = 'Stop'
$api = 'http://192.168.100.56:8897'
$f = Join-Path $env:USERPROFILE '.ara-reports-admin'
if (-not (Test-Path -LiteralPath $f)) { 'NO_PW_FILE'; exit 2 }
$sec = Get-Content -LiteralPath $f | ConvertTo-SecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
$h = @{ Authorization = 'Bearer b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pw)) }
Remove-Variable pw
function Send($method, $url, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  try { Invoke-RestMethod -Method $method -Uri $url -Headers $h -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null; 'ok' }
  catch { 'FAIL ' + $_.Exception.Response.StatusCode.value__ }
}
try { Invoke-RestMethod -Uri "$api/api/admin/check" -Headers $h | Out-Null; 'admin ok' } catch { 'ADMIN_FAIL ' + $_.Exception.Response.StatusCode.value__; exit 3 }
foreach ($a in (Get-Content -LiteralPath $Actions -Encoding UTF8 -Raw | ConvertFrom-Json)) {
  $u = "$api/api/reports/$($a.id)"
  if ($a.comment) { "$($a.id) comment: " + (Send 'Post' "$u/comments" @{ body = $a.comment }) }
  $p = @{}
  if ($a.status) { $p.status = $a.status }
  if ($a.fixedIn) { $p.fixedIn = $a.fixedIn }
  if ($p.Count) { "$($a.id) patch: " + (Send 'Patch' $u $p) }
}
