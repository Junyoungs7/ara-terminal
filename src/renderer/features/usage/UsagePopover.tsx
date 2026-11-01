// M9 AI-10 사용량 팝오버 — Orca status-bar/UsageRosterPanel(orcaRef fdfcfb3551)의 줄 모양: 프로바이더마다 이름·요금제,
// 창(5시간·주간)마다 막대·%·초기화 시각. 값이 없으면 '알 수 없음' + 한 줄 이유. 조회는 main 이 한다 — 여기는 [새로 고침]만.
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProviderUsage, UsageProvider, UsageWindow } from '@shared/usage'
import { t } from '../../i18n'
import { untilText } from '../../store/araUsage'
import { liveWindow, refreshUsage, resetAtText, usageReason, useUsage } from '../../store/usage'

const NAMES: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' }

function WindowRow({ label, w, now }: { label: string; w: UsageWindow; now: number }) {
  const pct = Math.round(w.usedPercent)
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

function ProviderRow({ p, provider, now }: { p: ProviderUsage | null; provider: UsageProvider; now: number }) {
  const session = liveWindow(p?.session ?? null, now)
  const weekly = liveWindow(p?.weekly ?? null, now)
  const has = Boolean(session || weekly)
  return (
    <div className="usage-row" data-usage-provider={provider} data-usage-status={p?.status ?? 'none'}>
      <div className="usage-head">
        <span className="name">{NAMES[provider]}</span>
        {p?.planType && <span className="plan">{p.planType}</span>}
        {!has && <span className="na">{t('usage.unknown')}</span>}
      </div>
      {session && <WindowRow label={t('usage.row.five')} w={session} now={now} />}
      {weekly && <WindowRow label={t('usage.row.week')} w={weekly} now={now} />}
      {!has && <div className="usage-why">{usageReason(p)}</div>}
      {has && p?.status === 'error' && <div className="usage-why">{t('usage.stale')}</div>}
      {has && p?.status === 'ok' && p.source === 'live' && <div className="usage-why">{t('usage.live')}</div>}
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
    <div className="usage-pop res-pop" data-open="true">
      <ProviderRow p={u.claude} provider="claude" now={now} />
      <ProviderRow p={u.codex} provider="codex" now={now} />
      <button type="button" className="usage-refresh" data-action="usage.refresh" onClick={refreshUsage}>
        <RefreshCw size={12} aria-hidden />
        {t('usage.refresh')}
      </button>
    </div>
  )
}
