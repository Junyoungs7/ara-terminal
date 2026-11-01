# OR-1 릴리스 점검 — 아라 Electron 을 올렸으면(package.json "electron") 설치본 빌드 전에 이것을 돌린다.
# 동봉 Oriel 은 아라의 Electron 으로 뜬다(결정: Electron 공유) → 그 Electron 으로 Oriel 저장소의 e2e 를 돌려 호환을 본다:
#   ORIEL_ELECTRON=<아라 electron.exe> npm run e2e   (Oriel 저장소에서)
# 통과하면 scripts/ops/oriel-compat.json 에 판을 적는다 — 빌드(beforePack scripts/stage-oriel.cjs)는 그 판이 지금 Electron 과
# 다르면 경고한다. e2e 는 Oriel 앱을 스스로 띄운다(켜 둔 Oriel 은 먼저 끈다). 창이 뜨므로 사람이 자리에 있을 때 돌린다.
param([string]$OrielSrc = $(if ($env:ORIEL_SRC) { $env:ORIEL_SRC } else { 'D:\AI\ai-browser' }))
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { "NO_ARA_ELECTRON $electron"; exit 2 }
$ver = (Get-Content -LiteralPath (Join-Path $root 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
$commit = (git -C $OrielSrc rev-parse --short HEAD)
"=== Oriel e2e with ARA Electron $ver ($electron), Oriel $commit"
Push-Location $OrielSrc
try { $env:ORIEL_ELECTRON = $electron; npm run e2e; $code = $LASTEXITCODE } finally { Remove-Item Env:ORIEL_ELECTRON -ErrorAction SilentlyContinue; Pop-Location }
if ($code -ne 0) { "ORIEL_COMPAT_FAIL (exit $code) — 아라 Electron $ver 로 Oriel 이 안 돈다. 동봉 빌드 전에 Oriel 세션에 알린다."; exit 1 }
[ordered]@{ electron = $ver; orielCommit = $commit; result = 'e2e pass'; checkedBy = "oriel-compat.ps1 $(Get-Date -Format s)" } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'oriel-compat.json') -Encoding UTF8
"ORIEL_COMPAT_OK $ver"
