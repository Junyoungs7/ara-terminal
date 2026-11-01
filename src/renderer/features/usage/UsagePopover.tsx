// M9 AI-10 사용량 팝오버 — Orca status-bar/UsageRosterPanel(orcaRef fdfcfb3551)의 줄 모양: 프로바이더마다 이름·요금제,
// 창(5시간·주간)마다 막대·%·초기화 시각. 값이 없으면 '알 수 없음' + 한 줄 이유. 조회는 main 이 한다 — 여기는 [새로 고침]만.
// M13: %사용/%남음(설정) · 고른 계정 이름 · Gemini(켰을 때, 모델별 칸) · 에이전트 탭 컨텍스트 · [계정·통계] → 설정 › 계정·사용량.
import { useEffect, useState } from 'react'
import { RefreshCw, Settings2 } from 'lucide-react'
import { displayedPercent, type ContextUsage, type ProviderUsage, type UsagePercentageDisplay, type UsageProvider, type UsageState, type UsageWindow } from '@shared/usage'
import { formatTokens } from '@shared/usageStats'
import { t } from '../../i18n'
import { untilText } from '../../store/araUsage'
import { liveWindow, refreshUsage, resetAtText, usageReason, useUsage } from '../../store/usage'
import { openSettings } from '../../store/settingsNav'
import { useAgentStore } from '../aiws/agentStore'

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

function WindowRow({ label, w, now, display }: { label: string; w: UsageWindow; now: number; display: UsagePercentageDisplay }) {
  const pct = displayedPercent(w.usedPercent, display)
  return (
    <div className="usage-win">
      <span className="lbl">{label}</span>
      <span className="sb-mbar" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="pct">{pct}%</span>
      {w.resetsAt !== null && (
        <span className="reset">
          {t('usage.reset').replace('{at}', resetAtText(w.resetsAt, now))} · {untilText(w.resetsAt, now)}
        </span>
      )}
    </div>
  )
}

function accountLabel(u: UsageState, provider: UsageProvider): string | null {
  if (provider === 'gemini') return null
  const a = u.accounts[provider]
  return a.active ? (a.list.find((x) => x.id === a.active)?.label ?? null) : null
}

function ProviderRow({ u, provider, now }: { u: UsageState; provider: UsageProvider; now: number }) {
  const p: ProviderUsage | null = u[provider]
  const d = u.prefs.display
  const session = liveWindow(p?.session ?? null, now)
  const weekly = liveWindow(p?.weekly ?? null, now)
  // Gemini 는 모델별 칸(하루 단위) — 칸마다 한 줄.
  const buckets = provider === 'gemini' ? (p?.buckets ?? []).filter((b) => b.resetsAt === null || b.resetsAt > now) : []
  const has = buckets.length > 0 || Boolean(session || weekly)
  const acct = accountLabel(u, provider)
  return (
    <div className="usage-row" data-usage-provider={provider} data-usage-status={p?.status ?? 'none'}>
      <div className="usage-head">
        <span className="name">{NAMES[provider]}</span>
        {acct && <span className="acct">{acct}</span>}
        {p?.planType && <span className="plan">{p.planType}</span>}
        {!has && <span className="na">{t('usage.unknown')}</span>}
      </div>
      {provider === 'gemini'
        ? buckets.map((b) => <WindowRow key={b.name} label={b.name} w={{ usedPercent: b.usedPercent, windowMinutes: 1440, resetsAt: b.resetsAt }} now={now} display={d} />)
        : (
          <>
            {session && <WindowRow label={t('usage.row.five')} w={session} now={now} display={d} />}
            {weekly && <WindowRow label={t('usage.row.week')} w={weekly} now={now} display={d} />}
          </>
        )}
      {!has && <div className="usage-why">{usageReason(p)}</div>}
      {has && p?.status === 'error' && <div className="usage-why">{t('usage.stale')}</div>}
      {has && p?.status === 'ok' && p.source === 'live' && <div className="usage-why">{t('usage.live')}</div>}
    </div>
  )
}

/** 에이전트 탭 컨텍스트(Claude statusLine) — 지금 보는 탭 먼저, 열린 탭만. */
function ContextRows({ context, display }: { context: Record<string, ContextUsage>; display: UsagePercentageDisplay }) {
  const tabs = useAgentStore((s) => s.tabs)
  const viewing = useAgentStore((s) => s.viewing)
  const rows = tabs.filter((tab) => !tab.exited && context[tab.sessionId]).sort((a, b) => Number(b.sessionId === viewing) - Number(a.sessionId === viewing))
  if (!rows.length) return null
  return (
    <div className="usage-row" data-usage-provider="context">
      <div className="usage-head">
        <span className="name">{t('usage.context')}</span>
      </div>
      {rows.map((tab) => {
        const c = context[tab.sessionId]!
        const pct = displayedPercent(c.usedPercent, display)
        return (
          <div className="usage-win usage-ctx" key={tab.sessionId} data-context-session={tab.sessionId} title={tab.line}>
            <span className="lbl ctx-name">{tab.name || tab.genTitle || tab.title}</span>
            <span className="sb-mbar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="pct">{pct}%</span>
            <span className="reset">{[c.model, c.windowTokens ? formatTokens(c.windowTokens) : null].filter(Boolean).join(' · ')}</span>
          </div>
        )
      })}
    </div>
  )
}

export function UsagePopover() {
  const u = useUsage()
  const [now, setNow] = useState(() => Date.now())
  // 남은 시간은 분 단위 — 열려 있는 동안 30초마다 다시 그린다.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="usage-pop res-pop" data-open="true" data-usage-display={u.prefs.display}>
      <ProviderRow u={u} provider="claude" now={now} />
      <ProviderRow u={u} provider="codex" now={now} />
      {u.prefs.gemini && <ProviderRow u={u} provider="gemini" now={now} />}
      <ContextRows context={u.context} display={u.prefs.display} />
      <div className="usage-foot">
        <button type="button" className="usage-refresh" data-action="usage.manage" onClick={() => openSettings('usage')}>
          <Settings2 size={12} aria-hidden />
          {t('usage.manage')}
        </button>
        <button type="button" className="usage-refresh" data-action="usage.refresh" onClick={refreshUsage}>
          <RefreshCw size={12} aria-hidden />
          {t('usage.refresh')}
        </button>
      </div>
    </div>
  )
}
