// [Oriel 설치] 단추 — 설정 › 에이전트 › Oriel·셋업 가이드 브라우저 단계·noOriel 알림 토스트가 같이 쓴다(진행은 main push 하나를 이 저장소가 받는다).
// 누를 때만 받는다(자동 다운로드 없음). 받는 중 = 바이트 진행, 설치 중, 실패 = 이유 + [다시].
import { useSyncExternalStore, type JSX } from 'react'
import { t } from '../../i18n'
import type { OrielInstallState } from '@shared/oriel'

let state: OrielInstallState = { phase: 'idle' }
const subs = new Set<() => void>()
let wired = false
const set = (s: OrielInstallState): void => {
  state = s
  subs.forEach((f) => f())
}
function subscribe(f: () => void): () => void {
  if (!wired && window.ev?.oriel?.onInstall) {
    wired = true
    window.ev.oriel.onInstall(set)
    void window.ev.oriel.installState().then(set, () => {})
  }
  subs.add(f)
  return () => subs.delete(f)
}
export const useOrielInstall = (): OrielInstallState => useSyncExternalStore(subscribe, () => state)

const mb = (n: number): string => (n / 1048576).toFixed(1)

export function OrielInstallButton(): JSX.Element | null {
  const s = useOrielInstall()
  const start = (): void => void window.ev.oriel.install().then(set, () => {})
  if (s.phase === 'done') return <span data-aiws="oriel-install" data-phase="done">{t('oriel.install.done')}</span>
  if (s.phase === 'download' || s.phase === 'install') {
    const text = s.phase === 'install' ? t('oriel.install.installing') : s.total ? t('oriel.install.progress').replace('{got}', mb(s.got)).replace('{total}', mb(s.total)) : t('oriel.install.starting')
    return (
      <span data-aiws="oriel-install" data-phase={s.phase} role="status">
        {text}
      </span>
    )
  }
  return (
    <span data-aiws="oriel-install" data-phase={s.phase}>
      {s.phase === 'error' && <span data-aiws="oriel-install-error">{t(`oriel.install.err.${s.reason}`).replace('{d}', s.detail ?? '')} </span>}
      <button type="button" className="btn sec" data-aiws="oriel-install-go" onClick={(e) => (e.stopPropagation(), start())}>
        {s.phase === 'error' ? t('oriel.install.retry') : t('oriel.install.go')}
      </button>
    </span>
  )
}
