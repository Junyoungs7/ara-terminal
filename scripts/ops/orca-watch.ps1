# Orca 업데이트 주간 점검 — 재료만 모은다 (분류·반영은 Claude 세션에서).
# 창·클립보드·알림 없음. 출력은 파일로만. 네트워크: github.com / api.github.com 읽기만.
# -DryRun : fetch·state 갱신 없이 지금 클론으로 보고서만.
# -StateFile / -PortMap : 시험용 경로 재지정.
param(
  [switch]$DryRun,
  [string]$Repo = 'D:\orca',
  [string]$HerdrRepo = 'D:\herdr-src\herdr',
  [string]$OutDir = 'D:\AI\OFA\agent_talk\orca-watch',
  [string]$StateFile = '',
  [string]$PortMap = 'D:\AI\OFA\docs\orca-port-map.json'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not $StateFile) { $StateFile = Join-Path $OutDir 'state.json' }
$utf8 = New-Object Text.UTF8Encoding($false)
function Save($p, $t) { [IO.File]::WriteAllText($p, $t, $utf8) }
function G   { $ErrorActionPreference = 'Continue'; $o = & git -C $Repo @args 2>$null; $script:rc = $LASTEXITCODE; $o }
function GE  { $ErrorActionPreference = 'Continue'; $o = & git -C $Repo @args 2>&1 | ForEach-Object { "$_" }; $script:rc = $LASTEXITCODE; $o }
function HG  { $ErrorActionPreference = 'Continue'; $o = & git -C $HerdrRepo @args 2>$null; $script:rc = $LASTEXITCODE; $o }
function HGE { $ErrorActionPreference = 'Continue'; $o = & git -C $HerdrRepo @args 2>&1 | ForEach-Object { "$_" }; $script:rc = $LASTEXITCODE; $o }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$errFile = Join-Path $OutDir 'last-error.txt'
$today = Get-Date -Format 'yyyy-MM-dd'
$notes = New-Object Collections.Generic.List[string]   # 보고서 상단 경고/오류
try {
  # 1. 상태
  if (Test-Path $StateFile) { $st = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  else { $st = [pscustomobject]@{ lastTag = 'v1.4.245'; lastCommit = '7a7f46f8a3'; lastRun = '' } }

  # 2. fetch + ff-only
  if (-not $DryRun) {
    $o = GE fetch --tags origin
    if ($rc -ne 0) { $notes.Add("fetch 실패 (rc=$rc): $($o -join ' ')") }
    else {
      $dirty = G status --porcelain --untracked-files=no
      if ($dirty) { $notes.Add('로컬 변경이 있어 merge 를 건너뜀 (fast-forward 중단).') }
      else {
        $o = GE merge --ff-only origin/main
        if ($rc -ne 0) { $notes.Add("ff-only merge 실패 (rc=$rc): $($o -join ' ')") }
      }
    }
  }
  $head = (G rev-parse --short=10 HEAD)

  # 3. 새 정식 태그 (버전 정렬 기준 lastTag 다음)
  $all = @(G tag --list 'v*' --sort=v:refname | Where-Object { $_ -notmatch '-rc|mobile-' })
  $idx = [Array]::IndexOf($all, $st.lastTag)
  if ($idx -lt 0) { $notes.Add("lastTag $($st.lastTag) 를 태그 목록에서 못 찾음 — 새 태그 판별 불가"); $newTags = @() }
  else { $newTags = @($all | Select-Object -Skip ($idx + 1)) }
  $commitCount = [int](G rev-list --count "$($st.lastCommit)..HEAD")

  # 4. 릴리스 노트
  $relBodies = @{}
  $notesOk = $false
  if ($newTags.Count -gt 0) {
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'ara-orca-watch'; Accept = 'application/vnd.github+json' } `
        -Uri 'https://api.github.com/repos/stablyai/orca/releases?per_page=50'
      foreach ($r in $rel) { $relBodies[$r.tag_name] = $r.body }
      $notesOk = $true
    } catch { $notes.Add("릴리스 노트 못 받음: $($_.Exception.Message)") }
  }

  # 5. 이식 기능별 변경
  $featSec = New-Object Text.StringBuilder
  $affected = 0; $mapState = '없음(건너뜀)'
  $map = $null
  if ((Test-Path $PortMap) -and (Get-Item $PortMap).Length -gt 2) {
    # PS 5.1 의 ConvertFrom-Json 은 배열을 항목 하나로 내보낸다 — ForEach-Object 로 한 번 풀어야 기능별로 돈다.
    try { $map = @((Get-Content $PortMap -Raw -Encoding UTF8 | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { $notes.Add("port-map 파싱 실패: $($_.Exception.Message)") }
  }
  if ($map -and $map.Count -gt 0) {
    $mapState = "$($map.Count)개"
    foreach ($f in $map) {
      $paths = @($f.orcaPaths)
      $ref = $f.orcaRef
      [void]$featSec.AppendLine("### $($f.id) — $($f.feature)  (status: $($f.status), orcaRef: $ref)")
      $missing = @($paths | Where-Object { $null = G cat-file -e "HEAD:$_"; $rc -ne 0 })
      foreach ($m in $missing) { [void]$featSec.AppendLine("- **경로 사라짐(이름 변경·삭제 의심)**: ``$m``") }
      $null = G cat-file -e "$ref^{commit}"
      if ($rc -ne 0) { [void]$featSec.AppendLine("- orcaRef ``$ref`` 를 찾을 수 없음"); [void]$featSec.AppendLine(''); continue }
      $sa = @('diff', '--stat', "$ref..HEAD", '--') + $paths   # '--' 는 배열로 넘겨야 함수 호출에서 안 먹힘
      $la = @('log', '--oneline', "$ref..HEAD", '--') + $paths
      $stat = @(G @sa)
      $log = @(G @la)
      if ($stat.Count -gt 0 -or $log.Count -gt 0 -or $missing.Count -gt 0) { $affected++ }
      if ($log.Count -eq 0 -and $missing.Count -eq 0) { [void]$featSec.AppendLine('- 변경 없음'); [void]$featSec.AppendLine(''); continue }
      [void]$featSec.AppendLine("커밋 $($log.Count)개:")
      [void]$featSec.AppendLine('```')
      foreach ($l in ($log | Select-Object -First 40)) { [void]$featSec.AppendLine($l) }
      if ($log.Count -gt 40) { [void]$featSec.AppendLine("... 외 $($log.Count - 40)개") }
      [void]$featSec.AppendLine('```')
      [void]$featSec.AppendLine('```'); foreach ($l in $stat) { [void]$featSec.AppendLine($l) }; [void]$featSec.AppendLine('```'); [void]$featSec.AppendLine('')
    }
  }

  # 5b. herdr (herdrdev/herdr) — 상태는 같은 state.json 의 herdr 키. 실패해도 Orca 보고는 살린다.
  $hSec = New-Object Text.StringBuilder
  $hNotes = New-Object Collections.Generic.List[string]
  $hTags = @(); $hCount = 0; $hHead = ''; $hLastTag = 'v0.9.5'; $hLastCommit = 'ee5bfb5041'
  try {
    if ($st.PSObject.Properties['herdr']) { $hLastTag = $st.herdr.lastTag; $hLastCommit = $st.herdr.lastCommit }
    if (-not $DryRun) {
      $o = HGE fetch --tags origin
      if ($rc -ne 0) { $hNotes.Add("fetch 실패 (rc=$rc): $($o -join ' ')") }
      else {
        if (HG status --porcelain --untracked-files=no) { $hNotes.Add('로컬 변경이 있어 merge 를 건너뜀 (fast-forward 중단).') }
        else {
          $o = HGE merge --ff-only origin/master
          if ($rc -ne 0) { $hNotes.Add("ff-only merge 실패 (rc=$rc): $($o -join ' ')") }
        }
      }
    }
    $hHead = (HG rev-parse --short=10 HEAD)
    if ((HG rev-parse --is-shallow-repository) -eq 'true') { $hNotes.Add('클론이 shallow — 이력 비교 불가 (git fetch --unshallow 필요)') }
    $hAll = @(HG tag --list 'v*' --sort=v:refname | Where-Object { $_ -notmatch '-' })
    $hi = [Array]::IndexOf($hAll, $hLastTag)
    if ($hi -lt 0) { $hNotes.Add("lastTag $hLastTag 를 태그 목록에서 못 찾음 — 새 태그 판별 불가") }
    else { $hTags = @($hAll | Select-Object -Skip ($hi + 1)) }
    $null = HG cat-file -e "$hLastCommit^{commit}"
    if ($rc -ne 0) { $hNotes.Add("lastCommit $hLastCommit 를 찾을 수 없음") }
    else {
      $hCount = [int](HG rev-list --count "$hLastCommit..HEAD")
      $hRel = @{}; $hRelOk = $false
      if ($hTags.Count -gt 0) {
        try {
          [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
          foreach ($r in (Invoke-RestMethod -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'ara-orca-watch'; Accept = 'application/vnd.github+json' } `
            -Uri 'https://api.github.com/repos/herdrdev/herdr/releases?per_page=50')) { $hRel[$r.tag_name] = $r.body }
          $hRelOk = $true
        } catch { $hNotes.Add("릴리스 노트 못 받음: $($_.Exception.Message)") }
      }
      # 가져오기로 한 경로 (herdr-research-done.md 4장). 상태 감지 규칙이 가장 중요해 첫머리에.
      $hMap = @(
        @{ n = '상태 감지 규칙·판정 (manifests/*.toml 이 핵심)'; p = @('src/detect') },
        @{ n = '화면 판정 평가'; p = @('src/agent_view_eval.rs') },
        @{ n = '워크트리'; p = @('src/worktree.rs', 'src/app/api/worktrees.rs', 'src/app/api/worktrees') },
        @{ n = '영속화·복원'; p = @('src/persist', 'src/persist.rs', 'src/agent_resume.rs') },
        @{ n = '원격(SSH)'; p = @('src/remote', 'src/remote.rs') },
        @{ n = '원격 브리지·클립보드 이미지'; p = @('src/platform/remote_bridge.rs', 'src/server/clipboard_image.rs') },
        @{ n = 'SSH agent 포워딩'; p = @('src/platform/ssh_agent.rs', 'src/remote/ssh_agent.rs') },
        @{ n = '소켓 API (agent wait 등)'; p = @('src/app/api/agents.rs', 'src/app/api/panes.rs', 'src/api/server.rs') },
        @{ n = '한글 IME 전환'; p = @('src/client/shell/input_source.rs') }
      )
      # manifests 는 따로 한 번 더 — 규칙 파일 변경만 모아 본다.
      $hMap = @(@{ n = '상태 감지 매니페스트 src/detect/manifests/ (가져다 쓰는 규칙 파일)'; p = @('src/detect/manifests') }) + $hMap
      foreach ($f in $hMap) {
        [void]$hSec.AppendLine("### $($f.n)")
        $miss = @($f.p | Where-Object { $null = HG cat-file -e "HEAD:$_"; $rc -ne 0 })
        foreach ($m in $miss) { [void]$hSec.AppendLine("- **경로 사라짐(이름 변경·삭제 의심)**: ``$m``") }
        $la = @('log', '--oneline', "$hLastCommit..HEAD", '--') + $f.p
        $sa = @('diff', '--stat', "$hLastCommit..HEAD", '--') + $f.p
        $lg = @(HG @la); $stt = @(HG @sa)
        if ($lg.Count -eq 0 -and $miss.Count -eq 0) { [void]$hSec.AppendLine('- 변경 없음'); [void]$hSec.AppendLine(''); continue }
        [void]$hSec.AppendLine("커밋 $($lg.Count)개:"); [void]$hSec.AppendLine('```')
        foreach ($l in ($lg | Select-Object -First 40)) { [void]$hSec.AppendLine($l) }
        if ($lg.Count -gt 40) { [void]$hSec.AppendLine("... 외 $($lg.Count - 40)개") }
        [void]$hSec.AppendLine('```'); [void]$hSec.AppendLine('```')
        foreach ($l in $stt) { [void]$hSec.AppendLine($l) }
        [void]$hSec.AppendLine('```'); [void]$hSec.AppendLine('')
      }
      [void]$hSec.AppendLine('### CHANGELOG.md 새 부분 (추가된 줄)')
      $cl = @(HG diff -U0 "$hLastCommit..HEAD" -- CHANGELOG.md | Where-Object { $_ -match '^\+' -and $_ -notmatch '^\+\+\+' } | ForEach-Object { $_.Substring(1) })
      if ($cl.Count -eq 0) { [void]$hSec.AppendLine('(변경 없음)') } else { [void]$hSec.AppendLine('```'); foreach ($l in $cl) { [void]$hSec.AppendLine($l) }; [void]$hSec.AppendLine('```') }
      [void]$hSec.AppendLine('')
      [void]$hSec.AppendLine('### GitHub 릴리스 노트 (새 정식 태그)')
      if ($hTags.Count -eq 0) { [void]$hSec.AppendLine('(새 정식 태그 없음)') }
      foreach ($t in $hTags) {
        [void]$hSec.AppendLine("#### $t")
        if (-not $hRelOk) { [void]$hSec.AppendLine('(노트 못 받음)') }
        elseif ($hRel.ContainsKey($t) -and $hRel[$t]) { [void]$hSec.AppendLine($hRel[$t].Trim()) }
        else { [void]$hSec.AppendLine('(릴리스 노트 없음 — 최근 50개 밖이거나 본문 비어 있음)') }
        [void]$hSec.AppendLine('')
      }
    }
  } catch { $hNotes.Add("herdr 절 오류: $($_.Exception.Message)") }

  # 6. 보고서
  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine("# Orca 주간 점검 — $today$(if ($DryRun) {' (DryRun)'})")
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## 요약')
  [void]$sb.AppendLine("- 새 정식 판: $($newTags.Count)개 $(if ($newTags.Count) { '(' + ($newTags -join ', ') + ')' })")
  [void]$sb.AppendLine("- 새 커밋: ${commitCount}개 ($($st.lastCommit) -> $head)")
  [void]$sb.AppendLine("- 이식 기능 중 영향: ${affected}개 (port-map: $mapState)")
  foreach ($n in $notes) { [void]$sb.AppendLine("- 주의: $n") }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('## 이식 기능별 변경')
  if ($featSec.Length -gt 0) { [void]$sb.Append($featSec.ToString()) } else { [void]$sb.AppendLine("(port-map 없음 또는 비어 있음 — 건너뜀)"); [void]$sb.AppendLine('') }
  [void]$sb.AppendLine('## 새 판 노트 원문')
  if ($newTags.Count -eq 0) { [void]$sb.AppendLine('(새 판 없음)'); [void]$sb.AppendLine('') }
  foreach ($t in $newTags) {
    [void]$sb.AppendLine("### $t")
    if (-not $notesOk) { [void]$sb.AppendLine('(노트 못 받음)') }
    elseif ($relBodies.ContainsKey($t) -and $relBodies[$t]) { [void]$sb.AppendLine($relBodies[$t].Trim()) }
    else { [void]$sb.AppendLine('(릴리스 노트 없음 — 최근 50개 밖이거나 본문 비어 있음)') }
    [void]$sb.AppendLine('')
  }
  [void]$sb.AppendLine('## herdr')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine("- 새 정식 태그: $($hTags.Count)개 $(if ($hTags.Count) { '(' + ($hTags -join ', ') + ')' })")
  [void]$sb.AppendLine("- 새 커밋: ${hCount}개 ($hLastCommit -> $hHead)")
  foreach ($n in $hNotes) { [void]$sb.AppendLine("- 주의: $n") }
  [void]$sb.AppendLine('')
  [void]$sb.Append($hSec.ToString())
  [void]$sb.AppendLine('## 분류 대기')
  [void]$sb.AppendLine('| 항목 | 반영 필요 | 새 후보 | 무관 | 메모 |')
  [void]$sb.AppendLine('|---|---|---|---|---|')
  [void]$sb.AppendLine('| | | | | |')
  Save (Join-Path $OutDir "$today.md") $sb.ToString()

  # 7. state 갱신
  if (-not $DryRun) {
    $newLast = if ($newTags.Count) { $newTags[-1] } else { $st.lastTag }
    # herdr 가 실패(fetch·태그 판별)하면 옛 값을 유지해 다음 주에 다시 잡는다.
    $hNewTag = if ($hTags.Count) { $hTags[-1] } else { $hLastTag }
    $hNewCommit = if ($hHead -and $hNotes.Count -eq 0) { $hHead } else { $hLastCommit }
    Save $StateFile (([pscustomobject]@{ lastTag = $newLast; lastCommit = $head; lastRun = (Get-Date).ToString('s'); herdr = [pscustomobject]@{ lastTag = $hNewTag; lastCommit = $hNewCommit } }) | ConvertTo-Json)
  }
  if (Test-Path $errFile) { Remove-Item $errFile -Force }
}
catch {
  $msg = "$(Get-Date -Format s) $($_.Exception.Message)`r`n$($_.ScriptStackTrace)"
  Save $errFile $msg
  Save (Join-Path $OutDir "$today.md") "# Orca 주간 점검 — $today`r`n`r`n## 오류`r`n`r`n``````r`n$msg`r`n``````r`n"
  exit 1
}
