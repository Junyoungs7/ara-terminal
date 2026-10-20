import type { AiLimit } from '@shared/aiEngine'
import { t } from '../i18n'

/**
 * 아라 채팅 v2 — 머리 아래 사용량 줄의 글(준영님 결정: **한도 % 우선, 못 얻으면 이번 대화 토큰·추정 비용**).
 * 순수 함수라 시험한다(tests/araUsage.test.ts).
 */
export type AraLimits = { five: AiLimit | null; week: AiLimit | null }
/** 이번 대화 사용량. costUsd 는 Claude Code 의 누적값(마지막 값) — 더하지 않는다. */
export type AraUsage = { input: number; output: number; costUsd: number | null }

/** 12400 → "12.4k", 980 → "980", 999950 → "1.0M"(반올림이 1000.0k 가 되는 경계). */
export function kTok(n: number): string {
  if (n < 1000) return String(n)
  const k = (n / 1000).toFixed(1)
  return Number(k) < 1000 ? `${k}k` : `${(n / 1_000_000).toFixed(1)}M`
}

/** 초기화까지 남은 시간(짧은 꼴, #25) — "5d4h" · "2h38m" · "45m". 이미 지났거나 모르면 빈 문자열. */
export function untilText(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return ''
  const min = Math.ceil((resetsAt - now) / 60_000)
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h >= 24) return t('ara.use.dh').replace('{d}', String(Math.floor(h / 24))).replace('{h}', String(h % 24))
  return h > 0 ? t('ara.use.hm').replace('{h}', String(h)).replace('{m}', String(m)) : t('ara.use.m').replace('{m}', String(m))
}

/** 한도를 못 얻었을 때(또는 API 모드)의 대체 글 한 줄. 한도 % 는 statusSegs 가 따로 그린다. */
export function usageLine(engine: 'cli' | 'api', usage: AraUsage | null): string {
  if (!usage) return '—'
  const tok = kTok(usage.input + usage.output)
  if (engine === 'api') return t('ara.use.api').replace('{n}', tok).replace('{i}', kTok(usage.input)).replace('{o}', kTok(usage.output))
  const left = t('ara.use.noLimit').replace('{n}', tok)
  return usage.costUsd === null ? left : `${left} · ${t('ara.use.cost').replace('{c}', usage.costUsd.toFixed(2))}`
}

/** 이번 대화 토큰·비용 — 상태줄에서 빠져 상태줄 전체의 툴팁이 됐다(#25). 쓴 게 없으면 빈 글. */
export function usageTitle(usage: AraUsage | null): string {
  if (!usage) return ''
  const n = kTok(usage.input + usage.output)
  return usage.costUsd === null ? t('ara.use.conv').replace('{n}', n) : t('ara.use.convCost').replace('{n}', n).replace('{c}', usage.costUsd.toFixed(2))
}

/** 맥락 — 지금 맥락에 든 토큰(used) ÷ 모델 창(window). 둘 다 와야 칸이 생긴다. */
export type AraContext = { used: number | null; window: number | null }

/**
 * 아라 채팅 v3 상태줄 — 입력칸 밑 **한 줄**(#25): `5H ▬ 25% (2h38m) │ 주간 ▬ 22% (5d4h) │ 맥락 ▬ 5%`.
 * 한도가 없거나 API 모드면 usageLine 의 대체 글을 한 칸(key 'text')으로 쓴다. pct 가 있는 칸만 막대를 그린다.
 * resetsAt 이 지난 창은 초기화된 것이라 0%·괄호 없음(#24-1 — 저장해 둔 낡은 값도 그렇게 보인다).
 */
export type UsageSeg = { key: 'five' | 'week' | 'ctx' | 'text'; label: string; pct: number | null; note: string }

export function statusSegs(
  engine: 'cli' | 'api',
  limits: AraLimits | null,
  usage: AraUsage | null,
  ctx: AraContext | null,
  now: number
): UsageSeg[] {
  const out: UsageSeg[] = []
  const lim = engine === 'cli' && limits && (limits.five || limits.week) ? limits : null
  const seg = (key: 'five' | 'week', l: AiLimit): UsageSeg => {
    const reset = l.resetsAt !== null && l.resetsAt <= now
    return { key, label: key === 'five' ? t('ara.use.k.five') : t('ara.use.k.week'), pct: reset ? 0 : l.pct, note: untilText(l.resetsAt, now) }
  }
  if (lim) {
    if (lim.five) out.push(seg('five', lim.five))
    if (lim.week) out.push(seg('week', lim.week))
  } else {
    out.push({ key: 'text', label: '', pct: null, note: usageLine(engine, usage) })
  }
  if (ctx && ctx.used !== null && ctx.window) {
    out.push({ key: 'ctx', label: t('ara.use.k.ctx'), pct: Math.min(100, Math.round((ctx.used / ctx.window) * 100)), note: '' })
  }
  return out
}
