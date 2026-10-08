import { CTR_RESTARTS } from '@shared/remoteCatalog'
import type { RunForm } from '@shared/ctrConflict'
import { IconClose } from './icons'
import { t } from '../i18n'

// 오류 신고 #11(2026-10-08) — [새 컨테이너] 실행 창. 껍데기는 오류 신고 창과 같은
// `.overlay/.modal/.modal-hd/.dlg-body/.modal-ft` 이고, 칸은 연결 관리자 `.fld` 그대로.
//
// 값은 **부모(ContainerTable)가 들고 있다** — 사전 확인 다이얼로그를 띄우는 동안 이 창을 닫았다가
// [취소]면 쓰던 그대로 다시 연다(겹친 오버레이의 쌓임 순서에 기대지 않는다).
// 바깥을 눌러도 닫지 않는다 — 써 둔 칸이 한 번의 클릭에 사라지면 안 된다(BugReportModal 과 같은 규칙).

export const EMPTY_RUN: RunForm = { image: '', name: '', ports: '', env: '', restart: 'unless-stopped', cmd: '' }

type Props = {
  value: RunForm
  server?: string
  /** 형식이 틀린 칸 — 그 칸 아래에 이유를 쓴다. */
  error: { field: keyof RunForm; line?: string } | null
  onChange: (v: RunForm) => void
  onSubmit: () => void
  onClose: () => void
}

export function CtrRunDialog({ value, server, error, onChange, onSubmit, onClose }: Props): JSX.Element {
  const set = (k: keyof RunForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value })
  const err = (k: keyof RunForm) =>
    error?.field === k && (
      <span className="ctr-run-err" data-field={'ctr.run.err.' + k}>
        {t('console.ctr.run.bad.' + k).replace('{line}', error.line ?? '')}
      </span>
    )

  return (
    <div className="overlay open">
      <div
        className="modal sm ctr-run"
        role="dialog"
        aria-modal="true"
        aria-label={t('console.ctr.run.title')}
        // 앱 단축키가 뒤로 새지 않게 끊는다(입력 중인 글자가 탭을 열면 안 된다).
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </div>
          <div>
            <h2>{t('console.ctr.run.title')}</h2>
            {server && <p>{server}</p>}
          </div>
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="dlg-body">
          <div className="fld">
            <label>{t('console.ctr.run.f.image')}</label>
            <input type="text" autoFocus spellCheck={false} placeholder="redis:8-alpine" value={value.image} onChange={set('image')} />
            {err('image')}
          </div>
          <div className="fld">
            <label>{t('console.ctr.run.f.name')}</label>
            <input type="text" spellCheck={false} placeholder="jarvis-redis" value={value.name} onChange={set('name')} />
            {err('name')}
          </div>
          <div className="fld">
            <label>{t('console.ctr.run.f.ports')}</label>
            <textarea rows={2} spellCheck={false} placeholder="8512:6379" value={value.ports} onChange={set('ports')} />
            {err('ports')}
          </div>
          <div className="fld">
            <label>{t('console.ctr.run.f.env')}</label>
            <textarea rows={2} spellCheck={false} placeholder="TZ=Asia/Seoul" value={value.env} onChange={set('env')} />
            {err('env')}
          </div>
          <div className="fld">
            <label>{t('console.ctr.run.f.restart')}</label>
            <select value={value.restart} onChange={set('restart')}>
              {CTR_RESTARTS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label>{t('console.ctr.run.f.cmd')}</label>
            <input type="text" spellCheck={false} placeholder="redis-server --appendonly yes" value={value.cmd} onChange={set('cmd')} />
            {err('cmd')}
          </div>
        </div>
        <div className="modal-ft">
          <span className="sp" />
          <button type="button" className="btn sec" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button type="button" className="btn pri" data-action="ctr.run.submit" onClick={onSubmit}>
            {t('console.ctr.run.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
