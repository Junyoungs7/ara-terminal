import { useEffect, useState, type JSX } from 'react'
import { Monitor, RefreshCw, Server } from 'lucide-react'
import type { ServerSessionRow, ServerSessionsHost } from '@shared/managedServers'
import { AGENTS, isAgentId } from '@shared/agents'
import { t } from '../../i18n'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { useAgentStore } from '../aiws/agentStore'
import { AgentGlyph } from '../aiws/AgentGlyph'
import { useServerSessions } from './serverSessions'
import './servers.css'

/**
 * R1 AI 공간 › 서버 — 서버에서 도는 에이전트 세션(목업 1-sessions A 페이지). 동의한 서버마다 카드 하나.
 * [붙기] = 그 세션을 이 PC 탭으로(다른 PC 가 만든 것도 — 두 PC 모두 입력), [탭으로] = 이미 이 PC 에 열림, [끝내기] = 서버에서 끝냄(다른 PC 탭도).
 * R2 상태 칸 = 서버가 훅으로 들은 마지막 상태(기존 글리프). 모르면(옛 서버·Codex) '모름' 글리프.
 */
export function ServerSessionsPage({ ask }: { ask: (spec: DialogSpec) => Promise<DialogResult> }): JSX.Element {
  const hosts = useServerSessions((s) => s.hosts)
  const loading = useServerSessions((s) => s.loading)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const refresh = (): Promise<void> => useServerSessions.getState().refresh()
  useEffect(() => void refresh(), [])

  const attach = async (row: ServerSessionRow): Promise<void> => {
    setBusy(row.id)
    setErr(null)
    const e = await useAgentStore.getState().attachRemote(row.hostKey, row.id)
    setBusy(null)
    if (e) setErr(e)
  }
  const end = async (row: ServerSessionRow): Promise<void> => {
    const r = await ask({ title: t('servers.end.ask'), message: t('servers.end.askMsg'), detail: [{ label: t('managed.consent.host'), value: row.hostKey }, { label: t('servers.col.session'), value: row.title }], tone: 'danger', confirmLabel: t('servers.end.ok'), cancelLabel: t('managed.cancel') })
    if (r !== 'confirm') return
    setBusy(row.id)
    setErr(null)
    const open = useAgentStore.getState().tabs.some((x) => x.sessionId === row.id)
    if (open) await useAgentStore.getState().endRemote(row.id)
    else if (!(await window.ev.agents.killRemote(row.hostKey, row.id))) setErr(t('servers.err.endLater'))
    setBusy(null)
    await refresh()
  }

  return (
    <div className="aiws-board srv-page" role="region" aria-label={t('servers.title')} data-aiws="servers">
      <div className="aiws-vault-head">
        <h2 className="aiws-new-ttl">{t('servers.title')}</h2>
        <button type="button" className="btn sec" data-servers="refresh" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw aria-hidden />
          {t('servers.refresh')}
        </button>
      </div>
      <p className="aiws-note">{t('servers.desc')}</p>
      {err && (
        <p className="aiws-note aiws-err" role="alert" data-servers="err">
          {err}
        </p>
      )}
      {!hosts.length &&
        (loading ? (
          <p className="aiws-note">{t('managed.loading')}</p>
        ) : (
          // fb2214 빈 상태 = 가운데 아이콘 + 제목 + 안내(대시보드·지난 세션 .aiws-empty 와 같은 문법).
          <div className="aiws-empty">
            <Server className="aiws-home-ic" aria-hidden />
            <b>{t('servers.emptyTitle')}</b>
            <span>{t('servers.empty')}</span>
          </div>
        ))}
      {hosts.map((h) => (
        <HostCard key={h.hostKey} host={h} busy={busy} onAttach={(r) => void attach(r)} onEnd={(r) => void end(r)} />
      ))}
    </div>
  )
}

function HostCard({ host, busy, onAttach, onEnd }: { host: ServerSessionsHost; busy: string | null; onAttach: (r: ServerSessionRow) => void; onEnd: (r: ServerSessionRow) => void }): JSX.Element {
  return (
    <section className="srv-card" data-servers-host={host.hostKey}>
      <div className="srv-hd">
        <Server aria-hidden />
        <b>{host.label}</b>
        <span className="srv-mono">{host.hostKey}</span>
        <span className={'srv-pill ' + (host.ok ? 'ok' : 'off')}>{host.ok ? t('servers.on') : t('servers.off')}</span>
        <span className="srv-lo">{[host.version ? t('servers.version').replace('{v}', host.version) : '', host.ok ? t('servers.count').replace('{n}', String(host.sessions.length)) : ''].filter(Boolean).join(' · ')}</span>
      </div>
      {!host.ok && <p className="aiws-note aiws-err">{t('servers.err.host').replace('{why}', host.error ?? '')}</p>}
      {host.ok && host.sessions.length === 0 && <p className="aiws-note">{t('servers.none')}</p>}
      {host.sessions.length > 0 && (
        <table className="srv-tbl">
          <thead>
            <tr>
              <th>{t('servers.col.state')}</th>
              <th>{t('servers.col.session')}</th>
              <th>{t('servers.col.started')}</th>
              <th>{t('servers.col.from')}</th>
              <th>{t('servers.col.seeing')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {host.sessions.map((r) => (
              <tr key={r.id} className={r.here ? 'here' : ''} data-servers-row={r.id}>
                <td data-servers-state={r.state ?? 'unknown'}>
                  <AgentGlyph display={r.state ?? 'unknown'} estimated={false} />
                </td>
                <td className="srv-tt">
                  <b>{r.title}</b>
                  <span>{[isAgentId(r.agent) ? AGENTS[r.agent].label : r.agent, r.cwd].filter(Boolean).join(' · ')}</span>
                </td>
                <td className="srv-lo">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                <td>
                  <Monitor aria-hidden className="srv-ic" /> {r.pc ?? '—'}
                </td>
                <td>{r.here ? <span className="srv-pill ai">{t('servers.thisPc')}</span> : r.viewers.length ? r.viewers.join(', ') : <span className="srv-lo">{t('servers.nobody')}</span>}</td>
                <td className="srv-act">
                  <button type="button" className={'btn ' + (r.here ? 'sec' : 'pri')} data-servers="attach" disabled={busy !== null} onClick={() => onAttach(r)}>
                    {r.here ? t('servers.toTab') : busy === r.id ? t('servers.attaching') : t('servers.attach')}
                  </button>
                  <button type="button" className="btn sec" data-servers="end" disabled={busy !== null} onClick={() => onEnd(r)}>
                    {t('servers.endShort')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
