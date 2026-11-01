import { useCallback, useEffect, useState, type JSX } from 'react'
import type { ManagedConsentPlan, ManagedRecord } from '@shared/managedServers'
import type { ManagedListResult } from '@shared/ipc'
import { t } from '../../i18n'
import { Row } from '../../components/SettingsPage'
import { useDialog } from '../../components/Dialog'

const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

/**
 * M8 DM-03 설정 › AI 작업 공간 › 관리형 서버 — Orca managed-runtime(ManagedRuntimeInstallRow·RemoveDialog, orcaRef fdfcfb3551)의 1차.
 * 설치는 이 화면의 [설치] → 동의 화면(무엇을·어디에·무엇이 상주·지우는 법) → [설치] 일 때만. [제거] = 동의 철회(원격에서 지우고 남은 것을 잰다).
 * 연결은 지금 열린 SSH 세션의 것을 빌린다 — 목록의 "설치할 수 있는 서버"는 지금 접속해 있는 서버다.
 */
export function ManagedServersPanel(): JSX.Element {
  const [list, setList] = useState<ManagedListResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
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
      const plan = await window.ev.managed.plan(hostKey)
      if ('error' in plan) return setMsg(plan.error)
      if (!plan.support.ok) {
        await dialog.ask({ title: t('managed.consent.title'), message: t(`managed.unsupported.${plan.support.reason}`), detail: [{ label: t('managed.consent.host'), value: `${hostKey} · ${plan.probe.os || '?'} ${plan.probe.arch}` }], cancelLabel: null })
        return
      }
      const r = await dialog.ask({ title: t('managed.consent.title'), message: t('managed.consent.message'), detail: consentRows(plan), confirmLabel: t('managed.install'), cancelLabel: t('managed.cancel') })
      if (r !== 'confirm') return
      const rec = await window.ev.managed.install(hostKey)
      if (rec.state === 'failed') setMsg(rec.note ?? t('managed.state.failed'))
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
        <Row key={r.hostKey} label={r.hostKey} desc={recordDesc(r, connected.has(r.hostKey))} item={`managed.${r.hostKey}`}>
          <button type="button" className="btn" disabled={busy !== null || !connected.has(r.hostKey)} data-managed="check" onClick={() => void run(r.hostKey, async () => void (await window.ev.managed.check(r.hostKey)))}>
            {t('managed.check')}
          </button>
          <button type="button" className="btn" disabled={busy !== null || !connected.has(r.hostKey)} data-managed="remove" onClick={() => void remove(r.hostKey)}>
            {t('managed.remove')}
          </button>
        </Row>
      ))}
      <div className="set-sec-t" data-item="managed.install">
        {t('managed.installable')}
      </div>
      {fresh.length === 0 && <div className="set-note">{t('managed.noTargets')}</div>}
      {fresh.map((x) => (
        <Row key={x.hostKey} label={x.label} desc={x.hostKey} item={`managed.add.${x.hostKey}`}>
          <button type="button" className="btn" disabled={busy !== null} data-managed="install" onClick={() => void consent(x.hostKey)}>
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

/** 동의 화면의 줄 — 무엇을(파일·크기) · 어디에 · 무엇이 상주 · 지우는 법. */
function consentRows(p: ManagedConsentPlan): { label: string; value: string }[] {
  return [
    { label: t('managed.consent.host'), value: `${p.hostKey} · ${p.probe.os} ${p.probe.arch} · python ${p.probe.pyver}` },
    { label: t('managed.consent.where'), value: `${p.dir} ${t('managed.consent.whereNote')}` },
    { label: t('managed.consent.what'), value: p.files.map((f) => `${f.path} (${kb(f.bytes)})`).join(' · ') },
    { label: t('managed.consent.runtime'), value: p.runtimeFiles.join(' · ') },
    { label: t('managed.consent.resident'), value: `${p.process} — ${t('managed.consent.residentNote')}` },
    { label: t('managed.consent.socket'), value: `${p.socket} ${t('managed.consent.socketNote')}` },
    { label: t('managed.consent.never'), value: t('managed.consent.neverNote') },
    { label: t('managed.consent.remove'), value: `${t('managed.consent.removeNote')} — ${p.manualRemove}` }
  ]
}
