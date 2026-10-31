// M3 AI-01 설치 감지 — Orca agent-detection-shell-path.ts·hydrate-shell-path.ts·agent-cli-version-probe.ts(orcaRef 7a7f46f8a3)의 핵심.
// ① 로그인 셸의 PATH 를 한 번 읽어 앱 PATH 에 합친다(GUI 로 켠 앱은 셸 프로필의 PATH 를 모른다 — nvm·npm 전역·~/.local/bin).
// ② where/which 로 경로를 찾고 ③ `--version` 으로 판을 읽는다. 모두 runProcess(셸 안 거침·시간 상한).
// 시험은 run 을 바꿔 끼운다 — 진짜 claude/codex/gemini 를 띄우지 않는다.
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import { AGENT_IDS, AGENTS, SHELL_PATH_MARK, firstCommandPath, mergePathSegments, parseCliVersion, parseShellPath, type AgentId, type DetectedAgent } from '@shared/agents'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

// Orca: 프로필을 읽는 셸은 6~7초 걸린 실측이 있어 10초.
const SHELL_PATH_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 5_000
const WHERE_TIMEOUT_MS = 4_000

export function createAgentDetector(deps: { run?: Run; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}) {
  const run = deps.run ?? runProcess
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const win = platform === 'win32'
  const sep = win ? ';' : ':'
  let hydrated: Promise<void> | null = null

  /** 로그인 셸 PATH → 앱 PATH(없는 조각만 뒤에). 실패하면 지금 PATH 그대로 — 감지는 계속한다. */
  const hydrate = async (): Promise<void> => {
    const r = win
      ? // Windows: 프로필을 읽은 powershell 의 PATH + 레지스트리의 사용자·시스템 PATH(설치 직후 앱이 모르는 값).
        await run(
          'powershell.exe',
          [
            '-NoLogo',
            '-NonInteractive',
            '-Command',
            `Write-Output ('${SHELL_PATH_MARK}' + $env:Path + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + '${SHELL_PATH_MARK}')`
          ],
          { timeoutMs: SHELL_PATH_TIMEOUT_MS }
        )
      : await run(env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), ['-ilc', `printf '%s%s%s' '${SHELL_PATH_MARK}' "$PATH" '${SHELL_PATH_MARK}'`], {
          timeoutMs: SHELL_PATH_TIMEOUT_MS
        })
    // 펴지지 않은 %VAR% 조각(레지스트리 REG_EXPAND_SZ)은 버린다.
    const segments = parseShellPath(r.stdout, sep).filter((s) => !s.includes('%'))
    if (segments.length) env.PATH = mergePathSegments(env.PATH ?? '', segments, sep, win)
  }

  const probe = async (id: AgentId): Promise<DetectedAgent> => {
    const bin = AGENTS[id].bin
    const where = await run(win ? 'where' : 'which', [bin], { timeoutMs: WHERE_TIMEOUT_MS })
    const path = where.error ? null : firstCommandPath(where.stdout, win)
    if (!path) return { id, installed: false, path: null, version: null }
    // Windows 의 npm 셔임(.cmd)은 cmd.exe 없이 못 뜬다(CVE-2024-27980 뒤 EINVAL) — 이름(표의 상수)으로 cmd 에 맡긴다.
    const v = win
      ? await run(env.ComSpec || 'cmd.exe', ['/d', '/c', bin, '--version'], { timeoutMs: VERSION_TIMEOUT_MS })
      : await run(path, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
    // 판을 못 읽어도 설치는 된 것(Orca: unknown 은 실행을 막지 않는다).
    return { id, installed: true, path, version: v.error ? null : parseCliVersion(`${v.stdout}\n${v.stderr}`) }
  }

  return {
    /** force = 설정의 [다시 찾기] — 셸 PATH 도 다시 읽는다. */
    async detect(force = false): Promise<DetectedAgent[]> {
      if (force || !hydrated) hydrated = hydrate().catch(() => undefined)
      await hydrated
      return Promise.all(AGENT_IDS.map(probe))
    }
  }
}
