// FD-01 자원 관리자 팝오버. Orca status-bar/ResourceUsageStatusSegment·ResourcePtyPanel(orcaRef 7a7f46f8a3)을
// 따라 [자원]·[터미널] 두 탭. 이 컴포넌트가 마운트된 동안만 폴링한다 — 닫히면(언마운트) 멈춘다.
import { useEffect, useState } from 'react'
import { formatBytes, type ResourceSnapshot } from '@shared/resources'
import { t } from '../../i18n'

const POLL_MS = 2_000

const cpuText = (n: number): string => n.toFixed(1) + '%'

export function ResourcePopover() {
  const [snap, setSnap] = useState<ResourceSnapshot | null>(null)
  const [tab, setTab] = useState<'app' | 'pty'>('app')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // 앞 수집이 끝난 뒤 다음을 건다(setInterval 이면 느린 PC 에서 겹쳐 쌓인다).
    const tick = async () => {
      const s = await window.ev?.resources.snapshot().catch(() => null)
      if (!alive) return
      if (s) setSnap(s)
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  const kill = async (id: string) => {
    setConfirmId(null)
    await window.ev?.resources.killPty(id)
    const s = await window.ev?.resources.snapshot().catch(() => null)
    if (s) setSnap(s)
  }

  return (
    <div className="res-pop" data-open="true">
      <div className="res-tabs">
        <button type="button" className={'res-tab' + (tab === 'app' ? ' on' : '')} data-action="resources.tab.app" onClick={() => setTab('app')}>
          {t('resources.tab.app')}
        </button>
        <button type="button" className={'res-tab' + (tab === 'pty' ? ' on' : '')} data-action="resources.tab.pty" onClick={() => setTab('pty')}>
          {t('resources.tab.pty')} <span className="res-count">{snap?.ptys.length ?? 0}</span>
        </button>
      </div>
      {!snap ? (
        <div className="res-empty">{t('resources.loading')}</div>
      ) : tab === 'app' ? (
        <div className="res-list">
          <div className="res-row res-total">
            <span className="name">{t('resources.total')}</span>
            <span className="cpu">{cpuText(snap.total.cpu)}</span>
            <span className="mem">{formatBytes(snap.total.memory)}</span>
          </div>
          {snap.app.map((p) => (
            <div className="res-row" key={p.pid} data-kind={p.kind}>
              <span className="name" title={p.name}>
                {t('resources.kind.' + p.kind)} <span className="pid">{p.pid}</span>
              </span>
              <span className="cpu">{cpuText(p.cpu)}</span>
              <span className="mem">{formatBytes(p.memory)}</span>
            </div>
          ))}
        </div>
      ) : snap.ptys.length === 0 ? (
        <div className="res-empty">{t('resources.noPty')}</div>
      ) : (
        <div className="res-list">
          {snap.ptys.map((p) => (
            <div className="res-row" key={p.id} data-session={p.id}>
              <span className="name" title={p.title}>
                {p.title} {p.pid != null && <span className="pid">{p.pid}</span>}
              </span>
              <span className="cpu">{p.pid != null ? cpuText(p.cpu) : '—'}</span>
              <span className="mem">{p.pid != null ? formatBytes(p.memory) : '—'}</span>
              <button
                type="button"
                className={'res-kill' + (confirmId === p.id ? ' confirm' : '')}
                data-action={confirmId === p.id ? 'resources.pty.killConfirm' : 'resources.pty.kill'}
                onClick={() => (confirmId === p.id ? void kill(p.id) : setConfirmId(p.id))}
              >
                {confirmId === p.id ? t('resources.killConfirm') : t('resources.kill')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
