// PtyBackend — node-pty를 SessionBackend로 감싸는 어댑터 (로컬 셸).
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

// Windows: pwsh(신형)→powershell(구형)→cmd. mac/linux: 로그인 셸 env→zsh→bash.
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
 * 셸 선택 규칙(pwsh → powershell → cmd)을 두 벌로 만들지 않으려고 위 resolveShell 을 그대로 탄다.
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

// 종료 직전에 한 번 부른다(main/index.ts before-quit). kill 한 pty 의 exit 콜백이 전부 메인 루프에
// 도착할 때까지(또는 상한까지) 기다린다.
// 죽인 pty 가 없으면(POSIX·세션 0개) 즉시 끝난다 — 종료가 이유 없이 느려지지 않게.
export async function drainKilledPtys(): Promise<void> {
  if (killedPtys.size === 0) return
  const deadline = Date.now() + EXIT_DRAIN_CAP_MS
  while (killedPtys.size > 0 && Date.now() < deadline) {
    for (const p of killedPtys) if (exitReported(p)) killedPtys.delete(p)
    if (killedPtys.size === 0) break
    await new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_POLL_MS))
  }
  killedPtys.clear()
}

export class PtyBackend implements SessionBackend {
  private readonly pty: IPty

  constructor(spec: SessionSpec) {
    const { file, args: baseArgs, kind } = resolveShell(spec)
    const { args, env } = withShellIntegration(kind, baseArgs, process.env as Record<string, string>)
    const win = process.platform === 'win32'
    // Windows conpty 종료 경로 안정화: useConptyDll=true 는 kill() 시 node-pty 가
    // conpty_console_list_agent 를 child_process.fork 하지 않는다. 그 fork 는 AttachConsole(pid)
    // 로 종료된 셸의 콘솔 프로세스 목록을 조회하는데, teardown 레이스에서 PID 가 이미 사라져
    // "AttachConsole failed" stderr + conhost 창이 화면에 뜨고 fork/flush 타이머 때문에 정리가 지연됐다.
    // conpty.dll 경로는 fork 없이 인프로세스로 종료해 창·지연을 제거한다(VS Code 기본 경로).
    const winOpts = win ? { useConpty: true as const, useConptyDll: true as const } : {}
    try {
      this.pty = ptySpawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: spec.cwd || process.env['HOME'] || process.env['USERPROFILE'] || process.cwd(),
        env,
        ...winOpts
      })
    } catch (err) {
      // pwsh 부재 등 스폰 실패 → cmd 폴백(Windows 한정). cmd 는 OSC7 통합 대상이 아니다.
      if (win && file !== 'cmd.exe') {
        this.pty = ptySpawn('cmd.exe', [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: spec.cwd || process.cwd(),
          env: process.env as Record<string, string>,
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
    try {
      this.pty.kill()
      // 종료 배수 대상으로 등록(위 주석). 로컬 pty 를 죽이는 경로는 여기 하나뿐이다.
      if (process.platform === 'win32') killedPtys.add(this.pty)
    } catch {
      // 이미 종료: 무시.
    }
  }
  onData(cb: (data: string) => void): void {
    this.pty.onData(cb)
  }
  onExit(cb: (exitCode: number, signal?: number) => void): void {
    this.pty.onExit(({ exitCode, signal }) => cb(exitCode, signal))
  }
}
