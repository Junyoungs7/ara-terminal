import { useCallback, useEffect, useState, type JSX } from 'react'
import type { ManagedRecord } from '@shared/managedServers'
import type { ManagedListResult } from '@shared/ipc'
import { t } from '../../i18n'
import { Row, Toggle } from '../../components/SettingsPage'
import { useDialog } from '../../components/Dialog'
import { askManagedConsent } from './consent'
import { ServerAccountsBox } from './ServerAccountsBox'

/**
 * M8 DM-03 설정 › AI 작업 공간 › 관리형 서버 — Orca managed-runtime(ManagedRuntimeInstallRow·RemoveDialog, orcaRef fdfcfb3551)의 1차.
 * 설치는 이 화면의 [설치] → 동의 화면(무엇을·어디에·무엇이 상주·지우는 법) → [설치] 일 때만. [제거] = 동의 철회(원격에서 지우고 남은 것을 잰다).
 * 연결은 지금 열린 SSH 세션의 것을 빌린다 — 목록의 "설치할 수 있는 서버"는 지금 접속해 있는 서버다.
 */
export function ManagedServersPanel(): JSX.Element {
  const [list, setList] = useState<ManagedListResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // R3 서버 계정을 펼친 서버(펼칠 때 서버에 묻는다 — 설정을 열기만 해서는 붙지 않는다).
  const [acctOpen, setAcctOpen] = useState<string | null>(null)
  const dialog = useDialog()
  const reload = useCallback(() => void window.ev.managed.list().then(setList), [])
  useEffect(reload, [reload])

  const run = async (hostKey: string, job: () => Promise<void>): Promise<void> => {
    setBusy(hostKey)
    setMsg(null)
    try {
      await job()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      reload()
    }
  }

  const consent = (hostKey: string): Promise<void> =>
    run(hostKey, async () => {
      const r = await askManagedConsent(dialog.ask, hostKey)
      if (typeof r === 'object') setMsg(r.error)
    })

  const remove = (hostKey: string): Promise<void> =>
    run(hostKey, async () => {
      const r = await dialog.ask({ title: t('managed.remove.title'), message: t('managed.remove.message'), detail: [{ label: t('managed.consent.host'), value: hostKey }], tone: 'danger', confirmLabel: t('managed.remove'), cancelLabel: t('managed.cancel') })
      if (r !== 'confirm') return
      const res = await window.ev.managed.remove(hostKey)
      setMsg(res.ok ? t('managed.remove.done') : res.error ?? t('managed.remove.left').replace('{list}', res.remnants.join(', ')))
    })

  if (!list) return <div className="set-note">{t('managed.loading')}</div>
  const consented = new Set(list.records.map((r) => r.hostKey))
  const connected = new Set(list.targets.map((x) => x.hostKey))
  const fresh = list.targets.filter((x) => !consented.has(x.hostKey))

  return (
    <div data-sec="managed">
      <div className="set-note">{t('managed.desc')}</div>
      <div className="set-sec-t" data-item="managed.list">
        {t('managed.list')}
      </div>
      {list.records.length === 0 && <div className="set-note">{t('managed.empty')}</div>}
      {list.records.map((r) => (
        <div key={r.hostKey}>
          <Row label={r.hostKey} desc={recordDesc(r, connected.has(r.hostKey))} item={`managed.${r.hostKey}`}>
            <button type="button" className="btn sec" aria-expanded={acctOpen === r.hostKey} data-managed="accounts-toggle" onClick={() => setAcctOpen(acctOpen === r.hostKey ? null : r.hostKey)}>
              {t('managed.acct.title')}
            </button>
            <button type="button" className="btn sec" disabled={busy !== null || !connected.has(r.hostKey)} data-managed="check" onClick={() => void run(r.hostKey, async () => void (await window.ev.managed.check(r.hostKey)))}>
              {t('managed.check')}
            </button>
            <button type="button" className="btn sec" disabled={busy !== null || !connected.has(r.hostKey)} data-managed="remove" onClick={() => void remove(r.hostKey)}>
              {t('managed.remove')}
            </button>
          </Row>
          {/* R5 상주 모드(기본 켜짐, 목업 6-resident B) — 서버의 설치 폴더에 기록(다른 PC 도 같은 값). 끄면 할 일이 없을 때 스스로 끝난다. */}
          <Row label={t('managed.resident')} desc={t('managed.resident.desc')} item={`managed.resident.${r.hostKey}`}>
            <span data-managed="resident">
              <Toggle
                on={r.resident !== false}
                label={t('managed.resident')}
                disabled={busy !== null}
                onChange={(on) =>
                  void run(r.hostKey, async () => {
                    const res = await window.ev.managed.resident(r.hostKey, on)
                    setMsg('error' in res ? res.error : on ? t('managed.resident.onDone') : t('managed.resident.offDone'))
                  })
                }
              />
            </span>
          </Row>
          {acctOpen === r.hostKey && <ServerAccountsBox hostKey={r.hostKey} ask={dialog.ask} />}
        </div>
      ))}
      <div className="set-sec-t" data-item="managed.install">
        {t('managed.installable')}
      </div>
      {fresh.length === 0 && <div className="set-note">{t('managed.noTargets')}</div>}
      {fresh.map((x) => (
        <Row key={x.hostKey} label={x.label} desc={x.hostKey} item={`managed.add.${x.hostKey}`}>
          <button type="button" className="btn sec" disabled={busy !== null} data-managed="install" onClick={() => void consent(x.hostKey)}>
            {t('managed.install')}
          </button>
        </Row>
      ))}
      {busy && <div className="set-note">{t('managed.working').replace('{host}', busy)}</div>}
      {msg && (
        <div className="set-note" data-managed="msg">
          {msg}
        </div>
      )}
      {dialog.node}
    </div>
  )
}

function recordDesc(r: ManagedRecord, connected: boolean): string {
  const parts = [t(`managed.state.${r.state}`), r.version ? `v${r.version}` : '', connected ? '' : t('managed.offline'), r.note ?? '']
  return parts.filter(Boolean).join(' · ')
}

