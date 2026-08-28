import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { dispatchAction } from '../../shared/keymap'
import { AI_PROVIDER_LABELS, DEFAULT_AI_PROVIDER, type AiProvider } from '@shared/types'
import { buildBootstrapPrompt, BOOTSTRAP_FIELD_MAX, type BootstrapForm, type BootstrapKind } from './aiBootstrap'

// F17 AI 부트스트랩 GUI — 폼만 새로 만든다. 전송·표시는 AiPanel/AraSession(F16)을 그대로 재사용한다
// (onSubmit 이 조립된 프롬프트 문자열 하나를 Shell 에 올리고, Shell 이 그걸 AiPanel 의 기존
// prefill(+autoSend) 경로로 흘린다 — 두 번째 AI 전송 경로를 만들지 않는다).
//
// 바깥 껍데기는 Dialog(.overlay/.modal/.modal-hd/.dlg-body/.modal-ft)를, 행은 설정 드로어의
// .set-row/.sr-* 를 그대로 쓴다 — 새 모달 프레임워크를 만들지 않는다.

const KINDS: readonly BootstrapKind[] = ['web', 'cli', 'script']

const emptyForm: BootstrapForm = { kind: 'web', runtime: '', target: 'local', name: '', path: '' }

type Props = {
  open: boolean
  // 활성 세션이 SSH 인지 — 아니면 대상 선택에서 SSH 를 고를 수 없다(F16 과 같은 판단: 없는 것을
  // 고를 수 있게 보여주면 "왜 안 되지"가 생긴다).
  hasSsh: boolean
  onClose: () => void
  // 조립된 프롬프트 한 통을 올린다. 전송은 여기서 하지 않는다.
  onSubmit: (prompt: string) => void
}

export function AiBootstrapModal({ open, hasSsh, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<BootstrapForm>(emptyForm)
  const [hasKey, setHasKey] = useState(true)
  // 안내 문구가 "무엇의 키인지" 말하려면 프로바이더 이름이 있어야 한다 — getState 가 이미 준다.
  const [provider, setProvider] = useState<AiProvider>(DEFAULT_AI_PROVIDER)

  // 열릴 때마다 폼 리셋 + 키 상태 재조회(F16 노키 안내와 같은 카드를 보여줄지 판단).
  useEffect(() => {
    if (!open) return
    setForm({ ...emptyForm, target: hasSsh ? emptyForm.target : 'local' })
    void window.ev?.ai
      .getState()
      .then((s) => {
        setHasKey(s.hasKey)
        setProvider(s.provider)
      })
      .catch(() => {})
  }, [open, hasSsh])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = () => {
    onSubmit(buildBootstrapPrompt(form))
    onClose()
  }

  return (
    <div className="overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sm ai-bootstrap" role="dialog" aria-modal="true" aria-label={t('ai.bootstrap.title')}>
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z" />
            </svg>
          </div>
          <div>
            <h2>{t('ai.bootstrap.title')}</h2>
          </div>
          {/* SVG 는 스크린리더가 읽지 않는다 — 이름은 여기서 준다(닫기 버튼 감사, FINISH-M2). */}
          <span className="x" role="button" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </span>
        </div>

        {!hasKey ? (
          // F16 과 같은 안내(설계 §7 오류 UX) — 폼을 채우게 두고 나중에 실패시키지 않는다.
          <div className="dlg-body">
            <div className="ai-card">
              <div className="ai-card-t">{t('ai.noKey.title')}</div>
              {/* 2026-08-28 감사 ①(b): 여기가 `ai.noKey.desc` 를 부르고 있었는데 그런 키는 없다 —
                  화면에 키 문자열이 그대로 찍혔다(t() 는 없는 키를 그대로 돌려준다). 문구는 갈려
                  있다: 앞은 프로바이더 이름, 뒤는 `ai.noKey.desc.suffix`. **새 PC 첫 실행 경로**라
                  처음 켠 사람이 보는 자리다. AiPanel:300 과 같은 방식으로 조립한다. */}
              <div className="ai-card-d">
                {AI_PROVIDER_LABELS[provider]} {t('ai.noKey.desc.suffix')}
              </div>
              <button type="button" className="btn sec" onClick={() => dispatchAction('settings.open')}>
                {t('ai.noKey.btn')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="dlg-body">
              <div className="set-row">
                <div className="sr-main">
                  <div className="sr-label">{t('ai.bootstrap.kind')}</div>
                </div>
                <div className="sr-ctl">
                  <div className="seg-ctl">
                    {KINDS.map((k) => (
                      <button
                        type="button"
                        key={k}
                        className={form.kind === k ? 'on' : ''}
                        onClick={() => setForm((f) => ({ ...f, kind: k }))}
                      >
                        {t('ai.bootstrap.kind.' + k)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="set-row stack">
                <div className="sr-main">
                  <div className="sr-label">{t('ai.bootstrap.runtime')}</div>
                </div>
                <div className="sr-ctl">
                  <input
                    className="dlg-input"
                    type="text"
                    maxLength={BOOTSTRAP_FIELD_MAX}
                    placeholder={t('ai.bootstrap.runtime.placeholder')}
                    value={form.runtime}
                    onChange={(e) => setForm((f) => ({ ...f, runtime: e.target.value }))}
                  />
                </div>
              </div>

              <div className="set-row">
                <div className="sr-main">
                  <div className="sr-label">{t('ai.bootstrap.target')}</div>
                </div>
                <div className="sr-ctl">
                  <div className="seg-ctl">
                    <button
                      type="button"
                      className={form.target === 'local' ? 'on' : ''}
                      onClick={() => setForm((f) => ({ ...f, target: 'local' }))}
                    >
                      {t('ai.bootstrap.target.local')}
                    </button>
                    <button
                      type="button"
                      disabled={!hasSsh}
                      title={hasSsh ? undefined : t('ai.noSession')}
                      className={form.target === 'ssh' ? 'on' : ''}
                      onClick={() => hasSsh && setForm((f) => ({ ...f, target: 'ssh' }))}
                    >
                      {t('ai.bootstrap.target.ssh')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="set-row stack">
                <div className="sr-main">
                  <div className="sr-label">{t('ai.bootstrap.name')}</div>
                </div>
                <div className="sr-ctl">
                  <input
                    className="dlg-input"
                    type="text"
                    maxLength={BOOTSTRAP_FIELD_MAX}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
              </div>

              <div className="set-row stack">
                <div className="sr-main">
                  <div className="sr-label">{t('ai.bootstrap.path')}</div>
                </div>
                <div className="sr-ctl">
                  <input
                    className="dlg-input"
                    type="text"
                    maxLength={BOOTSTRAP_FIELD_MAX}
                    value={form.path}
                    onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))}
                  />
                </div>
              </div>
            </div>
            <div className="modal-ft">
              <span className="sp" />
              <button type="button" className="btn sec" onClick={onClose}>
                {t('dlg.cancel')}
              </button>
              <button type="button" className="btn pri" data-action="ai.bootstrap.submit" onClick={submit}>
                {t('ai.bootstrap.submit')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
