// M9 R2 — Oriel 감지·링크 열기(main). 순수 규칙은 shared/oriel.ts. 아라 안 브라우저는 없앴다(결정 :162 — 브라우저는 무조건 Oriel).
// 프로세스는 runProcess(셸 안 거침·시간 상한). 시험은 run 을 바꿔 끼운다 — 진짜 Oriel 을 띄우지 않는다.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import { isSafeExternal } from '../util/safeExternal'
import { NODE_RUNNER, parseOrielVersion, type OrielRunner, type OrielStatus } from '@shared/oriel'
import { ARA_HOST_APP_ENV, isBundledOrielDir } from './host'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

const VERSION_TIMEOUT_MS = 8_000
const OPEN_TIMEOUT_MS = 15_000
/** 전경 허락 PowerShell 상한 — 실측 0.9~1.2초(Add-Type 컴파일, 2026-11-02 이 PC). 넘으면 포기하고 open 은 그대로. */
const FOREGROUND_TIMEOUT_MS = 5_000

/** Oriel CLI 가 읽는 env(Oriel 89eb2b3) — Oriel 을 띄울 Electron 실행 파일. 아라는 자기 Electron 을 준다(결정: Electron 공유). */
export const ORIEL_ELECTRON_ENV = 'ORIEL_ELECTRON'

/**
 * Oriel 을 띄울 아라 자신의 Electron(절대 경로). 후보 = 실행 중 바이너리(개발·e2e 는 node_modules/electron/dist 의 것) →
 * cwd 의 node_modules electron. 실재 + 옆에 `resources/default_app.asar` 가 있는 것만 — 그 파일이 있어야 Electron 이
 * 인자로 받은 **다른 앱 폴더**(Oriel)를 띄운다. 설치본 A.R.A.exe 는 자기 app.asar 를 먼저 읽어(default_app 없음) Oriel 폴더를
 * 줘도 **아라가 하나 더 뜬다** → 그때는 null(ORIEL_ELECTRON 을 안 준다). 설치본 공유는 결정 필요(or1-done.md).
 */
export function araElectronForOriel(candidates: readonly string[], exists: (p: string) => boolean = existsSync): string | null {
  for (const p of candidates) {
    if (p && isAbsolute(p) && exists(p) && exists(join(dirname(p), 'resources', 'default_app.asar'))) return p
  }
  return null
}

/**
 * OR-2 — Oriel 폴더 dir 의 CLI 를 띄우는 법. 늘 아라 Electron(execPath) + `ELECTRON_RUN_AS_NODE=1`(node 없는 PC — M4 데몬과 같은 길,
 * Electron 기본 fuse RunAsNode 켜짐: electron-builder.yml 에 electronFuses 없음). Oriel CLI 는 앱을 띄울 때 ELECTRON_* 를 걸러 낸다.
 *  · 개발판(devElectron = araElectronForOriel, default_app 있음): ORIEL_ELECTRON = 그것 — 어느 Oriel 폴더든 띄운다.
 *  · 설치본 + dir 이 `<resources>/oriel`: ORIEL_ELECTRON = A.R.A.exe + ARA_HOST_APP=oriel → main/boot.ts 가 Oriel 로 뜬다(안 A).
 *  · 그 밖(설치본에 설정한 체크아웃 등): ORIEL_ELECTRON 없음 → Oriel 이 자기 node_modules electron 으로.
 */
export function araOrielRunner(dir: string, o: { execPath: string; devElectron: string | null; resourcesPath: string | null }): OrielRunner {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  if (o.devElectron) env[ORIEL_ELECTRON_ENV] = o.devElectron
  else if (o.resourcesPath && isBundledOrielDir(dir, o.resourcesPath)) Object.assign(env, { [ORIEL_ELECTRON_ENV]: o.execPath, [ARA_HOST_APP_ENV]: 'oriel' })
  return { command: o.execPath, env }
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
  /** OR-2 Oriel 폴더별 CLI 실행법(araOrielRunner). 없으면 시스템 node(시험). */
  runner?: (dir: string) => OrielRunner
  platform?: NodeJS.Platform
}): Oriel {
  const run = deps.run ?? runProcess
  const runnerOf = deps.runner ?? (() => NODE_RUNNER)
  const platform = deps.platform ?? process.platform
  let cached: Promise<OrielStatus> | null = null

  const probe = async (): Promise<OrielStatus> => {
    const tried = deps.candidates()
    for (const dir of tried) {
      const cli = join(dir, 'bin', 'oriel.mjs')
      if (!existsSync(cli)) continue
      // `version` 은 읽기 전용(앱을 띄우지 않는다) — 실행 중이면 토큰 인증까지 해서 pid 를 준다.
      // ORIEL_ELECTRON 을 같이 줘야 version 의 electronPath 가 실제로 띄울 바이너리다(동봉판은 자기 electron 이 없다).
      const runner = runnerOf(dir)
      const r = await run(runner.command, [cli, 'version'], { timeoutMs: VERSION_TIMEOUT_MS, env: runner.env })
      const info = r.error ? null : parseOrielVersion(r.stdout)
      if (info && existsSync(info.electronPath) && existsSync(info.cliPath)) return { installed: true, info, runner }
    }
    return { installed: false, tried }
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
          const ps = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          await run(ps, ['-NoProfile', '-NonInteractive', '-Command', FOREGROUND_SCRIPT], { timeoutMs: FOREGROUND_TIMEOUT_MS })
        }
        // 종료 코드 0 열림 / 1 못 엶 / 2 URL 거부 / 3 실행·연결 실패 → 0 아니면 OS 기본 브라우저(oriel-integration.md 확정).
        const r = await run(s.runner.command, [s.info.cliPath, 'open', url], { timeoutMs: OPEN_TIMEOUT_MS, env: s.runner.env })
        if (!r.error) return 'oriel'
      }
      await deps.openExternal(url).catch(() => {})
      return 'external'
    }
  }
}
