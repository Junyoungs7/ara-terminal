// M13 Gemini 사용량 — Orca src/main/rate-limits/gemini-usage-fetcher.ts·gemini-oauth-sources.ts·gemini-cli-oauth-extractor.ts(@fdfcfb3551, MIT)의 핵심.
// 공식 경로: Gemini CLI 로그인 자격(`~/.gemini/oauth_creds.json`)을 **읽기만** 하고, Gemini CLI 가 쓰는 Code Assist 엔드포인트
// (loadCodeAssist → 프로젝트 id, retrieveUserQuota → 모델별 남은 비율)를 묻는다. 쿠키는 쓰지 않는다.
// 토큰이 만료됐으면 설치된 Gemini CLI 패키지 안의 OAuth 클라이언트 값으로 **메모리에서만** 새로 받는다 —
// Orca 는 새 토큰을 oauth_creds.json 에 다시 쓰지만 아라는 사용자 ~/.gemini 에 쓰지 않는다(CLI 가 다음에 돌 때 스스로 갱신한다).
// 🔴 토큰은 요청 헤더·본문에만. 결과에는 실패 종류 코드만.
// 뺀 것: opencode auth.json 경로(다른 앱 폴더)·자격 파일 다시 쓰기.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { classifyHttpFailure, parseGeminiQuota, REQUEST_TIMEOUT_MS, tightestBucket, type ProviderUsage, type UsageFailure } from '@shared/usage'

export const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
export const GEMINI_LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export type PostLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

type Creds = { access_token: string; refresh_token: string; expiry_date: number }

async function readCreds(dir: string): Promise<Creds | null | 'unavailable'> {
  let raw: string
  try {
    raw = await readFile(join(dir, 'oauth_creds.json'), 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'unavailable'
  }
  try {
    const o = JSON.parse(raw) as Partial<Creds>
    return typeof o.access_token === 'string' && typeof o.refresh_token === 'string' && typeof o.expiry_date === 'number' ? (o as Creds) : null
  } catch {
    return 'unavailable'
  }
}

const OAUTH2_SUBPATH = join('dist', 'src', 'code_assist', 'oauth2.js')

/** OAUTH_CLIENT_ID·OAUTH_CLIENT_SECRET 상수(Gemini CLI 소스·번들에 공개로 들어 있는 설치형 앱 값). */
export function parseOAuthClient(content: string): { clientId: string; clientSecret: string } | null {
  const id = content.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/)?.[1]
  const secret = content.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)?.[1]
  return id && secret ? { clientId: id, clientSecret: secret } : null
}

const tryRead = async (p: string): Promise<{ clientId: string; clientSecret: string } | null> => {
  try {
    return parseOAuthClient(await readFile(p, 'utf8'))
  } catch {
    return null
  }
}

/** 설치된 gemini 실행 파일 → 패키지(@google/gemini-cli) 뿌리를 위로 8단까지 찾아 oauth2.js·bundle/*.js 에서 값을 읽는다(Orca 와 같은 자리들). */
export async function findOAuthClient(geminiBin: string): Promise<{ clientId: string; clientSecret: string } | null> {
  let cur = dirname(await realpath(geminiBin).catch(() => geminiBin))
  for (let i = 0; i <= 8; i++) {
    for (const root of [cur, join(cur, 'node_modules', '@google', 'gemini-cli'), join(cur, 'lib', 'node_modules', '@google', 'gemini-cli')]) {
      let name: unknown
      try {
        name = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown }).name
      } catch {
        continue
      }
      if (name !== '@google/gemini-cli') continue
      const direct = (await tryRead(join(root, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH))) ?? (await tryRead(join(root, '..', 'gemini-cli-core', OAUTH2_SUBPATH)))
      if (direct) return direct
      const bundle = join(root, 'bundle')
      const files = await readdir(bundle).catch(() => [] as string[])
      for (const f of files.filter((x) => x.endsWith('.js'))) {
        const c = await tryRead(join(bundle, f))
        if (c) return c
      }
    }
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return null
}

const failed = (failure: UsageFailure, now: number): ProviderUsage => ({ provider: 'gemini', session: null, weekly: null, updatedAt: now, status: 'error', failure })
const json = (body: unknown): string => JSON.stringify(body)

export async function fetchGeminiUsage(deps: {
  dir: string
  post: PostLike
  /** gemini 실행 파일 경로(토큰 새로 받기용). 모르면 null — 만료 토큰은 'stale-token'. */
  geminiBin: () => Promise<string | null>
  now: () => number
}): Promise<ProviderUsage> {
  const creds = await readCreds(deps.dir)
  if (creds === 'unavailable') return failed('usage-unavailable', deps.now())
  if (!creds) return failed('missing-credentials', deps.now())
  const req = (url: string, token: string, body: unknown) =>
    deps.post(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: json(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  try {
    let token = creds.access_token
    if (!token || creds.expiry_date < deps.now()) {
      const bin = await deps.geminiBin()
      const client = bin ? await findOAuthClient(bin) : null
      if (!client) return failed('stale-token', deps.now())
      const r = await deps.post(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const fresh = r.ok ? ((await r.json()) as { access_token?: unknown }).access_token : null
      if (typeof fresh !== 'string' || !fresh) return failed(r.ok ? 'parse' : 'stale-token', deps.now())
      token = fresh
    }
    const load = await req(GEMINI_LOAD_URL, token, { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
    if (!load.ok) return failed(classifyHttpFailure(load.status), deps.now())
    const project = ((await load.json()) as { cloudaicompanionProject?: unknown }).cloudaicompanionProject
    // 프로젝트가 없는 계정(Workspace·API 키 등)은 이 경로로 할당량을 알 수 없다.
    if (typeof project !== 'string' || !project) return failed('usage-unavailable', deps.now())
    const q = await req(GEMINI_QUOTA_URL, token, { project })
    if (!q.ok) return failed(classifyHttpFailure(q.status), deps.now())
    const buckets = parseGeminiQuota(await q.json())
    return { provider: 'gemini', session: tightestBucket(buckets), weekly: null, buckets, updatedAt: deps.now(), status: 'ok', source: 'backend' }
  } catch (e) {
    return failed(e instanceof SyntaxError ? 'parse' : 'network', deps.now())
  }
}
