// M9 AI-10 사용량 — 화면 쪽 저장소 하나(main usage 서비스의 거울). 상태바 칸·팝오버·아라 채팅 상태줄이 모두 이것을 읽는다(제거 A3).
// 처음 구독할 때 한 번 묻고, 뒤로는 main 이 'usage:update' 로 민다. 렌더러는 스스로 조회하지 않는다.
import { useSyncExternalStore } from 'react'
import { EMPTY_USAGE, type ProviderUsage, type UsageState, type UsageWindow } from '@shared/usage'
import type { AraLimits } from './araUsage'
import { t } from '../i18n'

let state: UsageState = EMPTY_USAGE
const subs = new Set<() => void>()
let wired = false

function set(next: UsageState): void {
  state = next
  subs.forEach((f) => f())
}

function wire(): void {
  if (wired || !window.ev?.usage) return
  wired = true
  window.ev.usage.onUpdate(set)
  void window.ev.usage
    .get()
    .then(set)
    .catch(() => {})
}

export function useUsage(): UsageState {
  return useSyncExternalStore(
    (f) => {
      wire()
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state
  )
}

/** 사람이 누른 새로 고침(팝오버). */
export function refreshUsage(): void {
  void window.ev?.usage
    ?.refresh()
    .then(set)
    .catch(() => {})
}

/** 아라 채팅 상태줄 모양으로(Claude 5시간·주간). 값이 없으면 null — 상태줄은 대체 글로 간다. */
export function araLimitsFromUsage(p: ProviderUsage | null): AraLimits | null {
  const one = (w: UsageWindow | null) => (w ? { pct: Math.round(w.usedPercent), resetsAt: w.resetsAt } : null)
  const five = one(p?.session ?? null)
  const week = one(p?.weekly ?? null)
  return five || week ? { five, week } : null
}

/** 값이 없을 때 한 줄 이유(팝오버). 토큰·응답 본문은 애초에 main 에서 안 온다. */
export function usageReason(p: ProviderUsage | null): string {
  if (!p || p.status === 'fetching') return t('usage.loading')
  return t(`usage.why.${p.failure ?? 'usage-unavailable'}`)
}

/** 초기화 시각이 지난 창은 뺀다(지난 값은 계정을 말하지 않는다 — Orca withoutResetWindows 와 같은 판단). 다음 조회·실시간 값이 채운다. */
export function liveWindow(w: UsageWindow | null, now: number): UsageWindow | null {
  return w && w.resetsAt !== null && w.resetsAt <= now ? null : w
}

const pad = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['일', '월', '화', '수', '목', '금', '토']

/** 초기화 시각 글(이 PC 지역 시간) — 오늘이면 `19:59`, 아니면 `10/25(토) 19:59`(Orca: 오늘이면 시각만, 아니면 요일+시각). */
export function resetAtText(resetsAt: number, now: number): string {
  const d = new Date(resetsAt)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${hm}`
}
