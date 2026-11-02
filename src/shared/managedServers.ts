// M8 DM-02·03 관리형 서버(orcad) — main·렌더러가 같이 쓰는 순수 규칙: 원격 명령 글, 그 출력 읽기, 동의·업데이트·제거 검증 판정.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/managed-server/{install/orcad-remote-host-support,lifecycle/orcad-managed-update-decision,
// install/orcad-remote-decommission}.ts — 핵심만(판정 규칙). Orca 의 Node 런타임 배포·활성화 트랜잭션·롤백·GC 는 뺐다(아래 host.ts 머리 주석).
//
// 원칙(m8-r1 지시서): 터미널 공간은 서버에 아무것도 깔지 않는다. orcad 는 AI 공간에서 **호스트별 동의를 받은 서버에만**,
// 사용자 홈 아래 한 폴더에, 사용자 권한으로만(root·sudo·systemd·crontab 없음). 제거하면 흔적 0 — 그것을 원격에서 재서 확인한다.

/** 설치 폴더 — 원격 사용자 홈 아래 이 이름 하나. SFTP 는 홈 기준 상대 경로, exec 은 "$HOME/…". */
export const MANAGED_DIR = '.ara-server'
/** orcad.py 가 쓰는 최소 파이썬(selectors·os.set_blocking·subprocess.DEVNULL — RHEL 7 의 3.6 까지). */
export const MANAGED_MIN_PYTHON: readonly [number, number] = [3, 6]
/** 원격에서 무엇이든 표시할 때 쓰는 홈 표기. */
export const managedDirShown = `~/${MANAGED_DIR}`

/** 설치하는 파일(동의 화면에 그대로 보인다). orcad.py 크기는 부르는 쪽이 채운다. */
export const MANAGED_FILES = ['orcad.py', 'token', 'version'] as const
/** 돌 때만 생기는 파일(모두 설치 폴더 안 — 제거하면 함께 사라진다). agent.sock 은 SSH agent 포워딩을 켠 연결의 에이전트를 가리키는 링크(M15 R2 TM-05). */
export const MANAGED_RUNTIME_FILES = ['orcad.sock', 'orcad.pid', 'orcad.log', 'agent.sock'] as const
/** 원격 프로세스에 붙는 표식(환경 변수) — 제거 검증이 이것으로 "아라가 띄운 것"을 센다. orcad.py 의 MARK 와 같아야 한다. */
export const MANAGED_MARK = 'ARA_ORCAD_HOME'

// ── 원격 명령 ── 모두 `sh -c '<글>'` 로 보낸다(로그인 셸이 fish·csh 여도 같은 문법). 사용자 값은 끼우지 않는다 — 고정 글뿐.
const D = `D="$HOME/${MANAGED_DIR}"`

/** 플랫폼·파이썬·설치된 판 묻기. 출력은 key=value 줄(parseProbe). */
export const PROBE_SCRIPT = [
  `printf 'os=%s\\narch=%s\\nhome=%s\\n' "$(uname -s)" "$(uname -m)" "$HOME"`,
  `P=$(command -v python3 2>/dev/null)`,
  `printf 'python=%s\\n' "$P"`,
  // 판을 먼저 찍고, 필요한 모듈을 불러 본다(못 부르면 pymods 줄이 없다 → 지원 안 함).
  `[ -n "$P" ] && "$P" -c 'import sys;print("pyver=%d.%d"%sys.version_info[:2]);import pty,termios,fcntl,selectors;print("pymods=1")' 2>/dev/null`,
  D,
  `[ -f "$D/version" ] && printf 'installed=%s\\n' "$(cat "$D/version")"`,
  `true`
].join('\n')

/** 설치 폴더 만들기(본인만 읽고 쓰게 700). */
export const MKDIR_SCRIPT = `${D}; mkdir -p "$D" && chmod 700 "$D"`
/** 파일을 올린 뒤 권한·자가 시험. 마지막 줄이 protocol=N 이면 됐다. */
export const FINISH_SCRIPT = `${D}; chmod 600 "$D/token" "$D/version" && chmod 700 "$D/orcad.py" && python3 "$D/orcad.py" version`
/** 아라 쪽 연결 다리(stdin/stdout ↔ 원격 유닉스 소켓). 데몬이 없으면 띄운다. */
export const BRIDGE_SCRIPT = `exec python3 "$HOME/${MANAGED_DIR}/orcad.py" connect`

/**
 * 남은 것 재기. 아라가 띄운 프로세스 = 환경에 표식이 있거나 명령줄에 설치 경로의 orcad.py 가 든 것($$ — 이 셸 — 는 뺀다).
 * crontab·systemd 는 애초에 쓰지 않지만, "흔적 0"을 말하려면 재야 한다(부재는 양성 대조가 필요하다 — 시험이 그것을 한다).
 */
export const VERIFY_SCRIPT = [
  D,
  `[ -e "$D" ] && echo dir=yes || echo dir=no`,
  `n=0; for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue;`,
  `  if tr '\\000' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "${MANAGED_MARK}=$D" || tr '\\000' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "$D/orcad.py"; then n=$((n+1)); fi`,
  `done; echo proc=$n`,
  `echo cron=$(crontab -l 2>/dev/null | grep -c "${MANAGED_DIR}")`,
  `echo systemd=$(ls "$HOME/.config/systemd/user" 2>/dev/null | grep -ci ara-)`
].join('\n')

/**
 * 제거: 데몬을 끄고(SIGTERM → 데몬이 세션을 끝낸다 → 기다림 → 안 끝나면 KILL), 표식 달린 남은 프로세스를 끝내고, 폴더를 지운다. 이어서 VERIFY.
 * 표식은 orcad 가 띄운 셸·에이전트에게만 물려진다 — 사용자가 따로 띄운 프로세스는 건드리지 않는다.
 */
export const UNINSTALL_SCRIPT = [
  D,
  `if [ -f "$D/orcad.pid" ]; then P=$(cat "$D/orcad.pid"); kill -TERM "$P" 2>/dev/null; i=0; while kill -0 "$P" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL "$P" 2>/dev/null; fi`,
  // 다른 PC 의 아라가 열어 둔 다리(orcad.py connect)도 — 명령줄에 설치 경로가 든다.
  `for p in /proc/[0-9]*; do q=\${p#/proc/}; [ "$q" = "$$" ] && continue; if tr '\\000' '\\n' < "$p/environ" 2>/dev/null | grep -qxF "${MANAGED_MARK}=$D" || tr '\\000' ' ' < "$p/cmdline" 2>/dev/null | grep -qF "$D/orcad.py"; then kill -KILL "$q" 2>/dev/null; fi; done`,
  `rm -rf "$D"`,
  VERIFY_SCRIPT
].join('\n')

/** 동의 화면에 보여 주는 "직접 지우는 법"(앱이 없을 때). */
export const MANUAL_REMOVE = `kill $(cat ~/${MANAGED_DIR}/orcad.pid) 2>/dev/null; rm -rf ~/${MANAGED_DIR}`

// ── 출력 읽기 ──
const kv = (out: string): Map<string, string> => {
  const m = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return m
}

export type ManagedProbe = { os: string; arch: string; home: string; python: string; pyver: string; pymods: boolean; installed: string | null }

export function parseProbe(out: string): ManagedProbe {
  const m = kv(out)
  return { os: m.get('os') ?? '', arch: m.get('arch') ?? '', home: m.get('home') ?? '', python: m.get('python') ?? '', pyver: m.get('pyver') ?? '', pymods: m.get('pymods') === '1', installed: m.get('installed') || null }
}

/** 지원 판정. Linux 만(사내 서버 — x64 우선, 스크립트라 arm64 도 돈다). 나머지는 "지원 안 함"을 이유와 함께. */
export type ManagedSupport = { ok: true } | { ok: false; reason: 'os' | 'python' | 'pythonOld' | 'pythonModules' }

export function supportOf(p: ManagedProbe): ManagedSupport {
  if (p.os !== 'Linux') return { ok: false, reason: 'os' }
  if (!p.python) return { ok: false, reason: 'python' }
  const [maj, min] = p.pyver.split('.').map(Number)
  if (!(maj > MANAGED_MIN_PYTHON[0] || (maj === MANAGED_MIN_PYTHON[0] && min >= MANAGED_MIN_PYTHON[1]))) return { ok: false, reason: 'pythonOld' }
  if (!p.pymods) return { ok: false, reason: 'pythonModules' }
  return { ok: true }
}

// ── 판 비교·업데이트 판정(Orca planManagedOrcadAutoUpdate 의 핵심: 같으면 그대로, 낮추지 않는다) ──
/** 점으로 나눈 숫자 비교(앞 숫자만 — `2.11.0-beta` 의 꼬리는 무시). */
export function versionCmp(a: string, b: string): number {
  const n = (v: string): number[] => v.split('-')[0].split('.').map((x) => parseInt(x, 10) || 0)
  const x = n(a)
  const y = n(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * - `install`: 동의했는데 설치가 없다(처음·사용자가 손으로 지움).
 * - `current`: 같은 판.
 * - `keepNewer`: 서버 쪽이 더 새 판(다른 PC 의 새 아라가 깔았다) — 낮추지 않는다(Orca refuseOrcadHostDowngrade). 말(protocol)은 같아 그대로 쓴다.
 * - `defer`: 바꿔야 하지만 돌고 있는 에이전트가 있다 — 끝난 뒤 다음 연결 때.
 * - `update`: 바꾼다.
 */
export type ManagedUpdateDecision = 'install' | 'current' | 'keepNewer' | 'defer' | 'update'

export function decideUpdate(o: { installed: string | null; app: string; liveSessions: number }): ManagedUpdateDecision {
  if (!o.installed) return 'install'
  const c = versionCmp(o.installed, o.app)
  if (c === 0) return 'current'
  if (c > 0) return 'keepNewer'
  return o.liveSessions > 0 ? 'defer' : 'update'
}

// ── 제거 검증 ──
/** 남은 것 이름: dir(설치 폴더) · proc:N(프로세스 수) · cron:N · systemd:N · unknown:<키>(못 잼 — 없다고 말하지 않는다). */
export function remnantsOf(out: string): string[] {
  const m = kv(out)
  const left: string[] = []
  const dir = m.get('dir')
  if (dir === undefined) left.push('unknown:dir')
  else if (dir !== 'no') left.push('dir')
  for (const k of ['proc', 'cron', 'systemd'] as const) {
    const v = m.get(k)
    const n = v === undefined || v === '' ? NaN : Number(v)
    if (!Number.isFinite(n)) left.push(`unknown:${k}`)
    else if (n > 0) left.push(`${k}:${n}`)
  }
  return left
}

// ── 동의 기록 ──
/** 호스트 열쇠 — 같은 서버라도 다른 계정이면 다른 홈이라 따로 동의한다. */
export const hostKeyOf = (p: { username: string; host: string; port: number }): string => `${p.username}@${p.host}:${p.port}`

export type ManagedState = 'installed' | 'deferred' | 'failed' | 'missing'
export type ManagedRecord = {
  hostKey: string
  /** 동의한 때(ISO). 기록이 있다 = 동의했다. 철회 = 제거(기록도 지운다). */
  consentedAt: string
  /** 서버에 깔린 판(마지막으로 본 것). */
  version: string | null
  state: ManagedState
  checkedAt: string
  /** 실패·미룸 사유(사람이 읽는 글). */
  note?: string
}

export type ManagedConsent = 'none' | 'consented'
export const consentOf = (records: readonly ManagedRecord[], hostKey: string): ManagedConsent => (records.some((r) => r.hostKey === hostKey) ? 'consented' : 'none')

/** 동의 화면 내용 — 무엇을(파일·크기), 어디에(폴더), 무엇이 상주(프로세스·소켓), 지우는 법. */
export type ManagedConsentPlan = {
  hostKey: string
  support: ManagedSupport
  probe: ManagedProbe
  dir: string
  files: { path: string; bytes: number }[]
  runtimeFiles: string[]
  /** 상주 프로세스 명령줄(사람이 ps 로 볼 모양). */
  process: string
  socket: string
  manualRemove: string
}

export function consentPlan(hostKey: string, probe: ManagedProbe, scriptBytes: number, tokenBytes: number, versionBytes: number): ManagedConsentPlan {
  const dir = probe.home ? `${probe.home}/${MANAGED_DIR}` : managedDirShown
  const bytes = { 'orcad.py': scriptBytes, token: tokenBytes, version: versionBytes }
  return {
    hostKey,
    support: supportOf(probe),
    probe,
    dir,
    files: MANAGED_FILES.map((f) => ({ path: `${dir}/${f}`, bytes: bytes[f] })),
    runtimeFiles: MANAGED_RUNTIME_FILES.map((f) => `${dir}/${f}`),
    process: `python3 ${dir}/orcad.py serve`,
    socket: `${dir}/orcad.sock`,
    manualRemove: MANUAL_REMOVE
  }
}
