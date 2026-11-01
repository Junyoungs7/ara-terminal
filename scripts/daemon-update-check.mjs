/**
 * M4 R3 — **업데이트 흐름에서도 에이전트 데몬이 사는가**를 설치본으로 확인하는 도구(Windows). 실행은 사람이(메인) 한다.
 *
 * 왜 스크립트인가: 판 올림은 NSIS 설치기가 설치 폴더의 프로세스를 정리하고 파일을 바꾸는 일이라 e2e(앱만 띄움)로는 못 흉내 낸다.
 * 데몬은 설치 폴더 밖(%LOCALAPPDATA%\ARA\daemon-host\<판>)에서 돌아 그 정리를 피한다 — 이 도구는 그 사실을 앞뒤 PID 로 잰다.
 * 판 판정(같은 protocol 유지·옛 판 교체·모르는 판 무시) 자체는 단위 시험이 지킨다(tests/daemonService.test.ts '판 올림').
 *
 * 순서:
 *   1. 옛 판(예: 2.2.0) 설치본에서 AI 작업 공간 에이전트를 하나 띄운다(아무 일이나 시키거나 그냥 둔다).
 *   2. node scripts/daemon-update-check.mjs before
 *      → 데몬·그 자손(셸·에이전트) PID 와 실행 경로를 %TEMP%\ara-daemon-update-check.json 에 적는다.
 *   3. 새 판(예: 2.2.1)을 빌드해 dist 폴더를 로컬 피드로:  node scripts/local-update-feed.mjs dist
 *      옛 판을 피드로 띄운다:  set ARA_UPDATE_URL=http://127.0.0.1:8788/downloads/ && "<설치경로>\A.R.A.exe"
 *      상태 표시줄 ↑ → 내려받기 → 다시 시작해 설치(업데이트 설치 흐름 그대로).
 *   4. node scripts/daemon-update-check.mjs after
 *      → 같은 데몬 PID 가 살아 있고 자손(에이전트)도 살아 있으면 PASS. 새 앱이 그 탭을 되살렸는지는 화면에서 본다
 *        (같은 탭·같은 출력 — 판 판정이 adopt 면 같은 데몬, protocol 을 올린 판이면 옛 세션은 drain 으로 이어지고 새 세션은 새 데몬).
 *
 * 읽기만 한다 — 아무 프로세스도 끄거나 띄우지 않는다.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE = join(tmpdir(), 'ara-daemon-update-check.json')
const mode = process.argv[2]

if (process.platform !== 'win32' || (mode !== 'before' && mode !== 'after')) {
  console.error('쓰는 법(Windows): node scripts/daemon-update-check.mjs before|after')
  process.exit(2)
}

/** 프로세스 표(pid·ppid·실행 경로·명령줄). */
function procs() {
  const ps =
    "$ProgressPreference='SilentlyContinue';" +
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CommandLine | ' +
    'Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  const out = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, exe: p.ExecutablePath ?? '', cmd: p.CommandLine ?? '' }))
}

function snapshot() {
  const all = procs()
  const daemons = all.filter((p) => p.cmd.includes('daemonEntry') && p.cmd.includes('--socket'))
  const kids = (root) => {
    const out = []
    const stack = [root]
    while (stack.length) {
      const pid = stack.pop()
      for (const c of all.filter((p) => p.ppid === pid)) {
        out.push({ pid: c.pid, exe: c.exe })
        stack.push(c.pid)
      }
    }
    return out
  }
  return daemons.map((d) => ({ pid: d.pid, exe: d.exe, outsideInstall: /\\ARA\\daemon-host\\/i.test(d.exe), children: kids(d.pid) }))
}

if (mode === 'before') {
  const s = snapshot()
  if (s.length === 0) {
    console.error('도는 데몬이 없습니다 — AI 작업 공간에서 에이전트를 먼저 띄우세요.')
    process.exit(1)
  }
  writeFileSync(STATE, JSON.stringify({ at: new Date().toISOString(), daemons: s }, null, 2))
  for (const d of s) {
    console.log(`데몬 ${d.pid}  ${d.exe}`)
    console.log(`  설치 폴더 밖(daemon-host): ${d.outsideInstall ? '예' : '아니오 — 이 판은 업데이트 때 데몬이 같이 죽을 수 있다(복사 실패·dev 실행)'}`)
    console.log(`  자손 ${d.children.length}개: ${d.children.map((c) => c.pid).join(', ')}`)
  }
  console.log(`\n적었다: ${STATE}\n이제 업데이트를 설치하고 'after' 를 돌리세요.`)
} else {
  if (!existsSync(STATE)) {
    console.error(`'before' 를 먼저 돌리세요(${STATE} 없음).`)
    process.exit(1)
  }
  const before = JSON.parse(readFileSync(STATE, 'utf8'))
  const alive = new Set(procs().map((p) => p.pid))
  let ok = true
  for (const d of before.daemons) {
    const kidsAlive = d.children.filter((c) => alive.has(c.pid))
    const daemonOk = alive.has(d.pid)
    ok &&= daemonOk && kidsAlive.length === d.children.length
    console.log(`데몬 ${d.pid}: ${daemonOk ? '살아 있음' : '죽음'} · 자손 ${kidsAlive.length}/${d.children.length} 살아 있음`)
  }
  const now = snapshot()
  for (const d of now.filter((x) => !before.daemons.some((b) => b.pid === x.pid))) console.log(`새 데몬 ${d.pid}  ${d.exe}  (protocol 을 올린 판이면 새 세션용으로 정상)`)
  console.log(ok ? '\nPASS — 업데이트 뒤에도 데몬과 에이전트가 살아 있다.' : '\nFAIL — 업데이트가 데몬이나 에이전트를 끝냈다. 앱 로그 폴더의 agent-daemon.log 를 보세요.')
  process.exit(ok ? 0 : 1)
}
