// F26 서버 콘솔 — 원격에서 돌릴 수 있는 **명령의 전체 목록**과 그 출력 파서.
//
// 왜 표인가(이 파일이 이 기능의 보안 경계다):
// 지금까지 이 앱의 원격 exec 는 전부 main 에 하드코딩된 고정 명령이었다. RemoteTelemetry.ts 에
// "렌더러가 명령을 넘길 수 있는 경로는 없다(임의 실행 금지)"라고 못박혀 있고, F23 은 MCP
// `session_create` 의 `shell` 자유 문자열을 보안 결함(S1)으로 판정해 들어냈다.
//
// 서버 콘솔은 렌더러가 "무엇을 실행할지" 고르는 첫 기능이라 그 선을 건드린다. 그래서 넘기는 것은
// **명령 문자열이 아니라 id** 다. 문자열 조립은 전부 여기서 하고, 인자는 타입별 화이트리스트를
// 통과한 것만 쓴다. 이 규칙이 무너지면 SSH 세션이 임의 원격 실행 채널이 된다.
//
// build() 가 검증에 실패하면 **null 을 돌려준다** — 예외를 던지지 않는 이유는, 던진 예외는 위쪽
// try/catch 에 삼켜져 "조용히 아무 일도 안 일어남"이 되기 쉬운데, null 은 호출측이 반드시 분기해야
// 하기 때문이다(타입이 강제한다).
//
// 파서는 전부 순수 함수다 — 배포판마다 출력이 달라 실제 샘플로 단위 테스트한다(tests/remoteCatalog.test.ts).

import { validCliBin } from './aiCli'

/** 실행 가능한 명령 id. 이 목록 밖은 존재하지 않는다. */
export type CmdId =
  | 'ps.list'
  | 'ps.kill'
  | 'svc.list'
  | 'svc.action'
  | 'disk.usage'
  | 'disk.du'
  // F27: 이 서버에 그 AI CLI 가 설치돼 있나. 실행 전에 물어 본다.
  | 'which.cli'
  // F26 R3: 런치패드 머리에 얹는 서버 정체(배포판·커널·가동 시간). 자원 사용량은 F29 사이드바 몫이다.
  | 'sys.overview'
  // F26 R3: 설치된 프로그램·버전·설치일. 목록은 아래 PROBE_BINS 고정 표 — 렌더러가 정할 수 없다.
  | 'pkg.probe'
  // F28: 컨테이너 목록(docker → 없으면 podman).
  | 'ctr.list'
  // F28 R2: 컨테이너 상태 바꾸기·지우기 / 이미지 지우기. 전부 확인 다이얼로그를 거친다.
  | 'ctr.action'
  | 'ctr.rmi'

export type ProcRow = {
  pid: number
  user: string
  cpu: number
  mem: number
  rssKb: number
  /** ps 의 STAT — R(실행) S(대기) Z(좀비) 등. 좀비를 눈에 띄게 하려고 싣는다. */
  stat: string
  /** 켜진 지 몇 초. "방금 뜬 프로세스"를 찾을 때 쓴다. */
  elapsedSec: number
  /** 전체 명령줄. 목록에는 앞부분만 보여 주고 툴팁으로 전문을 준다. */
  cmd: string
}

export type SvcRow = {
  unit: string
  /** loaded / not-found / masked … */
  load: string
  /** active / inactive / failed */
  active: string
  /** running / exited / dead / failed */
  sub: string
  desc: string
}

export type DiskRow = {
  filesystem: string
  type: string
  totalKb: number
  usedKb: number
  availKb: number
  usePct: number
  mount: string
}

/** du -x -d1 한 줄 — 폴더별 사용량. */
export type DirUsage = { kb: number; path: string }

// ── 인자 검증 ────────────────────────────────────────────────────────────────
// 통과한 값만 명령줄에 들어간다. 여기서 막지 못한 것은 원격 셸이 그대로 해석한다.

/** PID 는 1 이상의 정수만. 0·음수는 kill(2) 에서 **프로세스 그룹 전체**를 뜻해 치명적이다. */
export function validPid(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4_194_304) return null
  return v
}

/**
 * systemd 유닛 이름. 셸 메타문자가 하나라도 있으면 거절한다 —
 * 인용으로 막는 대신 아예 안 받는다(인용은 한 겹 실수하면 뚫린다).
 */
export function validUnit(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 255) return null
  // 하이픈은 맨 뒤에 둬야 범위(-)가 아니라 글자로 읽힌다. 백슬래시는 **일부러 뺐다** —
  // 주입까지는 아니어도 `a\ b` 처럼 인자 경계를 흔들 수 있어 받을 이유가 없다.
  return /^[A-Za-z0-9@._-]+$/.test(v) ? v : null
}

/** kill 로 보낼 시그널 — 두 개만 연다. -9 는 마지막 수단이라 UI 가 따로 물어본다. */
export type KillSignal = 'TERM' | 'KILL'
export function validSignal(v: unknown): KillSignal | null {
  return v === 'TERM' || v === 'KILL' ? v : null
}

/** systemctl 로 할 수 있는 일 — 이 셋뿐. enable/disable 은 부팅 동작을 바꿔 v1 에서 뺀다. */
export type SvcAction = 'start' | 'stop' | 'restart'
export function validSvcAction(v: unknown): SvcAction | null {
  return v === 'start' || v === 'stop' || v === 'restart' ? v : null
}

/**
 * 절대 경로 하나. 작은따옴표로 감싸 넘기므로 **작은따옴표가 든 경로는 거절**한다
 * (이스케이프로 살리는 것보다 못 쓰는 편이 안전하다 — 그런 경로는 실무에 거의 없다).
 * 개행·NUL 도 거절: 한 줄짜리 명령에 줄을 하나 더 끼워 넣는 고전적인 수법이다.
 */
export function validAbsPath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > 4096) return null
  // eslint-disable-next-line no-control-regex
  return /['\r\n ]/.test(v) ? null : v
}

/**
 * 컨테이너 id. `--no-trunc` 로 받은 64자 16진수이고, 목록에 없던 값은 애초에 화면이 만들 수 없다.
 * **이름을 받지 않는 이유**: 컨테이너 이름은 `/` 같은 글자를 허용하고 서버마다 규칙이 달라
 * 검증이 헐거워진다. id 는 16진수 하나로 끝나 뚫릴 자리가 없다.
 */
export function validCtrId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return /^[0-9a-f]{12,64}$/.test(v) ? v : null
}

/** 컨테이너에 할 수 있는 일. `rm -f` 는 없다 — 돌고 있으면 먼저 멈추게 한다(화면이 그렇게 막는다). */
export type CtrAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'rm'
const CTR_ACTIONS: readonly CtrAction[] = ['start', 'stop', 'restart', 'pause', 'unpause', 'rm']
export function validCtrAction(v: unknown): CtrAction | null {
  return CTR_ACTIONS.includes(v as CtrAction) ? (v as CtrAction) : null
}

/**
 * 이미지 참조(`nginx:1.24-alpine` · `reg.사내:5000/team/app@sha256:…`).
 * 셸 메타문자를 **하나도** 허용하지 않으므로 인용 없이 그대로 붙여도 안전하다 — 유닛 이름과 같은 방식이다.
 */
export function validImageRef(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 255) return null
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(v) ? v : null
}

/**
 * 컨테이너 런타임 고르기 — docker 가 있으면 docker, 없으면 podman. CLI 가 호환이라 인자는 그대로 통한다.
 * 목록과 조작이 **같은 런타임**을 타야 한다(목록은 podman 인데 조작은 docker 로 나가면 "없는 컨테이너"가 된다).
 */
function ctrCmd(args: string): string {
  return (
    `if command -v docker >/dev/null 2>&1; then docker ${args} 2>&1; ` +
    `elif command -v podman >/dev/null 2>&1; then podman ${args} 2>&1; fi`
  )
}

/**
 * 컨테이너 안으로 들어가는 명령 — **이것만 exec 채널이 아니라 터미널로 간다**(`session.input`).
 * `docker exec -it` 는 대화형이라 일회성 exec 으로는 쓸 수 없다: 화면도 키보드도 없다.
 * F27 AI CLI 실행이 쓰는 길과 같다(사람이 타이핑하는 것과 같은 채널).
 *
 * bash 가 없는 이미지(alpine 등)가 흔해 먼저 있는지 보고 없으면 sh 로 떨어진다.
 * 런타임은 `command -v` 두 개로 그 자리에서 고른다 — 터미널에는 우리 셸 상태가 없다.
 */
export function buildCtrExec(id: unknown): string | null {
  const cid = validCtrId(id)
  if (cid === null) return null
  return `$(command -v docker || command -v podman) exec -it ${cid} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
}

const q = (path: string): string => `'${path}'`

// F26 R3 개요 — 조각 사이 구분자. 출력에 우연히 섞이지 않을 만큼 특이해야 한다.
export const OVERVIEW_SEP = '--ARA-OV--'

/**
 * F26 R3 조사 대상 프로그램 — **고정 표**. 렌더러가 이름을 보낼 수 없다(그 이름이 그대로 원격에서
 * 실행된다). 사내에서 "깔려 있나"를 실제로 궁금해하는 것들만 골랐다. 셸 메타문자가 없는 순수
 * 이름이어야 하고, 그건 아래 어서션이 지킨다.
 */
export const PROBE_BINS = [
  'node',
  'npm',
  'pnpm',
  'yarn',
  'python3',
  'pip3',
  'java',
  'mvn',
  'gradle',
  'go',
  'rustc',
  'cargo',
  'git',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'nginx',
  'httpd',
  'psql',
  'mysql',
  'redis-server',
  'mongod',
  'pm2',
  'tmux',
  'vim',
  'curl',
  'jq'
] as const

// ── 파서 ─────────────────────────────────────────────────────────────────────

/**
 * `ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args=` 출력.
 *
 * 앞 7칸은 공백으로 갈리고 **나머지 전부가 명령줄**이다(명령줄에는 공백이 얼마든 들어간다).
 * 그래서 split 로 통째로 나누면 안 되고, 앞에서부터 7번만 끊어 낸다.
 */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[8].trim()
    if (cmd === '') continue
    rows.push({
      pid: Number(m[1]),
      user: m[2],
      cpu: Number(m[3]),
      mem: Number(m[4]),
      rssKb: Number(m[5]),
      stat: m[6],
      elapsedSec: Number(m[7]),
      cmd
    })
  }
  return rows
}

/**
 * `systemctl list-units --type=service --all --no-pager --plain --no-legend` 출력.
 *
 * 앞 4칸 뒤가 설명이다. 상태가 나쁜 유닛 앞에는 `●` 같은 표시가 붙어 나오므로 먼저 걷어낸다.
 * systemd 가 없는 서버는 stderr 가 stdout 에 섞여 들어오는데, 4칸 형태가 아니라 자연히 걸러진다.
 */
export function parseSystemctl(out: string): SvcRow[] {
  const rows: SvcRow[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/^[\s●*]+/, '').trimEnd()
    if (line.trim() === '') continue
    const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    rows.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], desc: m[5].trim() })
  }
  return rows
}

/** systemd 자체가 없는 서버인지 — 빈 목록과 "지원 안 함"은 다른 이야기라 구분해서 안내한다. */
export function systemdMissing(out: string): boolean {
  return /command not found|not found|Failed to (connect|get D-Bus)|Access denied/i.test(out)
}

/**
 * `df -PT` 출력. POSIX(-P) 라 한 줄에 한 항목이고, -T 로 타입 칸이 하나 더 붙는다.
 * 첫 줄은 헤더다. tmpfs·devtmpfs 같은 가상 파일시스템은 **여기서 거르지 않는다** — 무엇을 숨길지는
 * 화면이 정한다(숨기면 "왜 안 보이지"가 되고, 우리는 그걸 포트 모니터에서 이미 겪었다).
 */
export type Overview = {
  distro: string
  kernel: string
  os: string
  hostname: string
  /** 가동 시간(초). 못 읽으면 null — 0 으로 쓰면 "방금 켜짐"이라는 거짓말이 된다. */
  uptimeSec: number | null
}

/**
 * F26 R3 서버 개요. 조각이 없으면 그 칸만 빈다 — **하나가 없다고 전체를 실패로 만들지 않는다**.
 * /etc/os-release 가 없는 서버(구형·컨테이너·BSD)가 실제로 있어서, 그때는 uname 으로 떨어진다.
 */
export function parseOverview(out: string): Overview {
  const parts = out.split(OVERVIEW_SEP).map((p) => p.trim())
  const [distro = '', kernel = '', os = '', hostname = '', uptime = ''] = parts
  // /proc/uptime 첫 숫자가 초. 없는 서버면 null.
  const secs = Number.parseFloat(uptime.split(/\s+/)[0] ?? '')
  return {
    // 배포판 이름이 없으면 uname 으로 떨어뜨린다("알 수 없음"보다 "Linux"가 낫다).
    distro: distro || os || '',
    kernel,
    os,
    hostname,
    uptimeSec: Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : null
  }
}

export type PkgRow = {
  bin: string
  /** 실행 파일 경로. nvm 으로 깐 node 는 여기가 ~/.nvm/... 이다 — 패키지 목록엔 없는 것들이다. */
  path: string
  version: string
  /** 실행 파일 mtime(epoch ms). 패키지 설치일과 정확히 같지는 않다 — 화면이 그 사실을 밝힌다. */
  installedAt: number | null
}

/**
 * F26 R3 설치된 프로그램. 한 줄 = `bin\tpath\tversion\tmtime(초)`.
 * 없는 프로그램은 애초에 줄이 안 나온다(`command -v` 가 실패하면 그 블록을 건너뛴다).
 *
 * 버전 문자열은 프로그램마다 제각각이라(`v20.11.1` / `git version 2.43.0` / `Python 3.10.12`)
 * **첫 줄을 그대로 싣고 화면이 보여 준다.** 억지로 숫자만 뽑으려다 틀리게 자르는 것보다 낫다 —
 * 다만 앞에 붙는 자기 이름은 흔한 형태만 걷어 낸다.
 */
export function parsePkgProbe(out: string): PkgRow[] {
  const rows: PkgRow[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const [bin = '', path = '', version = '', mtime = ''] = line.split('\t')
    if (bin === '' || path === '') continue
    const secs = Number.parseInt(mtime, 10)
    rows.push({
      bin,
      path,
      version: cleanVersion(bin, version),
      installedAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null
    })
  }
  return rows
}

/** `git version 2.43.0` → `2.43.0`, `Python 3.10.12` → `3.10.12`. 못 알아보면 원문 그대로. */
function cleanVersion(bin: string, raw: string): string {
  const v = raw.trim()
  if (v === '') return ''
  // 이름은 정규식으로 들어가므로 이스케이프한다 — `c++` 같은 이름이 `Nothing to repeat` 로 던졌다.
  const esc = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 접두어는 이름·`version`·구두점이 어떤 조합으로 와도 걷어 낸다. 콜론 형태를 빠뜨렸다가
  // `nginx version: nginx/1.24.0` 이 `version: nginx/1.24.0` 으로 남았다(CON-19 가 잡았다).
  const stripped = v
    .replace(new RegExp(`^${esc}[\\s:]+`, 'i'), '')
    .replace(/^version[\s:]+/i, '')
    .trim()
  return stripped || v
}

export type CtrRow = {
  id: string
  name: string
  image: string
  /** running / exited / created / paused … docker 와 podman 이 같은 낱말을 쓴다. */
  state: string
  /** "Up 3 days" · "Exited (0) 2 hours ago" — 사람이 읽는 문구 그대로 싣는다. */
  status: string
  ports: string
}

/** 컨테이너 런타임이 아예 없거나 데몬에 못 붙는 경우 — 빈 목록과 구분해서 안내해야 한다. */
export function ctrUnavailable(out: string): boolean {
  return /command not found|Cannot connect to the Docker daemon|permission denied|docker\.sock/i.test(out)
}

/**
 * F28 `docker|podman ps -a --format '{{.ID}}\t...'` 출력.
 *
 * 탭으로 6칸이다. 포트 칸은 비어 있을 수 있고(멈춘 컨테이너), 이미지 이름에는 콜론·슬래시가 든다.
 * 형태가 아닌 줄(권한 오류 등)은 조용히 건너뛴다 — 그 판정은 ctrUnavailable() 이 따로 한다.
 */
export function parseContainers(out: string): CtrRow[] {
  const rows: CtrRow[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const p = line.split('\t')
    if (p.length < 5) continue
    const [id = '', name = '', image = '', state = '', status = '', ports = ''] = p
    if (id === '' || name === '') continue
    rows.push({ id, name, image, state: state.toLowerCase(), status, ports })
  }
  return rows
}

/** 멈춘 것을 위로 올린다 — 컨테이너 목록을 여는 이유가 대개 "뭐가 죽었나"다(서비스 표와 같은 규칙). */
export function sortContainers(rows: readonly CtrRow[]): CtrRow[] {
  const rank = (s: string) => (s === 'running' ? 1 : 0)
  return [...rows].sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))
}

export function parseDf(out: string): DiskRow[] {
  const rows: DiskRow[] = []
  for (const raw of out.split('\n')) {
    const line = raw.trim()
    if (line === '' || /^Filesystem\b/i.test(line)) continue
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({
      filesystem: m[1],
      type: m[2],
      totalKb: Number(m[3]),
      usedKb: Number(m[4]),
      availKb: Number(m[5]),
      usePct: Number(m[6]),
      mount: m[7].trim()
    })
  }
  return rows
}

/** `du -x -d1 -k <path>` 출력 — "<kb>\t<경로>". 큰 것부터 정렬해서 돌려준다. */
export function parseDu(out: string): DirUsage[] {
  const rows: DirUsage[] = []
  for (const raw of out.split('\n')) {
    const m = /^(\d+)\s+(.*)$/.exec(raw.trim())
    if (!m || m[2].trim() === '') continue
    rows.push({ kb: Number(m[1]), path: m[2].trim() })
  }
  return rows.sort((a, b) => b.kb - a.kb)
}

// ── 명령 표 ──────────────────────────────────────────────────────────────────

export type CmdSpec = {
  /** 인자 → 실제 명령 문자열. 검증 실패면 null(호출측이 반드시 분기해야 한다). */
  build: (args: unknown) => string | null
  /** 원격 상태를 바꾸는 명령. 호출측은 확인 다이얼로그 없이 부르면 안 된다. */
  write?: true
}

/** ps 는 CPU 내림차순으로 받아 온다 — 화면에서 다시 정렬하더라도 첫 화면이 쓸모 있어야 한다. */
const PS_CMD = 'ps -eo pid=,user=,pcpu=,pmem=,rss=,stat=,etimes=,args= --sort=-pcpu 2>/dev/null'

export const COMMANDS: Record<CmdId, CmdSpec> = {
  'ps.list': { build: () => PS_CMD },

  'ps.kill': {
    write: true,
    build: (args) => {
      const a = args as { pid?: unknown; signal?: unknown } | null
      const pid = validPid(a?.pid)
      const sig = validSignal(a?.signal)
      if (pid === null || sig === null) return null
      return `kill -${sig} ${pid} 2>&1`
    }
  },

  'svc.list': {
    build: () => 'systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1'
  },

  'svc.action': {
    write: true,
    build: (args) => {
      const a = args as { unit?: unknown; action?: unknown } | null
      const unit = validUnit(a?.unit)
      const action = validSvcAction(a?.action)
      if (unit === null || action === null) return null
      return `systemctl ${action} ${unit} 2>&1`
    }
  },

  'disk.usage': { build: () => 'df -PT 2>/dev/null' },

  'disk.du': {
    build: (args) => {
      const path = validAbsPath((args as { path?: unknown } | null)?.path)
      if (path === null) return null
      // -x: 다른 파일시스템으로 넘어가지 않는다(/proc·네트워크 마운트를 훑다 몇 분씩 걸리는 사고 방지).
      return `du -x -d1 -k ${q(path)} 2>/dev/null`
    }
  },

  // F26 R3 서버 개요 — 배포판·커널·가동 시간. **한 왕복**으로 끝낸다(넷으로 나누면 창이 그만큼 늦게 뜬다).
  // 각 조각은 없으면 빈 줄로 온다 — 파서가 그 칸만 비우고 나머지를 살린다.
  // 자원 사용량(부하·메모리·디스크)은 여기 없다: F29 시스템 모니터 사이드바가 유일한 집이다
  // (같은 숫자를 두 화면에서 보여 주지 않는다 — 2026-08-11 경계 정리).
  'sys.overview': {
    build: () =>
      [
        `(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") 2>/dev/null`,
        'uname -r 2>/dev/null',
        'uname -s 2>/dev/null',
        'hostname 2>/dev/null',
        'cat /proc/uptime 2>/dev/null'
      ].join(` ; echo '${OVERVIEW_SEP}' ; `)
  },

  // F26 R3 설치된 프로그램. **PATH 에서 직접 찾아 실행해 버전을 받는다** — dpkg -l / rpm -qa 만 보면
  // nvm·asdf·직접 빌드로 깐 것이 통째로 빠진다(준영님이 예로 드신 node 가 정확히 그 경우다).
  // 목록은 PROBE_BINS 고정 표이고 렌더러는 이름을 보낼 수 없다 — 그 이름이 그대로 원격에서
  // 실행되는 자리라, 렌더러가 목록을 정할 수 있으면 그게 곧 임의 실행이다.
  'pkg.probe': {
    build: () =>
      PROBE_BINS.map(
        (b) =>
          // 프로그램마다 상한을 건다: --version 이 입력을 기다리며 멈추는 프로그램이 있는데,
          // 한 개가 매달리면 왕복 전체가 타임아웃 나 표가 통째로 빈다.
          // timeout(1) 이 없는 서버도 있어 없으면 그냥 실행한다.
          `b=${b}; p=$(command -v $b 2>/dev/null) && ` +
          `{ v=$(if command -v timeout >/dev/null 2>&1; then timeout 2 $b --version 2>&1; else $b --version 2>&1; fi | head -1); ` +
          // printf 여야 한다. **bash 의 내장 echo 는 `\t` 를 탭으로 바꾸지 않는다**(dash 는 바꾼다) —
          // 그래서 로그인 셸이 bash 인 서버에서는 줄이 통째로 `a\tb\tc` 로 나가고 파서가 한 줄도
          // 못 읽어 표가 빈다(2026-08-13 준영님 실사용 제보). printf 는 POSIX 라 셸에 무관하다.
          `m=$(stat -c %Y "$p" 2>/dev/null); printf '%s\\t%s\\t%s\\t%s\\n' "$b" "$p" "$v" "$m"; }`
      ).join(' ; ') + ' ; true'
  },

  // F28 컨테이너 목록. docker 가 있으면 docker, 없으면 podman — 둘 다 없으면 빈 출력이고 화면이
  // 안내를 낸다(systemd 없는 서버 처리와 같은 결). CLI 가 호환이라 --format 문자열은 그대로 통한다.
  //
  // `-a` 로 멈춘 것까지 보여 준다: 컨테이너 화면을 여는 이유의 절반이 "왜 안 떠 있지"다.
  'ctr.list': {
    // 권한이 없으면(docker 그룹 밖) stderr 가 그대로 올라온다 — 숨기지 않는다(sudo 안 붙이는 원칙).
    // 여기 `\t` 는 셸이 아니라 **docker 의 Go 템플릿**이 푼다 — pkg.probe 의 echo 문제와 다른 자리다.
    build: () => ctrCmd(`ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}'`)
  },

  // F28 R2 컨테이너 조작(준영님 요청 2026-08-13 — "도커 데스크톱처럼"). 전부 확인 다이얼로그를 거치고,
  // 실패하면 런타임이 준 문장을 그대로 보여 준다(sudo 는 붙이지 않는다 — svc.action 과 같은 규칙).
  'ctr.action': {
    write: true,
    build: (args) => {
      const a = args as { id?: unknown; action?: unknown } | null
      const id = validCtrId(a?.id)
      const action = validCtrAction(a?.action)
      if (id === null || action === null) return null
      return ctrCmd(`${action} ${id}`)
    }
  },

  // 이미지 지우기. 쓰고 있는 컨테이너가 남아 있으면 런타임이 거절한다 — 강제(-f)하지 않는다.
  'ctr.rmi': {
    write: true,
    build: (args) => {
      const image = validImageRef((args as { image?: unknown } | null)?.image)
      if (image === null) return null
      return ctrCmd(`rmi ${image}`)
    }
  },

  'which.cli': {
    build: (args) => {
      // 이름 검증은 shared/aiCli.ts 것을 그대로 쓴다 — 확인하는 이름과 실행하는 이름이 갈리면
      // "있다고 했는데 command not found" 가 된다. 셸 메타문자는 거기서 통째로 거절된다.
      const bin = validCliBin((args as { bin?: unknown } | null)?.bin)
      if (bin === null) return null
      // which(1) 이 없는 서버가 있다 — command -v 는 POSIX 셸 내장이라 어디서나 통한다.
      // 없으면 종료코드가 0 이 아니고 출력도 비어 있다(호출측이 둘 다 본다).
      return `command -v ${bin} 2>/dev/null`
    }
  }
}

/** 렌더러가 보낸 id 가 표에 있는지. 없으면 아무것도 하지 않는다. */
export function isCmdId(v: unknown): v is CmdId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, v)
}

/** id + 인자 → 실행할 명령. 표에 없거나 인자가 틀리면 null. main 은 이 함수만 통과시킨다. */
export function buildCommand(id: unknown, args: unknown): { cmd: string; write: boolean } | null {
  if (!isCmdId(id)) return null
  const spec = COMMANDS[id]
  const cmd = spec.build(args)
  return cmd === null ? null : { cmd, write: spec.write === true }
}
