// PtyBackend — node-pty를 SessionBackend로 감싸는 어댑터 (로컬 셸).
import { usableSize } from '@shared/termSize'
import { basename } from 'node:path'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import type { SessionBackend } from './SessionBackend'
import type { SessionSpec } from './ISessionManager'
import { SHELL_INTEGRATION } from './osc7'
import { shellFor, type LaunchShell } from '@shared/aiCli'

// OSC7 주입 방식이 셸마다 달라 종류를 판별한다(powershell=시작 인자, bash=환경변수, 그 외=stdin 폴백).
type ShellKind = 'powershell' | 'bash' | 'other'
function shellKind(file: string): ShellKind {
  const b = basename(file).toLowerCase()
  if (b.startsWith('pwsh') || b.startsWith('powershell')) return 'powershell'
  if (b.startsWith('bash')) return 'bash'
  return 'other'
}

// Windows: PWSH 환경변수가 가리키는 셸 → 없으면 powershell.exe(5.1). pwsh 를 찾아 나서지는 않는다
// (처음부터 이 동작이다 — 1c019e7). 스폰이 실패하면 생성자가 cmd 로 폴백한다.
// mac/linux: 로그인 셸(SHELL env) → 없으면 zsh.
function resolveShell(spec: SessionSpec): { file: string; args: string[]; kind: ShellKind } {
  const of = (file: string, args: string[] = []) => ({ file, args, kind: shellKind(file) })
  if (spec.shell) return of(spec.shell)
  if (process.platform === 'win32') {
    const psh = process.env['PWSH']
    if (psh) return of(psh)
    return of('powershell.exe', ['-NoLogo'])
  }
  return of(process.env['SHELL'] || '/bin/zsh')
}

/**
 * #90: 이 PC 의 기본 셸이 어느 조립 규칙인가. AI CLI 시작이 `cd A && B` 를 보낼지
 * `Set-Location …; if ($?) { B }` 를 보낼지 여기서 갈린다 — powershell.exe(5.1)는 `&&` 가
 * **파서 오류**라 잘못 고르면 명령이 실행조차 되지 않는다.
 * 셸 선택 규칙(PWSH env → powershell → 스폰 실패 시 cmd)을 두 벌로 만들지 않으려고 위 resolveShell 을 그대로 탄다.
 */
export function defaultLaunchShell(): LaunchShell {
  return shellFor(resolveShell({} as SessionSpec).kind, process.platform === 'win32' ? 'win32' : 'other')
}

// 셸 통합(F6 MS-3)을 셸 시작에 심는다 — stdin 주입과 달리 터미널에 아무것도 에코되지 않는다.
// powershell: -NoExit -EncodedCommand(UTF-16LE base64) / bash: PROMPT_COMMAND 환경변수.
// 반환한 args·env 로 스폰하면 첫 프롬프트부터 OSC7 이 나온다.
function withShellIntegration(
  kind: ShellKind,
  args: string[],
  env: Record<string, string>
): { args: string[]; env: Record<string, string> } {
  if (kind === 'powershell') {
    const encoded = Buffer.from(SHELL_INTEGRATION.powershell, 'utf16le').toString('base64')
    return { args: [...args, '-NoExit', '-EncodedCommand', encoded], env }
  }
  if (kind === 'bash') {
    return { args, env: { ...env, PROMPT_COMMAND: SHELL_INTEGRATION.bashPromptCommand } }
  }
  return { args, env }
}

// zsh 폴백 주입 지연 — 셸이 stdin 을 받을 준비가 되기 전에 쓰면 그대로 버려진다.
const POSIX_INJECT_DELAY_MS = 400

// ── 종료 배수(Windows conpty) ───────────────────────────────────────────────────────────────
// kill() 은 ConptyClosePseudoConsole 뒤 TerminateProcess 를 부른다(node-pty src/win/conpty.cc
// PtyKill). 셸이 죽으면 node-pty 의 네이티브 스레드(같은 파일 SetupExitCallback)가
// WaitForSingleObject 에서 깨어나 ThreadSafeFunction 으로 exit 을 메인 루프에 올린다. 그 콜백이
// 도착하기 전에 프로세스를 끝내면 그 스레드가 사라지는 중인 V8 환경을 만져 프로세스가 즉사한다
// — 실측(FIX-shutdown): kill 직후 app.exit() 은 8/8 크래시(0xC0000409 fail-fast, 1회는 0xC0000005),
// 콜백 도착까지는 14~16ms. 한 틱(setTimeout 0) 양보로는 못 넘는다(4/4 크래시).
// 고정 지연도 해법이 아니다: 20ms 를 그냥 쉬는 변형이 8회 중 1회 죽었다.
// 콜백이 도착하면 node-pty 가 agent 의 _exitCode 를 채운다 — 그 신호를 기다렸다가 종료한다.
// 상한은 "신호가 끝내 안 올 때" 를 위한 것이지 정상 경로의 예산이 아니다 — 한가한 기계에서는
// 14~82ms 면 끝난다. 처음엔 500ms 로 뒀는데 부하가 걸린 실행에서 24개 중 12개가 511ms 안에
// 도착하지 못했고, 그 상태로 종료해서 그대로 세그폴트가 났다(2026-08-11 실측). 콜백은 안 오는 게
// 아니라 늦게 오는 것이라 상한을 넉넉히 올린다. 상한에 닿아도 종료는 한다 — 더 나빠지지 않는다.
const EXIT_DRAIN_CAP_MS = 3000
const EXIT_DRAIN_POLL_MS = 5

// kill() 했지만 아직 네이티브 exit 콜백이 도착하지 않은 pty 들.
const killedPtys = new Set<IPty>()

// node-pty 내부 필드다 — 이 신호를 노출하는 공개 API 가 없다(onExit 은 conout 소켓 close 에 묶여
// 있어서 명시적 kill() 에서는 끝내 안 온다: lib/windowsTerminal.js 참고). 이름이 바뀌면 신호가
// 영영 안 와 위 상한까지 기다렸다 종료한다 — 최악이 "종료가 0.5초 느려짐"이지 크래시가 아니다.
function exitReported(pty: IPty): boolean {
  return (pty as unknown as { _agent?: { _exitCode?: number } })._agent?._exitCode !== undefined
}

// ── 차례로 죽이기(#203) ─────────────────────────────────────────────────────────────────────
// 배수는 **기다리는** 장치지 **겹치지 않게 하는** 장치가 아니다. conpty.cc 의 exit 스레드는 pty 마다
// 따로 돌며 잠금 없는 전역 벡터(`ptyHandles`)에서 자기 항목을 지우고 `assert` 한다(:106) — 여럿이
// 거의 동시에 죽으면 그 erase 가 겹쳐 `Assertion failed! … remove_pty_baton` 으로 앱이 죽는다.
// 그래서 kill 을 줄 세운다: 하나 죽이고, 그 exit 이 메인 루프에 도착한 것(`exitReported`)을 본 뒤 다음.
// 그 스레드는 erase 를 **끝낸 다음에** exit 을 올리므로(같은 파일 :105-107) 도착을 보면 겹칠 수 없다.
//
// 여기 두는 이유: 로컬 pty 를 죽이는 길은 `PtyBackend.kill()` 하나다 — 종료(`destroyAll`)만 줄 세우면
// 탭 여럿을 연달아 닫는 길이 같은 구멍으로 남는다. SSH 는 이 줄을 안 선다(pty 가 아니다).
// 값: pty 하나당 실측 ~15ms. 줄이 비어 있어도 kill 은 한 마이크로태스크 뒤에 일어난다.
//
// 상한은 배수와 같은 성격이다 — 안 오면 기다리다 넘어간다. 한 번이라도 상한에 닿으면 신호가 죽은
// 것으로 보고(`_exitCode` 이름이 바뀌었을 때) 그 뒤로는 안 기다린다: 안 그러면 세션 8개가 종료를
// 24초 붙잡는다. 그때는 예전(연달아 kill)과 같아진다 — 더 나빠지지 않는다.
let killQueue: Promise<void> = Promise.resolve()
let exitSignalDead = false

export function killInTurn(kill: () => void, reported: () => boolean, capMs = EXIT_DRAIN_CAP_MS): Promise<void> {
  killQueue = killQueue.then(async () => {
    try {
      kill()
    } catch {
      return // 이미 종료 — 기다릴 exit 이 없다
    }
    if (exitSignalDead) return
    const deadline = Date.now() + capMs
    while (!reported()) {
      if (Date.now() >= deadline) {
        exitSignalDead = true
        return
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_POLL_MS))
    }
  })
  return killQueue
}

// 종료 직전에 한 번 부른다(main/index.ts before-quit). kill 한 pty 의 exit 콜백이 전부 메인 루프에
// 도착할 때까지(또는 상한까지) 기다린다.
// 죽인 pty 가 없으면(POSIX·세션 0개) 즉시 끝난다 — 종료가 이유 없이 느려지지 않게.
export async function drainKilledPtys(): Promise<void> {
  // 줄에 선 kill 부터 끝낸다 — destroyAll 은 동기라 여기 올 때 아직 안 죽은 pty 가 있다.
  await killQueue
  if (killedPtys.size === 0) return
  const deadline = Date.now() + EXIT_DRAIN_CAP_MS
  while (killedPtys.size > 0 && Date.now() < deadline) {
    for (const p of killedPtys) if (exitReported(p)) killedPtys.delete(p)
    if (killedPtys.size === 0) break
    await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_POLL_MS))
  }
  killedPtys.clear()
}

// ── 시작 DA1 에 main 이 답한다(fix-da1) ────────────────────────────────────────────────────
// 번들 conpty(useConptyDll, OpenConsole 1.23)는 시작할 때 DA1(`ESC[c`)을 묻고, 답이 오거나 약 3.8초
// 타임아웃이 날 때까지 셸 출력을 내보내지 않는다. attach 전 출력은 backlog 에 갇히고, 렌더러는 재그리기
// 중 xterm 의 응답을 일부러 버린다(TerminalPane — 옛 `[?1;2c` 잔재 버그) → 답할 사람이 없어 새 탭·복원마다
// 프롬프트가 ~4초 늦었다(agent_talk/perf-workspace-done.md). 그래서 **첫 질의 한 번만** main 이
// xterm.js 와 같은 값(`ESC[?1;2c`)으로 답하고 그 질의 바이트는 렌더러로 안 넘긴다. 이후의 DA1(사용자
// 프로그램이 묻는 것)은 손대지 않는다 — 지금처럼 xterm 이 답한다.
// ponytail: 첫 DA1_WATCH_CHUNKS 조각 안에서만 찾는다. 놓치면(더 늦게 오거나 시스템 conpty 처럼 아예 안 물으면)
// 지금처럼 타임아웃으로 돌아갈 뿐 더 나빠지지 않는다. 실측은 첫 1~2조각 안이다.
const DA1 = '[c'
export const DA1_REPLY = '[?1;2c'
const DA1_WATCH_CHUNKS = 4

/** 시작 DA1 거르기 상태. `null` = 끝(그 뒤로는 통과). `carry` = 조각 끝에 걸린 질의 앞부분. */
export type StartupDa1 = { carry: string; left: number } | null
export const startupDa1Initial = (): StartupDa1 => ({ carry: '', left: DA1_WATCH_CHUNKS })

/** 순수 함수 — 조각 하나를 받아 내보낼 문자열·다음 상태·답할지 여부를 돌려준다. */
export function filterStartupDa1(st: StartupDa1, chunk: string): { out: string; st: StartupDa1; reply: boolean } {
  if (!st) return { out: chunk, st, reply: false }
  const s = st.carry + chunk
  const i = s.indexOf(DA1)
  if (i >= 0) return { out: s.slice(0, i) + s.slice(i + DA1.length), st: null, reply: true }
  if (st.left > 1) {
    // 끝이 질의의 앞부분(`ESC`, `ESC[`)이면 다음 조각까지 보관한다.
    for (let k = DA1.length - 1; k > 0; k--) {
      if (s.endsWith(DA1.slice(0, k))) return { out: s.slice(0, -k), st: { carry: s.slice(-k), left: st.left - 1 }, reply: false }
    }
    return { out: s, st: { carry: '', left: st.left - 1 }, reply: false }
  }
  return { out: s, st: null, reply: false }
}

export class PtyBackend implements SessionBackend {
  private readonly pty: IPty
  // Windows(번들 conpty)에서만 시작 DA1 을 거른다. POSIX 는 처음부터 끝(null).
  private da1: StartupDa1 = process.platform === 'win32' ? startupDa1Initial() : null

  get pid(): number {
    return this.pty.pid
  }

  /**
   * paneId(= 세션 id)는 **훅이 어느 탭인지 말하게 하는 값**이다(F1a). 셸 env 에 넣어 두면
   * 사용자가 직접 친 `claude` 도 그 셸의 자식이라 물려받는다 — 우리가 띄운 것만 아는 것이 아니라
   * **그 탭에서 도는 것을 안다**(docs/orca-analysis.md §3). 포트(`ARA_HOOK_PORT`)는 세션마다 같은
   * 값이라 main 의 process.env 에 한 번만 심고 여기서 그대로 물려받는다.
   */
  constructor(spec: SessionSpec, paneId?: string) {
    const { file, args: baseArgs, kind } = resolveShell(spec)
    const base = { ...(process.env as Record<string, string>), ...(paneId ? { ARA_PANE: paneId } : {}) }
    const { args, env } = withShellIntegration(kind, baseArgs, base)
    const win = process.platform === 'win32'
    // Windows conpty 종료 경로 안정화: useConptyDll=true 는 kill() 시 node-pty 가
    // conpty_console_list_agent 를 child_process.fork 하지 않는다. 그 fork 는 AttachConsole(pid)
    // 로 종료된 셸의 콘솔 프로세스 목록을 조회하는데, teardown 레이스에서 PID 가 이미 사라져
    // "AttachConsole failed" stderr + conhost 창이 화면에 뜨고 fork/flush 타이머 때문에 정리가 지연됐다.
    // conpty.dll 경로는 fork 없이 인프로세스로 종료해 창·지연을 제거한다(VS Code 기본 경로).
    const winOpts = win ? { useConpty: true as const, useConptyDll: true as const } : {}
    /**
     * 복원이 넘겨 준 **그 세션의 마지막 치수**. 없으면 예전대로 80×24 다.
     *
     * 안 쓰면 첫 프롬프트가 80칸에서 접힌다(2026-09-16 준영님 제보 — `Session.cols` 주석).
     * 마운트 직후 resize 가 따라잡지만 **이미 찍힌 줄은 안 고쳐진다.**
     * ⚠️ 값을 그대로 믿지 않는다 — 스냅샷은 손으로 고칠 수 있는 파일이다. 1 미만·비정상은 버린다.
     */
    // 쓸 만한 치수가 아니면(옛 스냅샷의 9×4 등) 기본값으로 연다 — 마운트 직후 resize 가 따라잡는다.
    const sized = usableSize(spec.cols, spec.rows)
    const cols = sized ? (spec.cols as number) : 80
    const rows = sized ? (spec.rows as number) : 24
    try {
      this.pty = ptySpawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.cwd || process.env['HOME'] || process.env['USERPROFILE'] || process.cwd(),
        env,
        ...winOpts
      })
    } catch (err) {
      // pwsh 부재 등 스폰 실패 → cmd 폴백(Windows 한정). cmd 는 OSC7 통합 대상이 아니다.
      if (win && file !== 'cmd.exe') {
        this.pty = ptySpawn('cmd.exe', [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: spec.cwd || process.cwd(),
          env: base,
          ...winOpts
        })
      } else {
        throw err
      }
    }
    // zsh 등 시작 인자/환경 경로가 없는 셸만 stdin 폴백(에코 발생 — osc7.ts 주석 참조).
    // 셸이 준비되기 전에 쓰면 무시되므로 짧게 지연. 실패는 무시(추적은 best-effort).
    if (kind === 'other' && !win) {
      setTimeout(() => {
        try {
          this.pty.write(SHELL_INTEGRATION.posix)
        } catch {
          /* 종료 레이스: 무시 */
        }
      }, POSIX_INJECT_DELAY_MS)
    }
  }

  write(data: string): void {
    this.pty.write(data)
  }
  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows)
    } catch {
      // 종료 레이스: 무시.
    }
  }
  pause(): void {
    this.pty.pause()
  }
  resume(): void {
    this.pty.resume()
  }
  kill(): void {
    const win = process.platform === 'win32'
    // 줄 세워 죽인다(#203, 위 killInTurn). 이미 종료면 kill 이 던지고 줄은 곧장 다음으로 간다.
    // POSIX 는 conpty 가 아니라 기다릴 신호(`_agent`)도 겹칠 벡터도 없다 — 서기만 하고 안 기다린다.
    void killInTurn(
      () => {
        this.pty.kill()
        // 종료 배수 대상으로 등록(위 주석). 로컬 pty 를 죽이는 경로는 여기 하나뿐이다.
        if (win) killedPtys.add(this.pty)
      },
      win ? () => exitReported(this.pty) : () => true
    )
  }
  onData(cb: (data: string) => void): void {
    this.pty.onData((data) => {
      if (!this.da1) return cb(data)
      const r = filterStartupDa1(this.da1, data)
      this.da1 = r.st
      if (r.reply) {
        try {
          this.pty.write(DA1_REPLY)
        } catch {
          /* 종료 레이스: 무시 */
        }
      }
      if (r.out) cb(r.out)
    })
  }
  onExit(cb: (exitCode: number, signal?: number) => void): void {
    this.pty.onExit(({ exitCode, signal }) => cb(exitCode, signal))
  }
}
