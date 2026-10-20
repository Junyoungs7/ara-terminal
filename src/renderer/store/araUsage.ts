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

/** 초기화까지 남은 시간 — "6일 1시간" · "2시간 10분" · "10분". 이미 지났거나 모르면 빈 문자열. */
export function untilText(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return ''
  const min = Math.ceil((resetsAt - now) / 60_000)
  const h = Math.floor(min / 60)
  const m = min % 60
  const hm =
    h >= 24
      ? t('ara.use.dh').replace('{d}', String(Math.floor(h / 24))).replace('{h}', String(h % 24))
      : h > 0
        ? t('ara.use.hm').replace('{h}', String(h)).replace('{m}', String(m)) : t('ara.use.m').replace('{m}', String(m))
  return t('ara.use.reset').replace('{t}', hm)
}

/** 줄 하나 = 왼쪽 글·오른쪽 글·막대(한도가 있을 때만, 0~100). */
export function usageLine(
  engine: 'cli' | 'api',
  limits: AraLimits | null,
  usage: AraUsage | null,
  now: number
): { left: string; right: string; bars: { five: number; week: number } | null } {
  const tok = usage ? kTok(usage.input + usage.output) : ''
  if (engine === 'api') {
    if (!usage) return { left: '—', right: '', bars: null }
    return {
      left: t('ara.use.api').replace('{n}', tok).replace('{i}', kTok(usage.input)).replace('{o}', kTok(usage.output)),
      right: '',
      bars: null
    }
  }
  if (limits && (limits.five || limits.week)) {
    const reset = limits.five ? untilText(limits.five.resetsAt, now) : ''
    return {
      left: limits.five ? t('ara.use.five').replace('{p}', String(limits.five.pct)) + (reset ? ` · ${reset}` : '') : '',
      right: limits.week ? t('ara.use.week').replace('{p}', String(limits.week.pct)) : '',
      bars: { five: limits.five?.pct ?? 0, week: limits.week?.pct ?? 0 }
    }
  }
  if (!usage) return { left: '—', right: '', bars: null }
  return {
    left: t('ara.use.noLimit').replace('{n}', tok),
    right: usage.costUsd === null ? '' : t('ara.use.cost').replace('{c}', usage.costUsd.toFixed(2)),
    bars: null
  }
}

/** 맥락 — 지금 맥락에 든 토큰(used) ÷ 모델 창(window). 둘 다 와야 칸이 생긴다. */
export type AraContext = { used: number | null; window: number | null }

/**
 * 아라 채팅 v3 상태줄(#21, B안) — 입력칸 밑 한 줄의 칸들.
 * `5시간 ▬ 42% · 2시간 10분 뒤 초기화 │ 주간 ▬ 17% · … │ 맥락 ▬ 53% │ 이번 대화 42.1k 토큰 · $0.42`.
 * 한도가 없거나 API 모드면 usageLine 의 대체 글을 한 칸(key 'text')으로 쓴다.
 * pct 가 있는 칸만 막대를 그린다. 좁은 폭에서 `note`(초기화)와 'conv' 칸은 화면이 접는다.
 */
export type UsageSeg = { key: 'five' | 'week' | 'ctx' | 'conv' | 'text'; label: string; pct: number | null; note: string }

export function statusSegs(
  engine: 'cli' | 'api',
  limits: AraLimits | null,
  usage: AraUsage | null,
  ctx: AraContext | null,
  now: number
): UsageSeg[] {
  const out: UsageSeg[] = []
  const lim = engine === 'cli' && limits && (limits.five || limits.week) ? limits : null
  if (lim) {
    if (lim.five) out.push({ key: 'five', label: t('ara.use.k.five'), pct: lim.five.pct, note: untilText(lim.five.resetsAt, now) })
    if (lim.week) out.push({ key: 'week', label: t('ara.use.k.week'), pct: lim.week.pct, note: untilText(lim.week.resetsAt, now) })
  } else {
    const u = usageLine(engine, limits, usage, now)
    out.push({ key: 'text', label: '', pct: null, note: u.right ? `${u.left} · ${u.right}` : u.left })
  }
  if (ctx && ctx.used !== null && ctx.window) {
    out.push({ key: 'ctx', label: t('ara.use.k.ctx'), pct: Math.min(100, Math.round((ctx.used / ctx.window) * 100)), note: '' })
  }
  if (lim && usage) {
    const n = kTok(usage.input + usage.output)
    out.push({
      key: 'conv',
      label: t('ara.use.k.conv'),
      pct: null,
      note: usage.costUsd === null ? t('ara.use.conv').replace('{n}', n) : t('ara.use.convCost').replace('{n}', n).replace('{c}', usage.costUsd.toFixed(2))
    })
  }
  return out
}
