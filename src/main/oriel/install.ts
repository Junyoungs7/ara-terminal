// Oriel 내려받아 설치(사용자가 [Oriel 설치]를 누를 때만 — 자동 다운로드 없음). 계약(Oriel 세션과 합의 2026-11-04):
//  · 배포 자리 `<feed>/latest.yml`(electron-builder generic) + 설치 파일. feed 기본값 = shared/links ORIEL_FEED_URL.
//  · 받은 exe 의 sha512(base64)가 latest.yml 과 같을 때만 실행 — `/S /currentuser`(사용자별 %LOCALAPPDATA%\Programs\Oriel, 화면 없이).
//  · 실행은 runProcess(셸 안 거침). 종료 코드 0 → Oriel 감지를 다시(status(true)). 설치 뒤 Oriel 을 띄우지는 않는다(미정).
//  · 내려받은 파일은 userData 아래 임시 폴더 — 끝나면(성공·실패 모두) 지운다.
import { createHash } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { runProcess, type RunOptions, type RunResult } from '../util/runProcess'
import type { OrielInstallState, OrielStatus } from '@shared/oriel'

type Run = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

/** 설치 프로그램 상한 — 보통 수십 초. 넘으면 실패(exit)로 본다. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** 진행률 push 간격 — 덩어리(수십 KB)마다 보내면 100MB 에 수천 번이다. */
const PROGRESS_EVERY_MS = 150
export const ORIEL_INSTALL_ARGS = ['/S', '/currentuser'] as const

export type OrielRelease = { version: string; url: string; sha512: string; size: number }

/** latest.yml → 받을 파일 하나(files[0], 없으면 옛 모양 path·sha512). 칸이 없거나 YAML 이 아니면 null. */
export function parseLatestYml(text: string): OrielRelease | null {
  let v: unknown
  try {
    v = load(text)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const f = (Array.isArray(o['files']) && o['files'][0] && typeof o['files'][0] === 'object' ? o['files'][0] : {}) as Record<string, unknown>
  const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
  const version = str(o['version']) ?? (typeof o['version'] === 'number' ? String(o['version']) : null)
  const url = str(f['url']) ?? str(o['path'])
  const sha512 = str(f['sha512']) ?? str(o['sha512'])
  if (!version || !url || !sha512) return null
  return { version, url, sha512, size: typeof f['size'] === 'number' ? f['size'] : 0 }
}

export type OrielInstaller = { state(): OrielInstallState; install(): Promise<OrielInstallState> }

export function createOrielInstaller(deps: {
  /** 배포 자리(설정값, 빈 값이면 부르는 쪽이 기본값을 준다). */
  feedUrl: () => string
  /** 임시 폴더를 둘 자리(userData). */
  tmpRoot: string
  /** 설치 끝 → 다시 감지(oriel.status(true)). */
  redetect: () => Promise<OrielStatus>
  onState: (s: OrielInstallState) => void
  run?: Run
  fetch?: typeof fetch
}): OrielInstaller {
  const run = deps.run ?? runProcess
  const get = deps.fetch ?? fetch
  let state: OrielInstallState = { phase: 'idle' }
  let busy: Promise<OrielInstallState> | null = null
  const set = (s: OrielInstallState): OrielInstallState => ((state = s), deps.onState(s), s)
  const fail = (reason: Extract<OrielInstallState, { phase: 'error' }>['reason'], detail?: string): OrielInstallState =>
    set({ phase: 'error', reason, ...(detail ? { detail } : {}) })
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  const go = async (): Promise<OrielInstallState> => {
    set({ phase: 'download', got: 0, total: 0 })
    const feed = deps.feedUrl().trim().replace(/\/?$/, '/')
    let rel: OrielRelease | null
    try {
      const r = await get(new URL('latest.yml', feed))
      if (!r.ok) return fail('feed', `HTTP ${r.status}`)
      rel = parseLatestYml(await r.text())
    } catch (e) {
      return fail('feed', msg(e))
    }
    if (!rel) return fail('parse')
    let fileUrl: URL
    try {
      fileUrl = new URL(rel.url, feed)
    } catch {
      return fail('parse')
    }
    if (fileUrl.protocol !== 'http:' && fileUrl.protocol !== 'https:') return fail('parse')

    const dir = join(deps.tmpRoot, 'oriel-install')
    const exe = join(dir, 'oriel-setup.exe') // 이름은 고정 — latest.yml 의 글을 경로에 넣지 않는다.
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      // 받기 + sha512 를 한 번에.
      const hash = createHash('sha512')
      try {
        const r = await get(fileUrl)
        if (!r.ok || !r.body) return fail('download', `HTTP ${r.status}`)
        const total = Number(r.headers.get('content-length')) || rel.size
        const fh = await open(exe, 'w')
        let got = 0
        let last = 0
        try {
          for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
            hash.update(chunk)
            await fh.write(chunk)
            got += chunk.length
            if (Date.now() - last >= PROGRESS_EVERY_MS) {
              last = Date.now()
              set({ phase: 'download', got, total })
            }
          }
        } finally {
          await fh.close()
        }
        set({ phase: 'download', got, total: total || got })
      } catch (e) {
        return fail('download', msg(e))
      }
      if (hash.digest('base64') !== rel.sha512) return fail('sha512')

      set({ phase: 'install' })
      const r = await run(exe, ORIEL_INSTALL_ARGS, { timeoutMs: INSTALL_TIMEOUT_MS })
      if (r.error || r.code !== 0) return fail('exit', String(r.code))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    const s = await deps.redetect().catch(() => null)
    return s?.installed ? set({ phase: 'done' }) : fail('missing')
  }

  return {
    state: () => state,
    install: () => (busy ??= go().finally(() => (busy = null)))
  }
}
