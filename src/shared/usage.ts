// M9 AI-10 사용량·한도 — Claude·Codex 구독(CLI 로그인) 사용량의 순수 규칙(응답 파싱·초기화 시각·실패 시 표시 유지·갱신 간격).
// 출처: stablyai/orca @fdfcfb3551 (MIT) 에서 기능 단위로 옮겼다:
//  · 창·초기화 시각 = src/main/rate-limits/claude-usage-window.ts(mapClaudeUsageWindow·parseClaudeUsageResetTimestamp·isStaleClaudeUsageWindow)
//  · Claude OAuth 응답 = claude-oauth-usage-request.ts(five_hour·seven_day) · 오류 분류 = claude-usage-error-classification.ts
//  · Codex 응답 = codex-backend-usage-client.ts·codex-rate-limit-window-classification.ts·codex-rate-limit-window-mapper.ts
//  · statusLine = src/shared/claude-statusline-rate-limits.ts(parseWindow) · 실시간 반영 = service/service-fetch-policy.ts(ingestLiveClaudeRateLimits)
//  · 실패 시 표시 유지·재시도 간격 = service/service-result-policy.ts(applyStalePolicy·withoutResetWindows)·service-types.ts·service-polling.ts
// 뺀 것(2차 M13 또는 아라에 없음): Fable 주간·추가 사용량(크레딧)·월 지출·Codex 리셋 크레딧·계정 여러 개·Gemini 등 다른 프로바이더·
//  Codex app-server RPC 경로(아라는 결정 6 대로 wham/usage 만)·PTY `/usage` 대체 경로.

export type UsageProvider = 'claude' | 'codex'

/** 한 창(5시간·주간). usedPercent 0~100, resetsAt 은 ms(모르면 null). */
export type UsageWindow = { usedPercent: number; windowMinutes: number; resetsAt: number | null }

/**
 * 실패 종류 — 화면은 이걸로 한 줄 설명을 고른다(토큰·응답 본문은 싣지 않는다).
 * missing-credentials = CLI 로그인 파일이 없거나 토큰이 없다(API 키 사용자 포함) · stale-token = 401/403(CLI 가 다음에 돌 때 갱신한다)
 * rate-limited = 429 · missing-scope = 토큰에 user:profile 권한이 없다 · server = 5xx · network·parse = 요청이 본문 전에 실패.
 */
export type UsageFailure = 'missing-credentials' | 'stale-token' | 'rate-limited' | 'missing-scope' | 'server' | 'network' | 'parse' | 'usage-unavailable'

export type ProviderUsage = {
  provider: UsageProvider
  session: UsageWindow | null
  weekly: UsageWindow | null
  /** Codex 요금제(plus·pro …). Claude 는 없다. */
  planType?: string | null
  /** 마지막으로 결과를 정한 때(ms). 처음엔 0. */
  updatedAt: number
  status: 'fetching' | 'ok' | 'error'
  failure?: UsageFailure
  /** 429 Retry-After — 이 시각 전에는 자동 조회를 하지 않는다. */
  retryAtMs?: number
  /** 값이 어디서 왔나 — live = 에이전트 탭 statusLine·아라 채팅 rate_limit_event. */
  source?: 'oauth' | 'live' | 'backend'
}

export type UsageState = { claude: ProviderUsage | null; codex: ProviderUsage | null }

export const EMPTY_USAGE: UsageState = { claude: null, codex: null }

// ── Orca service-types.ts 값 그대로 ──
/** 배경 조회 주기(창이 보이고 포커스가 있을 때만). Claude 사용량 엔드포인트는 예산이 빡빡하다 — 최근 값을 429 보다 앞세운다. */
export const DEFAULT_POLL_MS = 15 * 60 * 1000
/** 창이 다시 활성화될 때, 마지막 확인이 이보다 오래면 다시 묻는다. */
export const MIN_REFETCH_MS = 5 * 60 * 1000
/** 실패한 프로바이더의 재시도 간격 바닥(30초) — 연속 실패면 두 배씩, 조회 주기(15분)까지. */
export const ACTIVE_FAILURE_REFETCH_MS = 30 * 1000
export const MAX_ACTIVE_FAILURE_REFETCH_MS = DEFAULT_POLL_MS
export const MAX_ACTIVE_FAILURE_STREAK = 8
/** 실패해도 직전 값을 이만큼은 보여 준다(빈 막대 깜빡임 방지). */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000
/** 429·잠든 Claude 로그인의 만료 토큰은 더 오래 간다 — 정보성 값이라 보이게 둔다. */
export const LONG_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000
/** 같은 값의 실시간 보고를 이 안에서는 다시 내보내지 않는다(렌더러 push 홍수 방지). */
export const LIVE_INGEST_DEDUPE_MS = 30 * 1000
/** 악성·깨진 Retry-After 가 조회를 무한히 막지 못하게. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
export const REQUEST_TIMEOUT_MS = 10_000

export const SESSION_MINUTES = 300
export const WEEKLY_MINUTES = 10080

// ── 초기화 시각 ──

/** 1e10 이 그럴듯한 epoch 초(2286년 전)와 ms(2001년 뒤)를 가른다. 숫자·숫자 문자열·ISO 를 받는다. */
export function parseResetTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 10_000_000_000 ? value : value * 1000
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const n = Number(value)
  if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `{ utilization | used_percentage, resets_at }`(OAuth·statusLine 공통) → 창. % 가 없으면 null. */
export function mapClaudeWindow(raw: unknown, windowMinutes: number): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown }
  const used = num(o.utilization) ?? num(o.used_percentage)
  if (used === null) return null
  return { usedPercent: Math.min(100, Math.max(0, used)), windowMinutes, resetsAt: parseResetTimestamp(o.resets_at) }
}

/** `api.anthropic.com/api/oauth/usage` 본문 → 5시간·주간. */
export function parseClaudeOAuthUsage(data: unknown): { session: UsageWindow | null; weekly: UsageWindow | null } {
  const d = (data && typeof data === 'object' ? data : {}) as { five_hour?: unknown; seven_day?: unknown }
  return { session: mapClaudeWindow(d.five_hour, SESSION_MINUTES), weekly: mapClaudeWindow(d.seven_day, WEEKLY_MINUTES) }
}

/**
 * Claude Code statusLine 입력(JSON)의 `rate_limits`(Claude ≥2.1.80) → 5시간·주간. 쓸 창이 없으면 null.
 * 스키마가 바뀌어도 꺼지지 않게 utilization·문자열 resets_at 도 받는다(Orca parseWindow).
 */
export function parseClaudeStatusLine(payload: unknown): { session: UsageWindow | null; weekly: UsageWindow | null } | null {
  const rl = payload && typeof payload === 'object' ? (payload as { rate_limits?: unknown }).rate_limits : null
  if (!rl || typeof rl !== 'object') return null
  const r = rl as { five_hour?: unknown; seven_day?: unknown }
  const session = mapClaudeWindow(r.five_hour, SESSION_MINUTES)
  const weekly = mapClaudeWindow(r.seven_day, WEEKLY_MINUTES)
  return session || weekly ? { session, weekly } : null
}

// ── Codex(chatgpt.com/backend-api/wham/usage) ──

type CodexSnap = { usedPercent: number; windowDurationMins: number | null; resetsAt: unknown }
const CODEX_DURATION_TOLERANCE = 1

function codexSnap(raw: unknown): CodexSnap | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown }
  const used = num(o.used_percent)
  if (used === null) return null
  const secs = num(o.limit_window_seconds)
  return { usedPercent: used, windowDurationMins: secs !== null && secs > 0 ? Math.ceil(secs / 60) : null, resetsAt: o.reset_at }
}

function codexKind(s: CodexSnap): 'session' | 'weekly' | null {
  const d = s.windowDurationMins
  if (d === null) return null
  if (Math.abs(d - SESSION_MINUTES) <= CODEX_DURATION_TOLERANCE) return 'session'
  if (Math.abs(d - WEEKLY_MINUTES) <= CODEX_DURATION_TOLERANCE) return 'weekly'
  return null
}

/** 창 길이로 5시간·주간을 가린다. 길이를 모르면 옛 규칙(primary = 5시간, secondary = 주간). 같은 종류가 둘이면 앞의 것. */
export function classifyCodexWindows(primary: CodexSnap | null, secondary: CodexSnap | null): { session: CodexSnap | null; weekly: CodexSnap | null } {
  let session: CodexSnap | null = null
  let weekly: CodexSnap | null = null
  for (const w of [primary, secondary]) {
    if (!w) continue
    const k = codexKind(w)
    if (k === 'session' && !session) session = w
    else if (k === 'weekly' && !weekly) weekly = w
  }
  if (!session && primary && codexKind(primary) === null) session = primary
  if (!weekly && secondary && codexKind(secondary) === null) weekly = secondary
  return { session, weekly }
}

function codexWindow(s: CodexSnap | null, fallbackMinutes: number): UsageWindow | null {
  if (!s) return null
  const r = num(s.resetsAt)
  // Codex 초기화 시각은 epoch 초.
  return {
    usedPercent: Math.min(100, Math.max(0, s.usedPercent)),
    windowMinutes: s.windowDurationMins ?? fallbackMinutes,
    resetsAt: r !== null && r > 0 ? r * 1000 : null
  }
}

/** wham/usage 본문 → 사용량. plan_type 이 문자열이 아니면 알아볼 수 없는 응답(null). */
export function parseCodexUsage(data: unknown): { session: UsageWindow | null; weekly: UsageWindow | null; planType: string } | null {
  const d = (data && typeof data === 'object' ? data : {}) as { plan_type?: unknown; rate_limit?: { primary_window?: unknown; secondary_window?: unknown } | null }
  if (typeof d.plan_type !== 'string') return null
  const c = classifyCodexWindows(codexSnap(d.rate_limit?.primary_window), codexSnap(d.rate_limit?.secondary_window))
  return { session: codexWindow(c.session, SESSION_MINUTES), weekly: codexWindow(c.weekly, WEEKLY_MINUTES), planType: d.plan_type }
}

// ── 오류 ──

/** HTTP 상태 → 실패 종류(Orca classifyClaudeOAuthUsageError). 403 에 user:profile 이 언급되면 권한 부족. */
export function classifyHttpFailure(status: number, body = ''): UsageFailure {
  if (status === 429) return 'rate-limited'
  if (status === 401) return 'stale-token'
  if (status === 403) return body.includes('user:profile') ? 'missing-scope' : 'stale-token'
  if (status >= 500) return 'server'
  return 'usage-unavailable'
}

/** Retry-After(RFC 9110: 초 또는 HTTP 날짜) → 기다릴 ms. 없거나 0 이하면 null. 상한 24시간. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const s = Number(value)
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(value) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(ms))
}

// ── 표시 유지·실시간 반영 ──

/** 초기화 시각이 지난 창은 계정을 말하지 않는다(0% 로 두면 다른 기기의 사용을 감춘다) — 뺀다. */
export function withoutResetWindows(p: ProviderUsage, now: number): ProviderUsage {
  const cur = (w: UsageWindow | null): UsageWindow | null => (w && (w.resetsAt === null || w.resetsAt > now) ? w : null)
  return { ...p, session: cur(p.session), weekly: cur(p.weekly) }
}

/**
 * 새 결과를 적용한다. 실패면 직전 값을 잠깐 유지한다(빈 막대 깜빡임 방지) — 기본 30분, 429·Claude 만료 토큰은 24시간.
 * 유지할 때도 status 는 'error'·failure 는 이번 실패(화면이 '오래된 값'임을 안다).
 */
export function applyStalePolicy(fresh: ProviderUsage, previous: ProviderUsage | null, now: number): ProviderUsage {
  if (fresh.status === 'ok' || !previous) return fresh
  const long = fresh.failure === 'rate-limited' || (fresh.failure === 'stale-token' && fresh.provider === 'claude')
  if (now - previous.updatedAt > (long ? LONG_STALE_THRESHOLD_MS : STALE_THRESHOLD_MS)) return fresh
  const kept = withoutResetWindows(previous, now)
  if (!kept.session && !kept.weekly) return fresh
  return { ...kept, status: 'error', failure: fresh.failure, retryAtMs: fresh.retryAtMs, updatedAt: fresh.updatedAt }
}

// 같은 창이라도 statusLine 과 OAuth 의 초기화 시각 정밀도가 다르다. 다른 창은 몇 시간 차이.
const SAME_WINDOW_TOLERANCE_MS = 60 * 1000
const sameReset = (a: number | null, b: number | null): boolean => (a === null || b === null ? a === b : Math.abs(a - b) <= SAME_WINDOW_TOLERANCE_MS)
export const sameWindow = (a: UsageWindow | null, b: UsageWindow | null): boolean => (a && b ? a.usedPercent === b.usedPercent && sameReset(a.resetsAt, b.resetsAt) : a === b)

/** 한 창 안에서 사용량은 는다 — 더 낮은 값이나 더 이른 초기화 시각은 잠든 세션의 낡은 보고다. */
export function isStaleWindow(previous: UsageWindow | null | undefined, incoming: UsageWindow, now: number): boolean {
  if (!previous || previous.resetsAt === null || incoming.resetsAt === null || previous.resetsAt <= now) return false
  if (incoming.resetsAt < previous.resetsAt - SAME_WINDOW_TOLERANCE_MS) return true
  return sameReset(incoming.resetsAt, previous.resetsAt) && incoming.usedPercent < previous.usedPercent
}

/**
 * 실시간 보고(에이전트 탭 statusLine·아라 채팅 rate_limit_event)를 Claude 값에 얹는다. 바꿀 게 없으면 null(내보내지 않음).
 * 일부 창만 온 보고는 안 온 창을 그대로 둔다. 같은 값이 30초 안에 또 오면 무시. 429 Retry-After 는 이어받는다(조회 제한은 그대로).
 */
export function mergeLiveClaude(
  previous: ProviderUsage | null,
  incoming: { session: UsageWindow | null; weekly: UsageWindow | null },
  now: number
): ProviderUsage | null {
  const keep = (inc: UsageWindow | null, cur: UsageWindow | null | undefined): UsageWindow | null => {
    if (!inc || isStaleWindow(cur, inc, now)) return null
    return sameWindow(cur ?? null, inc) ? (cur ?? null) : inc
  }
  const freshSession = keep(incoming.session, previous?.session)
  const freshWeekly = keep(incoming.weekly, previous?.weekly)
  if (!freshSession && !freshWeekly) return null
  const inherited = previous ? withoutResetWindows(previous, now) : null
  const session = freshSession ?? inherited?.session ?? null
  const weekly = freshWeekly ?? inherited?.weekly ?? null
  const droppedStale = (incoming.session && !freshSession) || (incoming.weekly && !freshWeekly)
  if (droppedStale && sameWindow(previous?.session ?? null, session) && sameWindow(previous?.weekly ?? null, weekly)) return null
  if (
    previous?.status === 'ok' &&
    previous.source === 'live' &&
    now - previous.updatedAt < LIVE_INGEST_DEDUPE_MS &&
    sameWindow(previous.session, session) &&
    sameWindow(previous.weekly, weekly)
  )
    return null
  return { provider: 'claude', session, weekly, updatedAt: now, status: 'ok', source: 'live', ...(previous?.retryAtMs ? { retryAtMs: previous.retryAtMs } : {}) }
}

/** 실패가 n 번 이어졌을 때 다음 재시도까지(30초 × 2^(n-1), 15분 상한). */
export function failureRetryMs(streak: number): number {
  return Math.min(ACTIVE_FAILURE_REFETCH_MS * 2 ** Math.max(0, streak - 1), MAX_ACTIVE_FAILURE_REFETCH_MS)
}

/**
 * 창이 다시 활성화됐을 때 무엇을 다시 물을지(Orca getActiveWindowRefreshPlan). 프로바이더마다:
 *  · 값이 없다(처음) → 묻는다 · ok 인데 마지막 확인이 5분 넘었다 → 묻는다
 *  · 실패 → Retry-After 가 살아 있으면 안 묻고, 아니면 마지막 재시도에서 failureRetryMs(연속 실패) 지났을 때만
 */
export function refreshPlan(
  state: UsageState,
  ctx: { now: number; checkedAt: Record<UsageProvider, number | null>; lastRetryAt: Record<UsageProvider, number>; streak: Record<UsageProvider, number> }
): UsageProvider[] {
  const out: UsageProvider[] = []
  for (const p of ['claude', 'codex'] as const) {
    const s = state[p]
    if (!s || s.status === 'fetching') {
      if (!s) out.push(p)
      continue
    }
    if (s.retryAtMs && s.retryAtMs > ctx.now) continue
    if (s.status === 'ok') {
      const c = ctx.checkedAt[p]
      if (c === null || ctx.now - c >= MIN_REFETCH_MS) out.push(p)
      continue
    }
    if (ctx.now - ctx.lastRetryAt[p] >= failureRetryMs(ctx.streak[p])) out.push(p)
  }
  return out
}
