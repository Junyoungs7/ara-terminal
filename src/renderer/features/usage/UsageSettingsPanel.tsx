// M13 설정 › AI 작업 공간 › 계정·사용량 — 설정 화면이 이 섹션을 열 때만 불러온다(진입 청크에 안 실린다).
// Orca 를 따른다: %사용/%남음(Settings → Appearance 의 usage percentage), Gemini 사용량 켜기(Gemini CLI OAuth — 사람이 켠다),
// Claude·Codex 계정(Settings → Agents → Accounts: 시스템 기본 + 추가한 계정, 고른 계정이 새 에이전트 실행에 쓰인다, 계정별 사용량),
// 통계(Settings → Stats: 띄운 에이전트·일한 시간 + 사용 분석 — 30일 토큰, 날짜별·모델별).
import { useCallback, useEffect, useState, type JSX } from 'react'
import { ACCOUNT_PROVIDERS, displayedPercent, type AccountProvider, type ProviderUsage, type UsagePercentageDisplay, type UsageWindow } from '@shared/usage'
import { daySeries, formatDuration, formatTokens, tokensOf, type AgentSummary, type StatsProvider, type StatsReport } from '@shared/usageStats'
import { t } from '../../i18n'
import { Row, Toggle } from '../../components/SettingsPage'
import { useDialog } from '../../components/Dialog'
import { liveWindow, setUsagePrefs, useUsage, usageReason } from '../../store/usage'

const NAMES: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex' }
const DISPLAYS: readonly UsagePercentageDisplay[] = ['used', 'remaining']

function pctText(w: UsageWindow | null, d: UsagePercentageDisplay): string {
  const live = liveWindow(w, Date.now())
  return live ? `${displayedPercent(live.usedPercent, d)}%` : '—'
}

/** 계정 한 줄의 사용량 요약(5H · 주간). 값이 없으면 이유 한 줄. */
function AccountUsageText({ u, d }: { u: ProviderUsage | null | undefined; d: UsagePercentageDisplay }): JSX.Element {
  if (u === undefined) return <span className="acct-usage">{t('usage.loading')}</span>
  if (!u || (!u.session && !u.weekly)) return <span className="acct-usage na">{usageReason(u)}</span>
  return (
    <span className="acct-usage">
      {t('usage.k.five')} {pctText(u.session, d)} · {t('usage.k.week')} {pctText(u.weekly, d)}
    </span>
  )
}

/**
 * 2.2.24 로그인하는 동안 그 줄 아래 — 브라우저 로그인부터 하면 첫 등록이 안 되던 것(준영님 2026-11-13).
 * 브라우저가 로그인 뒤 코드를 보여 주면 여기 붙여 넣는다(CLI 의 'Paste code here if prompted' — 예전엔 넣을 자리가 없었다).
 * 로그인 화면을 잃었으면 [로그인 화면 다시 열기] = 같은 줄에서 CLI 를 새로(이제 브라우저가 로그인돼 있어 바로 넘어간다).
 */
function LoginHelp({ provider, id }: { provider: AccountProvider; id: string }): JSX.Element {
  const [code, setCode] = useState('')
  const ctl = (a: { op: 'loginCode'; code: string } | { op: 'loginRetry' | 'loginCancel' }): void => void window.ev.usage.account({ ...a, provider, id }).catch(() => {})
  const send = (): void => {
    if (!code.trim()) return
    ctl({ op: 'loginCode', code })
    setCode('')
  }
  return (
    <div className="acct-login" data-account-login={id}>
      <span className="set-note">{t('usage.acct.loginHelp')}</span>
      <div className="acct-actions">
        <input
          type="text"
          className="ai-key-input"
          data-field="usage.acct.code"
          spellCheck={false}
          autoComplete="off"
          placeholder={t('usage.acct.codePh')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <button type="button" className="btn sec" data-action="usage.acct.code" disabled={!code.trim()} onClick={send}>
          {t('usage.acct.codeSend')}
        </button>
        <button type="button" className="btn sec" data-action="usage.acct.retry" onClick={() => ctl({ op: 'loginRetry' })}>
          {t('usage.acct.retry')}
        </button>
        <button type="button" className="btn sec" data-action="usage.acct.loginCancel" onClick={() => ctl({ op: 'loginCancel' })}>
          {t('usage.acct.cancel')}
        </button>
      </div>
    </div>
  )
}

function AccountsBlock({ provider }: { provider: AccountProvider }): JSX.Element {
  const u = useUsage()
  const view = u.accounts[provider]
  const d = u.prefs.display
  const dialog = useDialog()
  const [usage, setUsage] = useState<Record<string, ProviderUsage | null | undefined>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const ids = [null, ...view.list.map((a) => a.id)]
  const key = (id: string | null): string => id ?? 'system'
  // Orca: 계정 목록을 펼칠 때 다른 계정의 사용량을 묻는다 — 여기서는 이 화면을 열 때 한 번.
  const loadUsage = useCallback(() => {
    for (const id of [null, ...view.list.map((a) => a.id)])
      void window.ev.usage
        .accountUsage(provider, id)
        .then((r) => setUsage((s) => ({ ...s, [key(id)]: r })))
        .catch(() => setUsage((s) => ({ ...s, [key(id)]: null })))
  }, [provider, view.list.map((a) => a.id).join(',')])
  useEffect(loadUsage, [loadUsage])

  const act = async (id: string, job: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(id)
    setMsg(null)
    try {
      const r = await job()
      if (!r.ok) setMsg(r.error ?? t('usage.acct.failed'))
    } finally {
      setBusy(null)
      loadUsage()
    }
  }
  const add = async (): Promise<void> => {
    const label = await dialog.askText({ title: t('usage.acct.addTitle').replace('{p}', NAMES[provider]), message: t('usage.acct.addMsg'), input: { placeholder: t('usage.acct.labelPh') } })
    if (label === null) return
    const r = await window.ev.usage.account({ op: 'add', provider, label })
    // 만들고 바로 로그인(CLI 가 브라우저를 연다).
    if (r.ok && r.id) await act(r.id, () => window.ev.usage.account({ op: 'login', provider, id: r.id! }))
  }
  const rename = async (id: string, cur: string): Promise<void> => {
    const label = await dialog.askText({ title: t('usage.acct.renameTitle'), message: '', input: { value: cur } })
    if (label) await window.ev.usage.account({ op: 'rename', provider, id, label })
  }
  const remove = async (id: string, label: string): Promise<void> => {
    const ok = await dialog.ask({ title: t('usage.acct.removeTitle'), message: t('usage.acct.removeMsg').replace('{name}', label), tone: 'danger', confirmLabel: t('usage.acct.remove'), cancelLabel: t('usage.acct.cancel') })
    if (ok === 'confirm') await window.ev.usage.account({ op: 'remove', provider, id })
  }

  return (
    <div className="acct-block" data-accounts={provider}>
      <div className="acct-title">{t('usage.acct.title').replace('{p}', NAMES[provider])}</div>
      {ids.map((id) => {
        const a = id ? view.list.find((x) => x.id === id)! : null
        const on = view.active === id
        return (
          <div className={'acct-row' + (on ? ' on' : '')} key={key(id)} data-account={key(id)}>
            <button type="button" className="acct-pick" role="radio" aria-checked={on} data-action="usage.acct.select" onClick={() => void window.ev.usage.account({ op: 'select', provider, id })}>
              <span className="acct-dot" aria-hidden />
              <span className="acct-name">{a ? a.label : t('usage.acct.system')}</span>
            </button>
            <AccountUsageText u={usage[key(id)]} d={d} />
            {a && (
              <span className="acct-actions">
                <button type="button" className="btn sec" disabled={busy === a.id} data-action="usage.acct.login" onClick={() => void act(a.id, () => window.ev.usage.account({ op: 'login', provider, id: a.id }))}>
                  {busy === a.id ? t('usage.acct.loggingIn') : t('usage.acct.login')}
                </button>
                <button type="button" className="btn sec" data-action="usage.acct.rename" onClick={() => void rename(a.id, a.label)}>
                  {t('usage.acct.rename')}
                </button>
                <button type="button" className="btn sec" data-action="usage.acct.remove" onClick={() => void remove(a.id, a.label)}>
                  {t('usage.acct.remove')}
                </button>
              </span>
            )}
            {a && busy === a.id && <LoginHelp provider={provider} id={a.id} />}
          </div>
        )
      })}
      <div className="acct-foot">
        <button type="button" className="btn sec" data-action="usage.acct.add" onClick={() => void add()}>
          {t('usage.acct.add')}
        </button>
        {msg && <span className="set-note err">{msg}</span>}
      </div>
      {dialog.node}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="stat-card">
      <div className="stat-val">{value}</div>
      <div className="stat-lbl">{label}</div>
    </div>
  )
}

function StatsBlock(): JSX.Element {
  const [data, setData] = useState<{ summary: AgentSummary; report: StatsReport | null; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<StatsProvider>('claude')
  const load = useCallback((force = false) => {
    setLoading(true)
    void window.ev.usage
      .stats(force)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => load(), [load])
  const s = data?.summary
  const r = data?.report
  const p = r?.[tab]
  const series = r && p ? daySeries(p.byDay, r.since, r.at) : []
  const max = Math.max(1, ...series.map((x) => x.tokens))
  return (
    <div className="stats-block" data-stats>
      {s && (
        <div className="stat-cards">
          <StatCard label={t('usage.stats.spawned')} value={s.agentsSpawned.toLocaleString()} />
          <StatCard label={t('usage.stats.time')} value={formatDuration(s.agentTimeMs)} />
          <StatCard label={t('usage.stats.since')} value={s.firstEventAt ? new Date(s.firstEventAt).toLocaleDateString() : '—'} />
        </div>
      )}
      <div className="stats-head">
        <div className="seg-ctl" data-field="stats.provider">
          {(['claude', 'codex'] as const).map((x) => (
            <button type="button" key={x} className={tab === x ? 'on' : ''} data-value={x} onClick={() => setTab(x)}>
              {NAMES[x]}
            </button>
          ))}
        </div>
        <button type="button" className="btn sec" data-action="usage.stats.reload" disabled={loading} onClick={() => load(true)}>
          {loading ? t('usage.loading') : t('usage.refresh')}
        </button>
      </div>
      {data?.error && <div className="set-note err">{data.error}</div>}
      {p && (
        <>
          <div className="stat-cards">
            <StatCard label={t('usage.stats.total')} value={formatTokens(tokensOf(p.totals))} />
            <StatCard label={t('usage.stats.input')} value={formatTokens(p.totals.input)} />
            <StatCard label={t('usage.stats.output')} value={formatTokens(p.totals.output)} />
            <StatCard label={t('usage.stats.cacheRead')} value={formatTokens(p.totals.cacheRead)} />
            <StatCard label={t('usage.stats.cacheWrite')} value={formatTokens(p.totals.cacheWrite)} />
            <StatCard label={t('usage.stats.turns')} value={p.totals.turns.toLocaleString()} />
          </div>
          <div className="stats-chart" role="img" aria-label={t('usage.stats.daily')}>
            {series.map((x) => (
              <span key={x.day} className="bar" title={`${x.day} · ${formatTokens(x.tokens)}`}>
                <i style={{ height: `${Math.round((x.tokens / max) * 100)}%` }} />
              </span>
            ))}
          </div>
          {p.byModel.length > 0 ? (
            <table className="stats-models">
              <thead>
                <tr>
                  <th>{t('usage.stats.model')}</th>
                  <th>{t('usage.stats.total')}</th>
                  <th>{t('usage.stats.input')}</th>
                  <th>{t('usage.stats.output')}</th>
                  <th>{t('usage.stats.turns')}</th>
                </tr>
              </thead>
              <tbody>
                {p.byModel.map((m) => (
                  <tr key={m.model}>
                    <td>{m.model}</td>
                    <td>{formatTokens(tokensOf(m))}</td>
                    <td>{formatTokens(m.input)}</td>
                    <td>{formatTokens(m.output)}</td>
                    <td>{m.turns.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="set-note">{t('usage.stats.empty')}</div>
          )}
          <div className="set-note">{t('usage.stats.note').replace('{n}', String(r!.files))}</div>
        </>
      )}
    </div>
  )
}

export function UsageSettingsPanel(): JSX.Element {
  const u = useUsage()
  return (
    <>
      <Row label={t('usage.set.display')} desc={t('usage.set.display.desc')} item="usage.display">
        <div className="seg-ctl" data-field="usage.display">
          {DISPLAYS.map((v) => (
            <button type="button" key={v} className={u.prefs.display === v ? 'on' : ''} data-value={v} onClick={() => setUsagePrefs({ ...u.prefs, display: v })}>
              {t(`usage.set.display.${v}`)}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('usage.set.gemini')} desc={t('usage.set.gemini.desc')} item="usage.gemini">
        <Toggle on={u.prefs.gemini} label={t('usage.set.gemini')} onChange={(v) => setUsagePrefs({ ...u.prefs, gemini: v })} />
      </Row>
      <Row label={t('usage.set.accounts')} desc={t('usage.set.accounts.desc')} item="usage.accounts">
        <span />
      </Row>
      {ACCOUNT_PROVIDERS.map((p) => (
        <AccountsBlock key={p} provider={p} />
      ))}
      <Row label={t('usage.set.stats')} desc={t('usage.set.stats.desc')} item="usage.stats">
        <span />
      </Row>
      <StatsBlock />
    </>
  )
}
