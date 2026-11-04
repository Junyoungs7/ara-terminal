// M9 R2 — Oriel 감지·링크 열기(main). 순수 규칙은 shared/oriel.ts. 아라 안 브라우저는 없앴다(결정 :162 — 브라우저는 무조건 Oriel).
// 프로세스는 runProcess(셸 안 거침·시간 상한). 시험은 run 을 바꿔 끼운다 — 진짜 Oriel 을 띄우지 않는다.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import { isSafeExternal } from '../util/safeExternal'
import { NODE_RUNNER, parseOrielVersion, pickOriel, type OrielInfo, type OrielKind, type OrielRunner, type OrielStatus } from '@shared/oriel'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

const VERSION_TIMEOUT_MS = 8_000
const OPEN_TIMEOUT_MS = 15_000
/** 전경 허락 PowerShell 상한 — 실측 0.9~1.2초(Add-Type 컴파일, 2026-11-02 이 PC). 넘으면 포기하고 open 은 그대로. */
const FOREGROUND_TIMEOUT_MS = 5_000

/**
 * Oriel 폴더 dir 의 CLI 를 띄우는 법(UB-1: 아라와 Oriel 은 따로 설치하는 호환 제품 — Electron 을 같이 쓰지 않는다).
 *  · 단독 설치본: 자기 Oriel.exe + `ELECTRON_RUN_AS_NODE=1` — 앱도 그 Oriel.exe 로 뜬다(CLI 기본값).
 *  · 그 밖(개발 체크아웃·설정에 적은 폴더): 아라 Electron(execPath) + `ELECTRON_RUN_AS_NODE=1`(node 없는 PC — M4 데몬과 같은 길)
 *    — 앱은 Oriel 이 스스로 정한 Electron 으로 뜬다. `ORIEL_ELECTRON` 은 Oriel 쪽 개발·시험용이라 아라는 넣지 않는다.
 */
export function araOrielRunner(dir: string, execPath: string, exists: (p: string) => boolean = existsSync): OrielRunner {
  return { command: standaloneOrielExe(dir, exists) ?? execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** OR-3 단독 설치본의 실행 파일 이름(Oriel 설치 파일 f52f95d — Windows 전용 배포). */
const ORIEL_EXE = 'Oriel.exe'

/**
 * OR-3 Oriel 앱 폴더 dir 이 단독 설치본(`<설치>/resources/app`, 옆 `<설치>/Oriel.exe`)이면 그 Oriel.exe, 아니면 null.
 * 판별은 폴더 구조만(oriel-integration.md "설치본 판별은 폴더 구조").
 */
export function standaloneOrielExe(dir: string, exists: (p: string) => boolean = existsSync): string | null {
  if (basename(dir).toLowerCase() !== 'app' || basename(dirname(dir)).toLowerCase() !== 'resources') return null
  const exe = join(dirname(dirname(dir)), ORIEL_EXE)
  return exists(exe) ? exe : null
}

/** OR-3 설정 칸에 설치 폴더(`…/Programs/Oriel`)를 적어도 받는다 — 그 안의 resources/app 이 앱 폴더. */
export function orielAppDir(dir: string, exists: (p: string) => boolean = existsSync): string {
  const app = join(dir, 'resources', 'app')
  return exists(join(app, 'bin', 'oriel.mjs')) && exists(join(dir, ORIEL_EXE)) ? app : dir
}

/** OR-3 Oriel 앱 폴더의 종류(설정 화면 표시·우선순위 근거). */
export function orielKindOf(dir: string, exists: (p: string) => boolean = existsSync): OrielKind {
  return standaloneOrielExe(dir, exists) ? 'standalone' : 'dev'
}

const powershellExe = (): string => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** 실행 중 프로세스의 실행 파일 경로(Windows) — 여러 Oriel 중 떠 있는 것을 가린다. 못 알면 null. */
const PROCESS_PATH_TIMEOUT_MS = 5_000
async function processPathWin(run: Run, pid: number): Promise<string | null> {
  const r = await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Math.trunc(pid)}).Path`], { timeoutMs: PROCESS_PATH_TIMEOUT_MS })
  return r.error ? null : r.stdout.trim() || null
}

/**
 * Windows 전경 잠금 — 사용자가 누른 링크에서만, `oriel open` 직전에 아라 메인의 **직접 자식** PowerShell 이
 * AllowSetForegroundWindow(-1)(ASFW_ANY)를 부른다(Oriel README open 항목). 손자(Oriel CLI 가 띄우는 것)는 권한이 없을 수 있다.
 * 에이전트·MCP 경로에서는 부르지 않는다 — 사용자 작업 중에 창이 앞으로 튀어나오면 안 된다(tests/oriel.test.ts 가 막는다).
 */
export const FOREGROUND_SCRIPT =
  `Add-Type -Name U -Namespace Asfw -MemberDefinition '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);'; [void][Asfw.U]::AllowSetForegroundWindow(-1)`

export type Oriel = {
  /** 설치 감지. 결과를 기억한다 — force(설정의 [다시 찾기]·경로 바꿈)면 다시. `running` 은 그 순간 값이다. */
  status(force?: boolean): Promise<OrielStatus>
  /**
   * 링크를 Oriel 에서 연다(`oriel open <url>` — 꺼져 있으면 Oriel 이 띄운다). 미설치·실패면 OS 기본 브라우저.
   * http/https 만. @returns 'oriel' | 'external' | false(열 수 없는 주소)
   * @param user 사용자가 직접 누른 링크·[열기]일 때만 true — 그때만 전경 허락(위 FOREGROUND_SCRIPT). MCP·에이전트는 안 준다.
   */
  open(url: string, user?: { gesture: true }): Promise<'oriel' | 'external' | false>
}

export function createOriel(deps: {
  candidates: () => string[]
  openExternal: (url: string) => Promise<void>
  run?: Run
  /** Oriel 폴더별 CLI 실행법(araOrielRunner). 없으면 시스템 node(시험). */
  runner?: (dir: string) => OrielRunner
  /** OR-3 앱 폴더의 종류(orielKindOf). 없으면 dev(시험). */
  kindOf?: (dir: string) => OrielKind
  /** OR-3 실행 중 Oriel(pid)의 실행 파일. 없으면 Windows 는 PowerShell Get-Process, 그 밖은 모름. */
  processPath?: (pid: number) => Promise<string | null>
  platform?: NodeJS.Platform
}): Oriel {
  const run = deps.run ?? runProcess
  const runnerOf = deps.runner ?? (() => NODE_RUNNER)
  const platform = deps.platform ?? process.platform
  let cached: Promise<OrielStatus> | null = null

  const kindOf = deps.kindOf ?? ((): OrielKind => 'dev')
  const processPath = deps.processPath ?? ((pid: number) => (platform === 'win32' ? processPathWin(run, pid) : Promise.resolve(null)))

  // OR-3: 후보를 모두(동시에) 물어보고 고른다 — 실행 중인 것 > 후보 순서(단독 > dev). `version` 은 읽기 전용(앱을 띄우지 않는다).
  const probe = async (): Promise<OrielStatus> => {
    const tried = deps.candidates()
    const found = (
      await Promise.all(
        tried.map(async (raw): Promise<{ info: OrielInfo; runner: OrielRunner; kind: OrielKind } | null> => {
          const dir = orielAppDir(raw)
          const cli = join(dir, 'bin', 'oriel.mjs')
          if (!existsSync(cli)) return null
          // 실행 중이면 토큰 인증까지 해서 pid 를 준다.
          const runner = runnerOf(dir)
          const r = await run(runner.command, [cli, 'version'], { timeoutMs: VERSION_TIMEOUT_MS, env: runner.env })
          const info = r.error ? null : parseOrielVersion(r.stdout)
          return info && existsSync(info.electronPath) && existsSync(info.cliPath) ? { info, runner, kind: kindOf(dir) } : null
        })
      )
    ).filter((f) => f !== null)
    // 하나뿐이면 묻지 않는다. 여럿이고 떠 있으면 그 프로세스의 실행 파일로 어느 판인지 가린다.
    const pid = found.length > 1 ? found.find((f) => f.info.running && f.info.pid)?.info.pid : undefined
    const pick = pickOriel(found, pid ? await processPath(pid).catch(() => null) : null)
    return pick ? { installed: true, ...pick } : { installed: false, tried }
  }

  const status = (force = false): Promise<OrielStatus> => {
    if (force || !cached) cached = probe().catch(() => ({ installed: false as const, tried: [] }))
    return cached
  }

  return {
    status,
    async open(url, user) {
      // http/https 만 — file: 은 Oriel 에도 OS 에도 넘기지 않는다. 호스트 있는 file:(file://server/share)·UNC(\\server\share)는
      // 여는 순간 Windows 가 그 서버에 NTLM 자격 증명을 보낸다(해시 유출). Oriel 도 그런 주소는 종료 코드 2 로 거부한다(89eb2b3).
      // 터미널 출력은 원격 서버가 찍는 신뢰할 수 없는 글이라 OS 기본 동작으로 넘기는 것도 같은 위험이다 → false(열지 않음).
      if (!isSafeExternal(url)) return false
      const s = await status()
      if (s.installed) {
        if (user?.gesture && platform === 'win32') {
          await run(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT], { timeoutMs: FOREGROUND_TIMEOUT_MS })
        }
        // 종료 코드 0 열림 / 1 못 엶 / 2 URL 거부 / 3 실행·연결 실패 → 0 아니면 OS 기본 브라우저(oriel-integration.md 확정).
        // 아라 테마를 따라간다(준영님 2026-11-04, oriel-integration.md). 지원하는 Oriel 에만 붙인다.
        // ponytail: 아라는 지금 다크(글라스) 하나뿐이라 고정 — 라이트 테마가 생기면 설정값을 넘기고 바꿀 때 `oriel theme` 을 부른다.
        const theme = s.info.capabilities?.includes('open-theme') ? ['--theme', 'dark'] : []
        const r = await run(s.runner.command, [s.info.cliPath, 'open', url, ...theme], { timeoutMs: OPEN_TIMEOUT_MS, env: s.runner.env })
        if (!r.error) return 'oriel'
      }
      await deps.openExternal(url).catch(() => {})
      return 'external'
    }
  }
}
