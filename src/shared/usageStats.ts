// M13 통계(Orca src/renderer/src/components/stats/StatsPane + main/stats/collector·claude-usage·codex-usage 의 핵심) — 순수 규칙.
// 출처: stablyai/orca @fdfcfb3551 (MIT)
//  · 에이전트 요약 = main/stats/collector.ts(띄운 에이전트·일한 시간·처음 기록)
//  · Claude 토큰 = claude-usage/transcript-record-parser.ts(assistant 줄의 message.usage, message.id+requestId 로 중복 제거 — 뒤 줄이 더 완전)
//  · Codex 토큰 = codex-usage/codex-usage-record-parser.ts·codex-usage-token-delta.ts(event_msg token_count — last_token_usage, 없으면 total 의 차이)
// 뺀 것: 비용 추정(가격표)·워크트리/프로젝트별 나누기·세션 표·PR 수(아라는 PR 을 만들지 않는다)·공유 카드(결정: 빼기)·증분 캐시(열 때마다 다시 읽는다).

export type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export type ProviderStats = { totals: TokenTotals; byDay: Record<string, number>; byModel: (TokenTotals & { model: string })[] }
export type StatsProvider = 'claude' | 'codex'
export type StatsReport = { since: number; at: number; files: number; claude: ProviderStats; codex: ProviderStats }
export type AgentSummary = { agentsSpawned: number; agentTimeMs: number; firstEventAt: number | null }
export const EMPTY_AGENT_SUMMARY: AgentSummary = { agentsSpawned: 0, agentTimeMs: 0, firstEventAt: null }

/** 몇 날을 읽나(Orca 기본 범위 30일). */
export const STATS_DAYS = 30

export const emptyTotals = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })
export const tokensOf = (t: TokenTotals): number => t.input + t.output + t.cacheRead + t.cacheWrite

const pad = (n: number): string => String(n).padStart(2, '0')
/** 이 PC 지역 날짜(YYYY-MM-DD). */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export type Turn = TokenTotals & { at: number; model: string }

/** Claude transcript 한 줄 → 한 턴(+중복 키). usage 가 없거나 모두 0 이면 null. */
export function parseClaudeLine(line: string): { key: string | null; turn: Turn } | null {
  if (!line.includes('"usage"')) return null
  let r: { type?: string; timestamp?: string; requestId?: string; uuid?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } }
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const u = r?.message?.usage
  if (r?.type !== 'assistant' || !u || typeof r.timestamp !== 'string') return null
  const at = Date.parse(r.timestamp)
  if (!Number.isFinite(at)) return null
  const turn: Turn = {
    at,
    model: typeof r.message?.model === 'string' && r.message.model !== '<synthetic>' ? r.message.model : 'unknown',
    input: n(u['input_tokens']),
    output: n(u['output_tokens']),
    cacheRead: n(u['cache_read_input_tokens']),
    cacheWrite: n(u['cache_creation_input_tokens']),
    turns: 1
  }
  if (!tokensOf(turn)) return null
  const id = r.message?.id
  return { key: typeof id === 'string' ? `${id}:${r.requestId ?? ''}` : null, turn }
}

type CodexRaw = { input: number; cached: number; output: number }
const codexRaw = (v: unknown): CodexRaw | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  // 추론 출력은 output_tokens 에 이미 들어 있다.
  return { input: n(o['input_tokens']), cached: n(o['cached_input_tokens']), output: n(o['output_tokens']) }
}

/** Codex rollout 파일 하나를 읽는 동안의 상태(모델·직전 누계). */
export type CodexCtx = { model: string | null; prev: CodexRaw | null }

/** Codex rollout 한 줄 → 한 턴. last_token_usage 가 있으면 그것, 없으면 total_token_usage 의 직전 누계와의 차이. */
export function parseCodexLine(line: string, ctx: CodexCtx): Turn | null {
  if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return null
  let r: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
  try {
    r = JSON.parse(line)
  } catch {
    return null
  }
  const p = r?.payload
  if (!p || typeof p !== 'object') return null
  if (r.type === 'turn_context') {
    if (typeof p['model'] === 'string') ctx.model = p['model']
    return null
  }
  if (r.type !== 'event_msg' || p['type'] !== 'token_count' || typeof r.timestamp !== 'string') return null
  const info = p['info'] as Record<string, unknown> | null
  if (!info || typeof info !== 'object') return null // 한도 갱신만 실린 token_count
  const total = codexRaw(info['total_token_usage'])
  const last = codexRaw(info['last_token_usage'])
  let d: CodexRaw | null = last
  if (!d && total) d = ctx.prev ? { input: Math.max(0, total.input - ctx.prev.input), cached: Math.max(0, total.cached - ctx.prev.cached), output: Math.max(0, total.output - ctx.prev.output) } : null
  // 같은 누계가 또 오면(재전송) 세지 않는다.
  if (total && ctx.prev && total.input === ctx.prev.input && total.output === ctx.prev.output && total.cached === ctx.prev.cached) return null
  if (total) ctx.prev = total
  if (!d) return null
  const at = Date.parse(r.timestamp)
  if (!Number.isFinite(at)) return null
  const cached = Math.min(d.cached, d.input)
  const turn: Turn = { at, model: ctx.model ?? 'unknown', input: d.input - cached, output: d.output, cacheRead: cached, cacheWrite: 0, turns: 1 }
  return tokensOf(turn) ? turn : null
}

export function emptyProviderStats(): ProviderStats {
  return { totals: emptyTotals(), byDay: {}, byModel: [] }
}

/** 턴들을 합친다(날짜별 토큰·모델별 표 — 모델은 토큰 많은 순). since 이전 턴은 뺀다. */
export function aggregateTurns(turns: Iterable<Turn>, since: number): ProviderStats {
  const totals = emptyTotals()
  const byDay: Record<string, number> = {}
  const models = new Map<string, TokenTotals>()
  for (const t of turns) {
    if (t.at < since) continue
    const m = models.get(t.model) ?? emptyTotals()
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'turns'] as const) {
      totals[k] += t[k]
      m[k] += t[k]
    }
    models.set(t.model, m)
    const day = dayOf(t.at)
    byDay[day] = (byDay[day] ?? 0) + tokensOf(t)
  }
  const byModel = [...models].map(([model, v]) => ({ model, ...v })).sort((a, b) => tokensOf(b) - tokensOf(a))
  return { totals, byDay, byModel }
}

/** 차트용 날짜 줄(since 날부터 오늘까지, 빈 날은 0). */
export function daySeries(byDay: Record<string, number>, since: number, now: number): { day: string; tokens: number }[] {
  const out: { day: string; tokens: number }[] = []
  const d = new Date(since)
  d.setHours(12, 0, 0, 0)
  const end = dayOf(now)
  for (let i = 0; i < 400; i++) {
    const day = dayOf(d.getTime())
    out.push({ day, tokens: byDay[day] ?? 0 })
    if (day === end) break
    d.setDate(d.getDate() + 1)
  }
  return out
}

/** 1234 → 1.2K, 3_400_000 → 3.4M(Orca usage-formatters formatTokens). */
export function formatTokens(v: number): string {
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(Math.round(v))
}

/** Orca StatsPane formatDuration — `3d 4h` · `2h 10m` · `5m`. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}
