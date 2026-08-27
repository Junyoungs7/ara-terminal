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
import { remoteWorktreeAdd, remoteWorktreeRemove } from './gitWorktree'

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
  // #133 세션 분리 — 원격에서도 같은 방식이다(설계 §10.3 규칙 6). 조립은 shared/gitWorktree.ts.
  | 'git.worktree.add'
  | 'git.worktree.remove'
  | 'ctr.list'
  // 2026-08-24: 쿠버 노드는 **탭이 따로다** — crictl 로 목록·파드·자원을 한 왕복에 받는다.
  | 'k8s.list'
  // F28 R2: 컨테이너 상태 바꾸기·지우기 / 이미지 지우기. 전부 확인 다이얼로그를 거친다.
  | 'ctr.action'
  | 'ctr.rmi'
  /**
   * 백그라운드로 도는 서버의 **로그가 어디 있나**(2026-08-27 준영님 요청).
   *
   * 원격에서 AI 가 `npm run dev`·`uvicorn` 을 띄우면 그 출력은 대개 **아무 데도 안 남는다** —
   * 로그 파일을 만들지 않으면 화면 밖으로 사라진다. 포트 하나로 그 자리를 찾아낸다.
   */
  | 'app.trace'
  /** tmux 팬의 출력을 파일로 실시간 복사(이미 돌고 있는 것에도 붙는다 — 실측 확인). */
  | 'app.pipe'

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
/** 포트 번호. 1~65535 정수만 — 그 밖은 명령을 조립조차 하지 않는다. */
export function validPort(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) return null
  return v
}

/**
 * tmux 팬 이름(`세션:창.팬`). **우리가 준 것만 되돌려받는다** — app.trace 가 뱉은 형식이라
 * 자유 문자열이 아니다. 셸 인용 안에 들어가므로 따옴표·메타문자는 통째로 거절한다.
 */
export function validPane(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_.\-]{1,60}:\d{1,4}\.\d{1,4}$/.test(v) ? v : null
}

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
 * 컨테이너 런타임.
 *
 * 2026-08-24 준영님 제보로 crictl(쿠버 노드의 containerd CLI)이 들어왔다가, 같은 날 **탭이 갈렸다**:
 * 목록과 조작은 **같은 런타임**을 타야 하는데(목록은 podman 인데 조작은 docker 로 나가면 "없는
 * 컨테이너"가 된다) 쿠버는 애초에 조작할 물건이 아니라 모니터링이라, 한 표에 둘을 섞을 이유가 없었다.
 * nerdctl 은 넣지 않았다: k8s 노드에서는 `--namespace k8s.io` 가 필요한데 그러면 일반 containerd
 * 호스트에서 빈 목록이 된다 — 한 명령으로 둘 다 맞출 수 없다.
 *
 * 준영님: **쿠버는 탭을 따로 낸다.** 한 서버에 도커와 쿠버가 같이 깔린 경우가 있고, 그때 "먼저
 * 찾은 하나"를 고르면 나머지가 통째로 안 보인다. 컨테이너 탭은 docker·podman 만, 쿠버네티스 탭은
 * crictl 만 본다 — 둘 다 있으면 둘 다 각자의 탭에 뜬다.
 */
const CTR_BINS = ['docker', 'podman'] as const
const ALL_RUNTIMES = ['docker', 'podman', 'crictl'] as const
export type CtrRuntime = (typeof ALL_RUNTIMES)[number] | 'none'

function ctrCmd(args: string): string {
  return (
    CTR_BINS.map((b, i) => `${i === 0 ? 'if' : 'elif'} command -v ${b} >/dev/null 2>&1; then ${b} ${args} 2>&1; `).join(
      ''
    ) + 'fi'
  )
}

/**
 * 목록 첫 줄에 박는 표시 — **어느 런타임으로 읽었는지**와 "하나도 없다"를 출력만 보고 알 수 있어야 한다.
 * 이게 없으면 런타임이 없는 서버가 빈 출력으로 와서 "컨테이너가 0개"와 구분되지 않는다(제보의 절반).
 */
export const CTR_MARK = 'ARA-CTR '

// ── 권한 올리기 조각(ctr.list · k8s.list 공용) ────────────────────────────────
// 렌더러가 줄 수 있는 것은 **불리언 하나**다. 비밀번호는 명령 문자열에 절대 들어가지 않는다 —
// main 이 exec 의 stdin 으로 따로 넣는다(`sudo -S`). 명령줄에 실었다면 원격의 `ps` 목록과
// 감사 로그에 그대로 찍힌다.
const ctrSudo = (args: unknown): boolean => (args as { sudo?: unknown } | null)?.sudo === true

/** 실패로 볼 출력 — 빈 목록과 구분해야 한다(빈 목록은 정상 응답이다). */
const BAD_OUT = `*ermission*|*"command not found"*|*"Cannot connect"*|*"connection refused"*|*"rpc error"*|*"must be root"*|*sudo:*`

/**
 * 한 명령을 돌리고 결과를 `$o` 에 담아 출력한다.
 *
 * 이미 sudo 로 감싼 상태면 그냥 돌린다. 아니면 **비밀번호를 물을 수 없는 sudo**(`-n`)로 한 번만
 * 더 시도한다 — 프롬프트가 뜰 수 없으니 exec 채널이 매달릴 일이 없고, NOPASSWD 가 없으면 즉시
 * 실패한다. 그 실패로 원래 이유를 덮지 않는다: "sudo: a password is required" 보다
 * "소켓 permission denied" 가 진짜 원인이다(sudo 는 우리가 해 본 시도일 뿐).
 * keep 은 성공한 손을 변수에 남기는 자리다(crictl 이 뒤따르는 pods·stats 에 같은 손을 쓴다).
 */
function elevatable(cmd: string, sudo: boolean, keep = ''): string {
  if (sudo) return `o=$(${cmd} 2>&1); printf '%s\\n' "$o"; `
  return (
    `o=$(${cmd} 2>&1); case "$o" in ${BAD_OUT}) if command -v sudo >/dev/null 2>&1; then s=$(sudo -n ${cmd} 2>&1); ` +
    `case "$s" in ${BAD_OUT}) ;; *) o=$s${keep} ;; esac; fi ;; esac; printf '%s\\n' "$o"; `
  )
}

/**
 * **스크립트 전체를 한 번의 sudo 로 감싼다.** 명령마다 sudo 를 부르면 stdin 의 비밀번호를 그
 * 횟수만큼 넣어야 하고(한 줄만 넣으면 두 번째부터 조용히 실패한다), `-p ''` 로 프롬프트 글자가
 * 출력에 섞이는 것도 막는다.
 */
const wrapSudo = (script: string, sudo: boolean): string =>
  sudo ? `sudo -S -p '' sh -c '${sqEscape(script)}'` : script

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
  const pick = CTR_BINS.map((b) => `command -v ${b}`).join(' || ')
  return `$(${pick}) exec -it ${cid} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
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
/**
 * 포트 하나를 추적한 결과(2026-08-27).
 *
 * `kind` 가 이 기능의 전부다 — **로그를 볼 수 있나, 없으면 왜 없나.**
 *  · `file`  : stdout 이 파일이다 → 그대로 tail 하면 된다
 *  · `tmux`  : tmux 팬이다 → pipe-pane 을 걸면 파일이 생긴다(그 다음 tail)
 *  · `tty`   : 터미널인데 tmux 가 아니다 → 그 터미널을 보고 있는 사람만 본다
 *  · `pipe`  : 파이프로 넘어갔다 → 훔쳐보려면 root 권한 도구가 필요하다(안 한다)
 *  · `null`  : /dev/null 로 버려졌다 → **애초에 없다**
 *  · `denied`: 프로세스는 있는데 **남의 것**이다 → /proc/<pid>/fd 를 읽을 권한이 없다
 *  · `none`  : 그 포트를 듣는 프로세스가 없다
 */
export type AppTrace = {
  kind: 'file' | 'tmux' | 'tty' | 'pipe' | 'null' | 'none' | 'denied'
  port: number
  pid?: number
  /** kind==='file' 이면 그 로그 경로. tmux 면 pipe-pane 을 건 뒤 쓸 자리. */
  path?: string
  /** kind==='tmux' 일 때 그 팬(`세션:창.팬`). */
  pane?: string
  /** 그 프로세스의 명령줄 — 사람이 "아 그거" 하고 알아보는 유일한 단서다. */
  cmd?: string
}

/**
 * app.trace 출력 파서.
 *
 * 명령이 줄마다 `키=값` 을 찍게 만들었다 — 서버마다 다른 `ss`·`ls` 출력 형식을 파싱하는 대신
 * **원격 셸이 우리 형식으로 정리해서** 준다(파싱 실패 지점을 하나로 줄인다).
 */
export function parseAppTrace(out: string, port: number): AppTrace {
  const kv = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  const pidRaw = Number(kv.get('pid'))
  const pid = Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : undefined
  if (!pid) return { kind: 'none', port }
  const fd1 = kv.get('fd1') ?? ''
  const cmd = kv.get('cmd') || undefined
  const pane = kv.get('pane') || undefined
  const base = { port, pid, ...(cmd ? { cmd } : {}) }
  // fd1 이 비었다 = readlink 가 아무것도 못 읽었다. 두 경우뿐이고 사람에게 할 말이 다르다:
  // cmdline 은 읽혔다(= 프로세스는 있는데 /proc/<pid>/fd 가 남의 것이라 막혔다) → denied,
  // 그것마저 못 읽었다(= 그 사이 꺼졌다) → none. 예전엔 둘 다 'pipe' 로 떨어져 엉뚱한 이유를 댔다.
  if (fd1 === '') return { ...base, kind: cmd ? 'denied' : 'none' }
  if (fd1 === '/dev/null') return { ...base, kind: 'null' }
  if (fd1.startsWith('pipe:') || fd1.startsWith('socket:')) return { ...base, kind: 'pipe' }
  if (fd1.startsWith('/dev/pts/') || fd1 === '/dev/tty') {
    return pane ? { ...base, kind: 'tmux', pane, path: `/tmp/ara-tail-${port}.log` } : { ...base, kind: 'tty' }
  }
  if (fd1.startsWith('/')) return { ...base, kind: 'file', path: fd1 }
  return { ...base, kind: 'pipe' }
}

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
  // 숫자가 없으면 버전이 아니다 — `error: unknown flag: --version` 같은 오류 문구다(2026-08-24
  // kubectl 제보). 셸이 이미 한 번 거르지만, 여기서도 막아야 옛 서버·다른 경로로 새어 들어오지
  // 않는다. 버전 칸은 비우고 화면이 `—` 로 그린다("모른다"가 오류 문구보다 정직하다).
  if (!/[0-9]/.test(v)) return ''
  // 이름은 정규식으로 들어가므로 이스케이프한다 — `c++` 같은 이름이 `Nothing to repeat` 로 던졌다.
  const esc = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 접두어는 이름·`version`·구두점이 어떤 조합으로 와도 걷어 낸다. 콜론 형태를 빠뜨렸다가
  // `nginx version: nginx/1.24.0` 이 `version: nginx/1.24.0` 으로 남았다(CON-19 가 잡았다).
  // `Client Version:` 은 kubectl 이 `version` 하위 명령으로 답할 때의 머리다.
  const stripped = v
    .replace(new RegExp(`^${esc}[\\s:]+`, 'i'), '')
    .replace(/^client[\s]+version[\s:]+/i, '')
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
  // ── 아래는 쿠버 노드(crictl)에서만 채워진다. docker·podman 에는 없는 개념이다. ──
  /** 이 컨테이너를 담고 있는 파드 이름. */
  pod?: string
  ns?: string
  /** 재시작 횟수 — 쿠버에서 "뭐가 아픈가"를 알려 주는 첫 번째 숫자다. */
  restarts?: number
  /** 만들어진 시각(epoch ms). 나이를 세는 데 쓴다. */
  createdAt?: number
  /** 누적 CPU 나노초. **두 번 재야 %가 나온다**(순간값이 아니다 — cpuPercent 참고). */
  cpuNs?: number
  /** 지금 쓰는 메모리(working set, 바이트). */
  memBytes?: number
}

/** 파드 한 덩어리 — 컨테이너의 부모. crictl 의 `pods` 가 주는 것만 담는다. */
export type CtrPodInfo = {
  /** `네임스페이스/이름` — 컨테이너 쪽 라벨과 맞추는 열쇠다. */
  key: string
  ns: string
  name: string
  /** ready / notready — 샌드박스가 떠 있는가. */
  state: string
  createdAt?: number
}

/**
 * 컨테이너 런타임이 아예 없거나 데몬에 못 붙는 경우 — 빈 목록과 구분해서 안내해야 한다.
 * crictl 은 대개 root 여야 소켓에 붙는다: `FATA[…] connect: permission denied` · 소켓 없음 ·
 * `rpc error` 가 그 얼굴이다(docker 의 "Cannot connect to the Docker daemon" 자리).
 */
export function ctrUnavailable(out: string): boolean {
  return /command not found|Cannot connect to the Docker daemon|permission denied|docker\.sock|containerd\.sock|crio\.sock|FATA\[|rpc error|connection refused/i.test(
    out
  )
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

/**
 * crictl(`crictl ps -a -o json`) 출력. CRI 는 docker 와 정보가 다르다 —
 * **포트가 없고**(포트는 컨테이너가 아니라 파드 샌드박스의 것), 대신 **어느 파드의 것인지**가 있다.
 * 워커 노드에서 `istio-proxy` 가 스무 개 보이는 화면은 파드 이름이 없으면 아무 쓸모가 없으므로,
 * 표의 셋째 칸(docker 라면 "Up 3 days")에 `네임스페이스/파드` 를 싣는다.
 *
 * crictl 은 경고를 stderr 로 먼저 뱉는 일이 잦은데(`WARN[0000] runtime connect using default endpoints`)
 * 우리는 `2>&1` 로 합쳐 받으므로 **JSON 앞뒤의 잡소리를 걷어내고** 파싱한다.
 */
export function parseCrictl(out: string): CtrRow[] {
  const s = out.indexOf('{')
  const e = out.lastIndexOf('}')
  if (s < 0 || e <= s) return []
  let data: unknown
  try {
    data = JSON.parse(out.slice(s, e + 1))
  } catch {
    return []
  }
  const list = (data as { containers?: unknown } | null)?.containers
  if (!Array.isArray(list)) return []
  const rows: CtrRow[] = []
  for (const raw of list) {
    const c = raw as {
      id?: unknown
      metadata?: { name?: unknown; attempt?: unknown }
      image?: { image?: unknown; userSpecifiedImage?: unknown }
      imageRef?: unknown
      state?: unknown
      createdAt?: unknown
      labels?: Record<string, unknown>
      annotations?: Record<string, unknown>
    }
    const id = typeof c?.id === 'string' ? c.id : ''
    const labels = c?.labels ?? {}
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const name = str(c?.metadata?.name) || str(labels['io.kubernetes.container.name'])
    if (id === '' || name === '') continue
    const ns = str(labels['io.kubernetes.pod.namespace'])
    const pod = str(labels['io.kubernetes.pod.name'])
    // 재시작 횟수는 어노테이션에 있고, 없으면 metadata.attempt 가 같은 수를 센다.
    const ann = c?.annotations ?? {}
    const restarts = num(ann['io.kubernetes.container.restartCount']) ?? num(c?.metadata?.attempt) ?? 0
    rows.push({
      id,
      name,
      image: str(c?.image?.userSpecifiedImage) || str(c?.image?.image) || str(c?.imageRef),
      // CONTAINER_RUNNING → running. docker 와 같은 낱말로 맞춰야 정렬·버튼 규칙이 하나로 돈다.
      state: str(c?.state).replace(/^CONTAINER_/, '').toLowerCase(),
      status: pod ? (ns ? `${ns}/${pod}` : pod) : str(c?.state).replace(/^CONTAINER_/, '').toLowerCase(),
      ports: '',
      ...(pod ? { pod } : {}),
      ...(ns ? { ns } : {}),
      restarts,
      ...(nanoToMs(c?.createdAt) !== null ? { createdAt: nanoToMs(c?.createdAt)! } : {})
    })
  }
  return rows
}

/** CRI 의 시각은 **나노초 문자열**이다(`"1724000000000000000"`). ms 로 내린다. */
function nanoToMs(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1e6) : null
}

/** CRI 는 숫자를 문자열로 준다(`"3"`) — 둘 다 받는다. */
function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** `crictl pods -o json` — 파드(샌드박스) 목록. 준비 상태와 나이를 여기서만 알 수 있다. */
export function parseCrictlPods(out: string): CtrPodInfo[] {
  const data = jsonOf(out)
  const items = (data as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  const pods: CtrPodInfo[] = []
  for (const raw of items) {
    const p = raw as { metadata?: { name?: unknown; namespace?: unknown }; state?: unknown; createdAt?: unknown }
    const name = typeof p?.metadata?.name === 'string' ? p.metadata.name : ''
    const ns = typeof p?.metadata?.namespace === 'string' ? p.metadata.namespace : ''
    if (name === '') continue
    const ms = nanoToMs(p?.createdAt)
    pods.push({
      key: ns ? `${ns}/${name}` : name,
      ns,
      name,
      // SANDBOX_READY → ready. 준비되지 않은 파드가 이 화면을 여는 이유다.
      state: (typeof p?.state === 'string' ? p.state : '').replace(/^SANDBOX_/, '').toLowerCase(),
      ...(ms !== null ? { createdAt: ms } : {})
    })
  }
  return pods
}

/** `crictl stats -o json` — 컨테이너별 CPU 누적·메모리. 없으면 빈 표(자원 칸만 비고 목록은 산다). */
export function parseCrictlStats(out: string): Map<string, { cpuNs: number; memBytes: number }> {
  const m = new Map<string, { cpuNs: number; memBytes: number }>()
  const data = jsonOf(out)
  const stats = (data as { stats?: unknown } | null)?.stats
  if (!Array.isArray(stats)) return m
  for (const raw of stats) {
    const s = raw as {
      attributes?: { id?: unknown }
      cpu?: { usageCoreNanoSeconds?: { value?: unknown } }
      memory?: { workingSetBytes?: { value?: unknown } }
    }
    const id = typeof s?.attributes?.id === 'string' ? s.attributes.id : ''
    if (id === '') continue
    m.set(id, {
      cpuNs: num(s?.cpu?.usageCoreNanoSeconds?.value) ?? 0,
      memBytes: num(s?.memory?.workingSetBytes?.value) ?? 0
    })
  }
  return m
}

/** 잡소리(crictl 의 `WARN[…]`)를 걷어내고 JSON 만 꺼낸다 — 세 파서가 같은 함정을 밟는다. */
function jsonOf(out: string): unknown {
  const s = out.indexOf('{')
  const e = out.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    return JSON.parse(out.slice(s, e + 1))
  } catch {
    return null
  }
}

/**
 * 누적 CPU 나노초 두 번 → 코어 대비 사용률(%). CRI 는 순간값을 주지 않으므로 **직접 미분**한다.
 * 첫 표본(이전 값이 없거나 시간이 안 흘렀거나 카운터가 되감김)에는 null 을 준다 — 0% 라고
 * 말하면 "안 쓰는 중"이라는 거짓말이 된다.
 */
export function cpuPercent(prevNs: number | undefined, curNs: number, elapsedMs: number): number | null {
  if (prevNs === undefined || elapsedMs <= 0 || curNs < prevNs) return null
  return ((curNs - prevNs) / (elapsedMs * 1e6)) * 100
}

export type CtrList = {
  runtime: CtrRuntime
  rows: CtrRow[]
  /** 런타임이 없거나 데몬·소켓에 못 붙었다 — "컨테이너가 0개"와 다른 이야기다. */
  unavailable: boolean
  /**
   * 런타임이 **있는데** 실패했을 때 서버가 준 첫 줄. 다른 표(서비스·이미지 제거)는 전부 서버 문장을
   * 그대로 보여 주는데 이 표만 일반 안내로 덮고 있었다 — 2026-08-24 준영님이 "워커 노드에서 여전히
   * 안 나온다"고 했을 때 **왜인지 알 방법이 화면에 없었다.** 그 구멍을 막는 값이다.
   */
  reason: string | null
  /** 쿠버 노드에서만 — 파드 목록(준비 상태·나이). docker·podman 이면 빈 배열이다. */
  pods: CtrPodInfo[]
}

/**
 * ctr.list 출력 → 화면이 쓰는 형태.
 *
 * 출력은 `ARA-CTR <런타임>` 으로 시작하는 **토막 여럿**이다. 왜 여럿인가 — 2026-08-24 준영님의
 * 쿠버네티스 워커 노드가 정확한 반례였다: 그 노드에는 **podman 도 깔려 있고** crictl 도 있는데,
 * 우리는 "먼저 발견된 하나"(podman)에서 멈췄다. 루트리스 podman 은 컨테이너가 없어 조용히 빈
 * 목록을 돌려주고, 화면은 "컨테이너가 없습니다"라고 말했다 — 정작 컨테이너는 containerd 에 있었다.
 *
 * 그래서 **있는 것을 고르지 않고, 답을 준 것을 고른다**:
 *  ① 행이 나온 첫 토막 → 그게 이 서버의 런타임이다
 *  ② 없으면, 진짜로 실패한 첫 토막 → 이유를 그대로 보여 준다(대개 crictl 권한)
 *  ③ 둘 다 아니면 첫 토막으로 "0개"를 말한다 · 토막이 없으면(none) 런타임 자체가 없는 것이다
 */
export function parseCtrList(out: string): CtrList {
  const all = ctrSections(out)
  // `pods`·`stats` 는 런타임이 아니라 **곁들여 온 자료**다 — 고르기에 끼워 넣으면 "행 0개짜리
  // 실패한 런타임"으로 오해받는다.
  const pods = parseCrictlPods(all.find((s) => s.runtime === ('pods' as CtrRuntime))?.body ?? '')
  const stats = parseCrictlStats(all.find((s) => s.runtime === ('stats' as CtrRuntime))?.body ?? '')
  const parsed = all
    .filter((s) => s.runtime === 'none' || (ALL_RUNTIMES as readonly string[]).includes(s.runtime))
    .map((s) => {
    const rows = s.runtime === 'crictl' ? parseCrictl(s.body) : parseContainers(s.body)
    // 행이 0 인데 출력은 있다 = **우리가 못 읽은 것**이다. 오류 문구든, 경고든, 처음 보는 형식이든
    // 화면에 그대로 올린다 — 조용히 "0개"로 뭉개면 무엇이 잘못됐는지 알 길이 사라진다(이 표가
    // 세 라운드나 "컨테이너가 없습니다"만 보여 준 이유가 정확히 이것이다).
    const bad = s.runtime !== 'none' && rows.length === 0 && !ctrLooksEmpty(s.runtime, s.body)
    // `command not found` 는 "있는데 실패"가 아니라 **없다**. 그 줄을 이유로 달면 "docker 는 있는데
    // 읽지 못했습니다: docker: command not found" 라는 자가당착이 된다 — 일반 안내로 보낸다.
    const missing = /command not found/i.test(s.body)
    return {
      runtime: s.runtime,
      rows,
      unavailable: bad || s.runtime === 'none',
      reason: bad && !missing ? firstLine(s.body) : null,
      // 우리가 아는 실패(권한·소켓·데몬)인가, 그냥 못 읽은 출력인가. 둘 다 보여 주지만
      // **아는 실패가 더 쓸모 있다** — podman 의 경고보다 crictl 의 permission denied 가 답이다.
      known: ctrUnavailable(s.body)
    }
  })
  if (parsed.length === 0) return { runtime: 'none', rows: [], unavailable: true, reason: null, pods: [] }
  const pick =
    parsed.find((p) => p.rows.length > 0) ??
    parsed.find((p) => p.unavailable && p.known) ??
    parsed.find((p) => p.unavailable) ??
    parsed[0]
  // 자원은 컨테이너 행에 얹는다 — 화면이 표 두 개를 들고 맞춰 보지 않게.
  const rows = pick.rows.map((r) => {
    const s = stats.get(r.id)
    return s ? { ...r, cpuNs: s.cpuNs, memBytes: s.memBytes } : r
  })
  return { runtime: pick.runtime, rows, unavailable: pick.unavailable, reason: pick.reason, pods }
}

/**
 * "컨테이너가 진짜 0개"인 출력인가. 여기 해당하지 않는데 행이 없으면 우리가 못 읽은 것이다.
 * docker·podman 은 빈 출력, crictl 은 `{"containers":[]}` 가 정상적인 0개다.
 */
function ctrLooksEmpty(runtime: CtrRuntime, body: string): boolean {
  const t = body.trim()
  if (t === '') return true
  if (runtime !== 'crictl') return false
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return false
  try {
    const d = JSON.parse(t.slice(s, e + 1)) as { containers?: unknown }
    return Array.isArray(d.containers) && d.containers.length === 0
  } catch {
    return false
  }
}

/** `ARA-CTR <런타임>` 줄로 토막 낸다. 표시가 아예 없으면 통째로 docker 로 본다(하네스·옛 출력). */
function ctrSections(out: string): { runtime: CtrRuntime; body: string }[] {
  const sections: { runtime: CtrRuntime; body: string[] }[] = []
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith(CTR_MARK)) {
      sections.push({ runtime: line.slice(CTR_MARK.length).trim() as CtrRuntime, body: [] })
      continue
    }
    if (sections.length === 0) {
      if (line.trim() === '') continue
      sections.push({ runtime: 'docker', body: [] })
    }
    sections[sections.length - 1].body.push(line)
  }
  return sections.map((s) => ({ runtime: s.runtime, body: s.body.join('\n') }))
}

/**
 * 서버 출력의 첫 **의미 있는** 줄(빈 줄·JSON 여는 괄호는 건너뛴다).
 *
 * 앞을 300자에서 자르던 것을 늘렸다 — crictl 의 오류는 `time=… level=fatal msg="validate service
 * connection: … rpc error: … connect: permission denied"` 처럼 **정작 원인이 맨 끝**에 있어서,
 * 앞만 남기면 제일 중요한 낱말이 잘려 나갔다(2026-08-24 준영님 화면 실물).
 */
function firstLine(out: string): string | null {
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (line === '' || line === '{' || line === '}') continue
    return line.length > 1000 ? line.slice(0, 1000) + '…' : line
  }
  return null
}

/** 이 실패가 **권한 벽**인가. 맞으면 화면이 "root 가 필요하다"는 다음 수를 함께 알려 준다. */
export function ctrNeedsRoot(reason: string | null): boolean {
  return reason !== null && /permission denied|must be root|operation not permitted/i.test(reason)
}

/**
 * sudo 자체가 거절한 것인가(비밀번호 틀림 · sudoer 아님 · tty 요구).
 * **이걸 구분하지 못하면 5초마다 틀린 비밀번호를 다시 보낸다** — 서버의 실패 카운터가 쌓이고
 * 계정이 잠길 수 있다. 화면은 이 값을 보고 권한 올리기를 즉시 끈다.
 */
export function ctrSudoFailed(out: string): boolean {
  return /Sorry, try again|incorrect password|is not in the sudoers|no tty present|a password is required|a terminal is required/i.test(
    out
  )
}

/**
 * 작은따옴표로 감싼 셸 문자열 안에 넣기. `'` → `'\''`(닫고·이스케이프하고·다시 연다) —
 * POSIX 셸에서 작은따옴표 안을 탈출하는 유일한 방법이다.
 */
export function sqEscape(s: string): string {
  return s.replace(/'/g, `'\\''`)
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

  /**
   * 그 포트를 듣는 프로세스의 **로그가 어디로 가나**(2026-08-27 준영님 요청).
   *
   * 원격 셸이 `키=값` 으로 정리해서 준다 — 서버마다 다른 `ss`·`ls` 출력 형식을 우리가 파싱하는
   * 대신 저쪽에서 한 모양으로 맞춘다(실패 지점을 하나로 줄인다).
   *
   * **읽기만 한다.** `readlink` 와 `tmux list-panes` 뿐이고 아무것도 바꾸지 않는다.
   * tmux 가 없거나 그 팬을 못 찾으면 `pane=` 이 비어서 나간다(그 자체가 답이다).
   */
  'app.trace': {
    build: (args) => {
      const a = args as { port?: unknown; pid?: unknown } | null
      const port = validPort(a?.port)
      if (port === null) return null
      // **pid 를 다시 찾지 않는다.** 포트 표(RemoteTelemetry.parsePorts)가 이미 뽑아 둔 값이 있으면
      // 그것을 쓴다 — 이 명령에서 제일 잘 깨지던 조각이 pid 찾기였다(2026-08-27 준영님 제보).
      const known = validPid(a?.pid)
      const find =
        known !== null
          ? `P=${known}`
          : [
              // ss 는 RHEL 계열에서 /usr/sbin 에 있고 **비대화형 exec 의 PATH 에는 그 자리가 없다**.
              // 그러면 "찾지 못했습니다"만 나온다 — 화면의 포트 목록은 멀쩡히 보이는데도.
              // netstat 폴백은 텔레메트리(COLLECT_CMD)와 같은 짝을 쓴다: 두 곳이 다른 답을 내면 안 된다.
              'PATH=$PATH:/usr/sbin:/sbin',
              `L=$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -F ':${port} ' | head -1)`,
              // ss: users:(("node",pid=1234,fd=20)) / netstat: 1234/node
              `P=$(echo "$L" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)`,
              `[ -z "$P" ] && P=$(echo "$L" | grep -oE '[0-9]+/' | head -1 | tr -d /)`,
              `[ -z "$P" ] && P=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1)`
            ].join('; ')
      return [
        find,
        'echo "pid=$P"',
        '[ -z "$P" ] && exit 0',
        'echo "fd1=$(readlink /proc/$P/fd/1 2>/dev/null)"',
        'T=$(readlink /proc/$P/fd/1 2>/dev/null)',
        `echo "pane=$(tmux list-panes -a -F '#{pane_tty} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null | grep -F "$T " | head -1 | awk '{print $2}')"`,
        // cmd 는 **맨 끝**이고 **한 줄로 눌러서** 낸다. 남의 프로세스 인자라(우리가 만든 값이 아니다)
        // 개행이 들어 있으면 그 뒤가 `키=값` 으로 읽혀 **pane 을 위조**할 수 있다 — 실측에서 파이썬
        // `-c` 코드가 통째로 여러 줄로 쏟아졌다. 개행·널을 공백으로 눌러 그 길을 없앤다.
        // 백슬래시는 **두 번** 적는다. 한 번만 적으면 템플릿 문자열이 여기서 진짜 NUL·개행으로
        // 바꿔 버리고, 그 NUL 이 exec 요청에 실려 나가면 sshd 가 패킷을 거부하며 **연결을 끊는다**
        // (2026-08-27 준영님 제보: [로그] 를 누르면 세션이 끊겼다). tr 가 해석할 몫은 tr 에게 준다.
        `echo "cmd=$(tr '\\0\\n\\r' '   ' < /proc/$P/cmdline 2>/dev/null | cut -c1-200)" 2>/dev/null`
      ].join('; ')
    }
  },

  /**
   * tmux 팬의 출력을 **파일로 실시간 복사**한다(실측 2026-08-27: 이미 돌고 있는 것에도 붙는다).
   *
   * `write: true` 인 이유 — 남의 팬에 리다이렉트를 거는 일이라 사용자 확인을 받아야 한다.
   * 같은 팬에 두 번 걸면 tmux 가 앞의 것을 끊고 새로 건다(중복 기록이 아니다).
   * 파일은 `/tmp` 에 둔다: 실시간으로 보려고 만든 것이지 보관용이 아니고, 남의 홈을 더럽히지 않는다.
   */
  'app.pipe': {
    write: true,
    build: (args) => {
      const a = args as { pane?: unknown; port?: unknown } | null
      const port = validPort(a?.port)
      const pane = validPane(a?.pane)
      if (port === null || pane === null) return null
      const path = `/tmp/ara-tail-${port}.log`
      return `tmux pipe-pane -o -t '${pane}' 'cat >> ${path}' 2>&1 && echo "path=${path}"`
    }
  },


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

  // #133: 폴더를 만들고 브랜치를 만든다 = 원격 상태를 바꾼다 → write.
  'git.worktree.add': {
    write: true,
    build: (args) => {
      const a = args as { path?: unknown; name?: unknown } | null
      if (typeof a?.path !== 'string' || typeof a?.name !== 'string') return null
      return remoteWorktreeAdd(a.path, a.name)
    }
  },
  'git.worktree.remove': {
    write: true,
    build: (args) => {
      const a = args as { path?: unknown; dest?: unknown } | null
      if (typeof a?.path !== 'string' || typeof a?.dest !== 'string') return null
      return remoteWorktreeRemove(a.path, a.dest)
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
      // 프로그램마다 상한을 건다: --version 이 입력을 기다리며 멈추는 프로그램이 있는데,
      // 한 개가 매달리면 왕복 전체가 타임아웃 나 표가 통째로 빈다.
      // timeout(1) 이 없는 서버도 있어 없으면 그냥 실행한다(T 가 빈 문자열이 된다).
      `T=''; command -v timeout >/dev/null 2>&1 && T='timeout 2' ; ` +
      PROBE_BINS.map(
        (b) =>
          `b=${b}; p=$(command -v $b 2>/dev/null) && ` +
          // **모두가 --version 을 아는 것은 아니다**(2026-08-24 준영님 제보: kubectl 이
          // `error: unknown flag: --version` 만 보였다). go·helm·kubectl 은 `version` 이 하위
          // 명령이고, 자바 8 은 `-version`, nginx·httpd·구형 tmux 는 `-V` 다. 그래서 차례로
          // 물어보고 **숫자가 든 첫 줄**을 답으로 삼는다 — 오류 문구에는 숫자가 없다.
          // (`version --client` 를 앞에 두는 이유: kubectl 이 API 서버를 찾아 나서지 않게.)
          // 소문자 `-v` 는 넣지 않는다 — vim·mysql 등에서 버전이 아니라 다른 동작이다.
          `{ v=''; for f in --version 'version --client' version -version -V; do ` +
          `o=$($T $b $f 2>&1 | head -1); ` +
          // 오류 문구에도 숫자가 든다 — 실제로 python 이 `version` 을 스크립트 이름으로 알아듣고
          // `can't open file '…/version': [Errno 2]` 를 뱉었다(로컬 실측). 숫자만 보고 받으면
          // 그 줄이 버전 칸에 박힌다. 그래서 **오류로 보이는 줄을 먼저 버리고** 숫자를 본다.
          `case "$o" in *nknown*|*nrecognized*|*nvalid*|*llegal*|*rror*|*sage:*|*"o such file"*|*"not defined"*) continue ;; esac; ` +
          `case "$o" in *[0-9]*) v=$o; break ;; esac; done; ` +
          // printf 여야 한다. **bash 의 내장 echo 는 `\t` 를 탭으로 바꾸지 않는다**(dash 는 바꾼다) —
          // 그래서 로그인 셸이 bash 인 서버에서는 줄이 통째로 `a\tb\tc` 로 나가고 파서가 한 줄도
          // 못 읽어 표가 빈다(2026-08-13 준영님 실사용 제보). printf 는 POSIX 라 셸에 무관하다.
          `m=$(stat -c %Y "$p" 2>/dev/null); printf '%s\\t%s\\t%s\\t%s\\n' "$b" "$p" "$v" "$m"; }`
      ).join(' ; ') + ' ; true'
  },

  // F28 컨테이너 목록. 런타임 이름을 첫 줄에 박고(CTR_MARK) 그 런타임의 목록을 잇는다 — 셋 다
  // 없으면 `none` 이 온다. crictl 은 Go 템플릿이 없어 JSON 으로 받는다(형태가 아예 다르다).
  //
  // `-a` 로 멈춘 것까지 보여 준다: 컨테이너 화면을 여는 이유의 절반이 "왜 안 떠 있지"다.
  'ctr.list': {
    // 권한이 없으면(docker 그룹 밖) stderr 가 그대로 올라온다 — 숨기지 않는다. 여기 `\t` 는
    // 셸이 아니라 **docker 의 Go 템플릿**이 푼다 — pkg.probe 의 echo 문제와 다른 자리다.
    build: (args) => {
      const ps = `ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}'`
      // "답을 받았다"의 판정은 **행이 있느냐**로 한다. 출력이 비지 않았다는 것만으로 멈추면
      // 경고 한 줄(루트리스 podman 의 `WARN[0000] …` 같은)에 걸려 다음 런타임을 묻지 않는다.
      const script =
        `f=''; d=''; ` +
        CTR_BINS.map(
          (b) =>
            `if [ -z "$d" ] && command -v ${b} >/dev/null 2>&1; then f=1; printf '${CTR_MARK}${b}\\n'; ` +
            elevatable(`${b} ${ps}`, ctrSudo(args)) +
            `case "$o" in *'\t'*) d=1 ;; esac; fi; `
        ).join('') + `[ -z "$f" ] && printf '${CTR_MARK}none\\n' ; true`
      return wrapSudo(script, ctrSudo(args))
    }
  },

  /**
   * 2026-08-24 준영님: **쿠버는 탭이 따로다.** 한 서버에 도커와 쿠버가 같이 깔려 있으면 "먼저 찾은
   * 하나"를 고르는 방식은 나머지를 통째로 감춘다 — 각자의 탭에서 각자 뜬다.
   *
   * 모니터링이 목적이라 한 왕복에 **셋**을 묻는다: 목록(ps) · 파드(pods, 준비 상태·나이) ·
   * 자원(stats, CPU 누적·메모리). 목록이 막혔으면 나머지를 물어도 같은 벽이라 건너뛴다.
   * 조작은 없다 — 이 탭에는 정지·제거 버튼 자체가 없다(kubelet 이 되살리므로 의미도 없다).
   */
  'k8s.list': {
    build: (args) => {
      const sudo = ctrSudo(args)
      const script =
        `if command -v crictl >/dev/null 2>&1; then printf '${CTR_MARK}crictl\\n'; C=crictl; ` +
        elevatable('crictl ps -a -o json', sudo, "; C='sudo -n crictl'") +
        `case "$o" in *'"id"'*) ` +
        `printf '${CTR_MARK}pods\\n'; $C pods -o json 2>&1; ` +
        `printf '${CTR_MARK}stats\\n'; $C stats -o json 2>&1 ;; esac; ` +
        `else printf '${CTR_MARK}none\\n'; fi ; true`
      return wrapSudo(script, sudo)
    }
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
  if (cmd === null) return null
  // 여기 명령은 전부 `;` 로 이은 **한 줄**이다. NUL·개행이 들어갔다면 예외 없이 이스케이프 사고다
  // (`'\0'` 를 템플릿 문자열에 그대로 적으면 진짜 NUL 이 된다 — 2026-08-27 실측). 특히 NUL 은
  // 치명적이다: sshd 는 NUL 이 든 exec 요청을 거부하면서 **커넥션 전체를 끊는다**. 그래서 나가기 전에
  // 여기서 막는다 — 표의 어느 명령이 그래도 마찬가지다(호출측은 badArgs 와 같은 길로 받는다).
  return /[\0\r\n]/.test(cmd) ? null : { cmd, write: spec.write === true }
}
