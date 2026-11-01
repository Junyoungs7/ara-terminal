// M9 AI-10 사용량 서비스 — CLI 로그인 자격으로 구독 사용량을 묻고(Claude OAuth·Codex wham), 실시간 보고를 얹고, 창이 활성일 때만 갱신한다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/rate-limits/{claude-active-usage-fetch,claude-oauth-credentials,claude-oauth-usage-request,
//  codex-backend-auth,codex-backend-usage-client}.ts · service/{service-polling,service-fetch-policy,service-result-policy}.ts — 핵심만.
// 🔴 토큰: CLI 의 자격 파일은 **읽기만** 한다. 토큰은 요청 헤더에만 실리고, 상태·로그·오류 글에 들어가지 않는다. 아라는 따로 저장하지 않는다.
// 🔴 요청은 Orca 와 같은 두 엔드포인트만.
// 뺀 것: macOS 키체인 읽기(맥은 ~/.claude/.credentials.json 이 없으면 '알 수 없음' — 에이전트 탭 statusLine 이 오면 채워진다)·
//  프록시 탐지(Electron net.fetch 가 시스템 프록시를 쓴다)·Codex app-server RPC.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchGeminiUsage, type PostLike } from './gemini'
import {
  applyStalePolicy,
  classifyHttpFailure,
  EMPTY_USAGE,
  MAX_ACTIVE_FAILURE_STREAK,
  MIN_REFETCH_MS,
  mergeLiveClaude,
  parseClaudeOAuthUsage,
  parseCodexUsage,
  parseRetryAfterMs,
  refreshPlan,
  REQUEST_TIMEOUT_MS,
  MAX_CONTEXT_ENTRIES,
  type AccountProvider,
  type AccountsView,
  type ContextUsage,
  type ProviderUsage,
  type UsageFailure,
  type UsagePrefs,
  type UsageProvider,
  type UsageState,
  type UsageWindow
} from '@shared/usage'

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

type ClaudeCreds = { token: string | null; refreshable: boolean; refreshExpiresAt?: number; unavailable?: boolean }

/** `<dir>/.credentials.json` 의 claudeAiOauth. 파일이 없으면 토큰 없음, 읽기·파싱 실패면 unavailable. 토큰은 여기서 밖으로 새지 않게 다룬다. */
export async function readClaudeCreds(dir: string): Promise<ClaudeCreds> {
  let raw: string
  try {
    raw = await readFile(join(dir, '.credentials.json'), 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { token: null, refreshable: false, unavailable: code !== 'ENOENT' && code !== 'ENOTDIR' }
  }
  try {
    const o = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; refreshTokenExpiresAt?: unknown } })?.claudeAiOauth
    return {
      token: typeof o?.accessToken === 'string' && o.accessToken ? o.accessToken : null,
      refreshable: typeof o?.refreshToken === 'string' && o.refreshToken !== '',
      ...(typeof o?.refreshTokenExpiresAt === 'number' ? { refreshExpiresAt: o.refreshTokenExpiresAt } : {})
    }
  } catch {
    return { token: null, refreshable: false, unavailable: true }
  }
}

/** `<dir>/auth.json` → wham 요청 헤더(Orca getCodexBackendAuthHeaders). 토큰이 없으면 null. */
export async function readCodexHeaders(dir: string): Promise<Record<string, string> | null> {
  let auth: { tokens?: { access_token?: unknown; account_id?: unknown } }
  try {
    auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
  } catch {
    return null
  }
  const token = auth?.tokens?.access_token
  if (typeof token !== 'string' || !token) return null
  const h: Record<string, string> = { Authorization: `Bearer ${token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop' }
  if (typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id) h['ChatGPT-Account-Id'] = auth.tokens.account_id
  return h
}

const failed = (provider: UsageProvider, failure: UsageFailure, now: number, retryAtMs?: number): ProviderUsage => ({
  provider,
  session: null,
  weekly: null,
  updatedAt: now,
  status: 'error',
  failure,
  ...(retryAtMs ? { retryAtMs } : {})
})

/** 요청이 본문 전에 던졌다 — JSON 파싱이면 parse, 나머지는 network(Orca classifyThrownUsageRequestError). */
const thrownFailure = (e: unknown): UsageFailure => (e instanceof SyntaxError ? 'parse' : 'network')

export async function fetchClaudeUsage(dir: string, fetch: FetchLike, now: () => number): Promise<ProviderUsage> {
  const creds = await readClaudeCreds(dir)
  if (!creds.token) return failed('claude', creds.unavailable ? 'usage-unavailable' : 'missing-credentials', now())
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) {
      // 본문은 분류에만 쓴다(403 의 user:profile·revoked) — 어디에도 싣지 않는다.
      const body = res.status === 403 || res.status === 401 ? await res.text().catch(() => '') : ''
      const failure = classifyHttpFailure(res.status, body)
      // 만료 토큰은 CLI 가 다음에 돌 때 새로 받는다 — 갱신 토큰이 없거나 만료·취소됐으면 다시 로그인해야 한다.
      const renewable = creds.refreshable && (creds.refreshExpiresAt === undefined || creds.refreshExpiresAt > now()) && !/revoked/i.test(body)
      const retry = res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after'), now()) : null
      return failed('claude', failure === 'stale-token' && !renewable ? 'missing-credentials' : failure, now(), retry ? now() + retry : undefined)
    }
    const { session, weekly } = parseClaudeOAuthUsage(await res.json())
    return { provider: 'claude', session, weekly, updatedAt: now(), status: 'ok', source: 'oauth' }
  } catch (e) {
    return failed('claude', thrownFailure(e), now())
  }
}

export async function fetchCodexUsage(dir: string, fetch: FetchLike, now: () => number): Promise<ProviderUsage> {
  const headers = await readCodexHeaders(dir)
  if (!headers) return failed('codex', 'missing-credentials', now())
  try {
    const res = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) return failed('codex', classifyHttpFailure(res.status), now())
    const u = parseCodexUsage(await res.json())
    if (!u) return failed('codex', 'parse', now())
    return { provider: 'codex', session: u.session, weekly: u.weekly, planType: u.planType, updatedAt: now(), status: 'ok', source: 'backend' }
  } catch (e) {
    return failed('codex', thrownFailure(e), now())
  }
}

export type UsageService = {
  state(): UsageState
  /** force = 사람이 누른 새로 고침(Retry-After·최근 확인 무시). 아니면 활성화 규칙(refreshPlan)대로. */
  refresh(force?: boolean): Promise<UsageState>
  /** 15분 주기 — 창이 활성일 때만(Retry-After 는 지킨다). */
  poll(): Promise<void>
  /** 에이전트 탭 statusLine·아라 채팅 rate_limit_event 의 실시간 값. account = 그 값을 낸 Claude 계정(null = 시스템 기본) — 지금 고른 계정이 아니면 버린다. */
  ingestClaudeLive(w: { session: UsageWindow | null; weekly: UsageWindow | null }, account?: string | null): void
  /** M13 에이전트 탭(pane)의 컨텍스트 사용량. */
  ingestContext(pane: string, c: ContextUsage): void
  /** M13 계정 목록이 바뀌었다 — 고른 계정이 바뀐 프로바이더는 값을 비우고 다시 묻는다(Orca: 계정 전환 = 다시 묻기). */
  setAccounts(v: AccountsView): void
  setPrefs(p: UsagePrefs): void
  /** M13 계정 하나의 사용량(계정 목록에서 — 사람이 열 때만). 지금 고른 계정이면 저장소 값. */
  accountUsage(p: AccountProvider, dir: string): Promise<ProviderUsage>
}

export function createUsageService(deps: {
  claudeDir: () => string
  codexDir: () => string
  fetch: FetchLike
  /** M13 Gemini — prefs.gemini 가 켜졌을 때만 묻는다. */
  gemini?: { dir: () => string; post: PostLike; bin: () => Promise<string | null> }
  accounts?: AccountsView
  prefs?: UsagePrefs
  push: (s: UsageState) => void
  /** 창이 보이고 포커스가 있나 — 아니면 배경 조회를 쉰다(Orca shouldBackgroundPoll). */
  windowActive: () => boolean
  now?: () => number
}): UsageService {
  const now = deps.now ?? Date.now
  let state: UsageState = { ...EMPTY_USAGE, ...(deps.accounts ? { accounts: deps.accounts } : {}), ...(deps.prefs ? { prefs: deps.prefs } : {}) }
  const checkedAt: Record<UsageProvider, number | null> = { claude: null, codex: null, gemini: null }
  const lastRetryAt: Record<UsageProvider, number> = { claude: 0, codex: 0, gemini: 0 }
  const streak: Record<UsageProvider, number> = { claude: 0, codex: 0, gemini: 0 }
  const providers = (): UsageProvider[] => (state.prefs.gemini && deps.gemini ? ['claude', 'codex', 'gemini'] : ['claude', 'codex'])
  const fetchFresh = (p: UsageProvider): Promise<ProviderUsage> =>
    p === 'claude'
      ? fetchClaudeUsage(deps.claudeDir(), deps.fetch, now)
      : p === 'codex'
        ? fetchCodexUsage(deps.codexDir(), deps.fetch, now)
        : fetchGeminiUsage({ dir: deps.gemini!.dir(), post: deps.gemini!.post, geminiBin: deps.gemini!.bin, now })
  const reset = (p: UsageProvider): void => {
    state = { ...state, [p]: null }
    checkedAt[p] = null
    lastRetryAt[p] = 0
    streak[p] = 0
  }
  const inflight: Partial<Record<UsageProvider, Promise<void>>> = {}
  const generation: Record<UsageProvider, number> = { claude: 0, codex: 0, gemini: 0 }

  const set = (p: UsageProvider, v: ProviderUsage): void => {
    state = { ...state, [p]: v }
    deps.push(state)
  }

  const fetchOne = (p: UsageProvider): Promise<void> => {
    const running = inflight[p]
    if (running) return running
    const job: Promise<void> = (async () => {
      if (!state[p]) set(p, { provider: p, session: null, weekly: null, updatedAt: 0, status: 'fetching' })
      const gen = generation[p]
      const fresh = await fetchFresh(p)
      // 묻는 사이 계정이 바뀌었으면 옛 계정의 답은 버린다.
      if (gen !== generation[p]) return
      const t = now()
      checkedAt[p] = t
      streak[p] = fresh.status === 'error' ? Math.min(streak[p] + 1, MAX_ACTIVE_FAILURE_STREAK) : 0
      const cur = state[p]
      // 실패한 OAuth 가 더 새로운 실시간 값을 덮지 않는다 — Retry-After 만 넘겨 조회 제한에 쓴다(Orca resolveClaudeFetchApply).
      if (p === 'claude' && fresh.status !== 'ok' && cur?.status === 'ok' && cur.source === 'live' && t - cur.updatedAt < MIN_REFETCH_MS) {
        set(p, fresh.retryAtMs ? { ...cur, retryAtMs: fresh.retryAtMs } : cur)
        return
      }
      set(p, applyStalePolicy(fresh, cur?.status === 'fetching' ? null : cur, t))
    })().finally(() => {
      if (inflight[p] === job) delete inflight[p]
    })
    inflight[p] = job
    return job
  }

  const retryAfterActive = (p: UsageProvider): boolean => Boolean(state[p]?.retryAtMs && state[p]!.retryAtMs! > now())

  return {
    state: () => state,
    async refresh(force = false) {
      const t = now()
      const targets = force ? providers() : refreshPlan(state, { now: t, checkedAt, lastRetryAt, streak }, providers())
      for (const p of targets) if (state[p]?.status === 'error') lastRetryAt[p] = t
      await Promise.all(targets.map(fetchOne))
      return state
    },
    async poll() {
      if (!deps.windowActive()) return
      await Promise.all(providers().filter((p) => !retryAfterActive(p)).map(fetchOne))
    },
    ingestClaudeLive(w, account = null) {
      if (account !== state.accounts.claude.active) return
      const next = mergeLiveClaude(state.claude, w, now())
      if (!next) return
      streak.claude = 0
      set('claude', next)
    },
    ingestContext(pane, c) {
      const prev = state.context[pane]
      if (prev && prev.usedPercent === c.usedPercent && prev.model === c.model && prev.windowTokens === c.windowTokens) return
      const entries = Object.entries({ ...state.context, [pane]: c }).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CONTEXT_ENTRIES)
      state = { ...state, context: Object.fromEntries(entries) }
      deps.push(state)
    },
    setAccounts(v) {
      const changed = (['claude', 'codex'] as const).filter((p) => v[p].active !== state.accounts[p].active)
      state = { ...state, accounts: v }
      for (const p of changed) {
        generation[p]++
        delete inflight[p]
        reset(p)
      }
      deps.push(state)
      if (changed.length) void Promise.all(changed.map(fetchOne))
    },
    setPrefs(p) {
      const geminiOn = p.gemini && !state.prefs.gemini
      state = { ...state, prefs: p }
      if (!p.gemini) reset('gemini')
      deps.push(state)
      if (geminiOn && deps.gemini) void fetchOne('gemini')
    },
    accountUsage(p, dir) {
      return p === 'claude' ? fetchClaudeUsage(dir, deps.fetch, now) : fetchCodexUsage(dir, deps.fetch, now)
    }
  }
}
