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

/** 초기화까지 남은 시간 — "2시간 10분" · "10분". 이미 지났거나 모르면 빈 문자열. */
export function untilText(resetsAt: number | null, now: number): string {
  if (resetsAt === null || resetsAt <= now) return ''
  const min = Math.ceil((resetsAt - now) / 60_000)
  const h = Math.floor(min / 60)
  const m = min % 60
  const hm = h > 0 ? t('ara.use.hm').replace('{h}', String(h)).replace('{m}', String(m)) : t('ara.use.m').replace('{m}', String(m))
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
