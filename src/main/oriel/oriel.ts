// M9 R2 — Oriel 감지·링크 열기(main). 순수 규칙은 shared/oriel.ts. 아라 안 브라우저는 없앴다(결정 :162 — 브라우저는 무조건 Oriel).
// 프로세스는 runProcess(셸 안 거침·시간 상한). 시험은 run 을 바꿔 끼운다 — 진짜 Oriel 을 띄우지 않는다.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import { isSafeExternal } from '../util/safeExternal'
import { parseOrielVersion, type OrielStatus } from '@shared/oriel'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

const VERSION_TIMEOUT_MS = 8_000
const OPEN_TIMEOUT_MS = 15_000

export type Oriel = {
  /** 설치 감지. 결과를 기억한다 — force(설정의 [다시 찾기]·경로 바꿈)면 다시. `running` 은 그 순간 값이다. */
  status(force?: boolean): Promise<OrielStatus>
  /**
   * 링크를 Oriel 에서 연다(`oriel open <url>` — 꺼져 있으면 Oriel 이 띄운다). 미설치·실패면 OS 기본 브라우저.
   * http/https 만. @returns 'oriel' | 'external' | false(열 수 없는 주소)
   */
  open(url: string): Promise<'oriel' | 'external' | false>
}

export function createOriel(deps: { candidates: () => string[]; openExternal: (url: string) => Promise<void>; run?: Run }): Oriel {
  const run = deps.run ?? runProcess
  let cached: Promise<OrielStatus> | null = null

  const probe = async (): Promise<OrielStatus> => {
    const tried = deps.candidates()
    for (const dir of tried) {
      const cli = join(dir, 'bin', 'oriel.mjs')
      if (!existsSync(cli)) continue
      // `version` 은 읽기 전용(앱을 띄우지 않는다) — 실행 중이면 토큰 인증까지 해서 pid 를 준다.
      const r = await run('node', [cli, 'version'], { timeoutMs: VERSION_TIMEOUT_MS })
      const info = r.error ? null : parseOrielVersion(r.stdout)
      if (info && existsSync(info.electronPath) && existsSync(info.cliPath)) return { installed: true, info }
    }
    return { installed: false, tried }
  }

  const status = (force = false): Promise<OrielStatus> => {
    if (force || !cached) cached = probe().catch(() => ({ installed: false as const, tried: [] }))
    return cached
  }

  return {
    status,
    async open(url) {
      if (!isSafeExternal(url)) return false
      const s = await status()
      if (s.installed) {
        // ponytail: Oriel 1dfc0a0 에는 `open` 명령이 아직 없다(Oriel 세션에 요청) — 그동안은 0 아닌 종료로 OS 브라우저로 떨어진다.
        const r = await run('node', [s.info.cliPath, 'open', url], { timeoutMs: OPEN_TIMEOUT_MS })
        if (!r.error) return 'oriel'
      }
      await deps.openExternal(url).catch(() => {})
      return 'external'
    }
  }
}
