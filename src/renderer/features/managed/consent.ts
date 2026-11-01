// M8 관리형 서버 동의 화면 — 설정 › 관리형 서버의 [설치]와 Run on(새 작업 카드에서 동의 안 된 서버를 고를 때)이 같은 화면을 쓴다.
// 진입 청크에 실려도 되는 작은 함수들(패널 본체는 lazy).
import type { ManagedConsentPlan } from '@shared/managedServers'
import type { DialogResult, DialogSpec } from '../../components/Dialog'
import { t } from '../../i18n'

const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

/** 동의 화면의 줄 — 무엇을(파일·크기) · 어디에 · 무엇이 상주 · 지우는 법. */
export function consentRows(p: ManagedConsentPlan): { label: string; value: string }[] {
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

/**
 * 묻기 → 동의 화면 → [설치]면 설치. 'installed' · 'cancel' · 그 밖은 사람에게 보일 실패 사유.
 * 지원 안 하는 서버는 동의 화면 대신 사유 한 줄과 [확인]만(그때도 'cancel').
 */
export async function askManagedConsent(ask: (spec: DialogSpec) => Promise<DialogResult>, hostKey: string): Promise<'installed' | 'cancel' | { error: string }> {
  const plan = await window.ev.managed.plan(hostKey)
  if ('error' in plan) return { error: plan.error }
  if (!plan.support.ok) {
    await ask({ title: t('managed.consent.title'), message: t(`managed.unsupported.${plan.support.reason}`), detail: [{ label: t('managed.consent.host'), value: `${hostKey} · ${plan.probe.os || '?'} ${plan.probe.arch}` }], cancelLabel: null })
    return 'cancel'
  }
  const r = await ask({ title: t('managed.consent.title'), message: t('managed.consent.message'), detail: consentRows(plan), confirmLabel: t('managed.install'), cancelLabel: t('managed.cancel') })
  if (r !== 'confirm') return 'cancel'
  const rec = await window.ev.managed.install(hostKey)
  return rec.state === 'failed' ? { error: rec.note ?? t('managed.state.failed') } : 'installed'
}
