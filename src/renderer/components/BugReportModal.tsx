import { useCallback, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { recentErrors } from '../store/errorRing'
import { termRenderer } from '../terminal/webglChoice'
import type { ReportPrepared, ReportSendResult } from '@shared/bugReport'

// 오류 신고(#206) — 기획 docs/plan-bug-report.md §2·§3·§4, 계약 docs/bug-report-api.md.
// 껍데기는 Dialog 의 `.overlay/.modal/.modal-hd/.dlg-body/.modal-ft` 그대로(AiBootstrapModal 과 같은 결) —
// 새 모달 프레임워크를 만들지 않는다.

const LOG_PREVIEW_LINES = 8

// 신고 창이 **닫히는 메뉴·팔레트까지** 다 지워진 화면을 찍으려면 한 번 그려질 틈이 필요하다.
// 클릭 → 메뉴 닫힘(React 커밋)과 캡처 사이에 프레임이 없으면 드롭다운이 사진에 남는다.
const nextPaint = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

/**
 * 신고 창 훅 — 본창(Shell)·떼어낸 창(SessionWindow)이 같은 것을 쓴다.
 *
 * 🔴 **먼저 찍고, 그다음 연다.** `report.prepare()`(main 이 부른 창을 capturePage)의 답을 받은 **뒤에야**
 *    `setPrepared` 로 창을 그린다. 순서가 바뀌면 신고 창이 찍힌다(기획 §3). tests/bugReport.test.ts 가
 *    이 순서를 소스에서 잰다.
 */
export function useBugReport(): { open: () => Promise<void>; node: JSX.Element | null } {
  const [prepared, setPrepared] = useState<ReportPrepared | null>(null)
  const busy = useRef(false)

  const open = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      await nextPaint()
      const p = await window.ev.report.prepare().catch(() => ({ capture: null, log: '', settings: '' }))
      setPrepared(p)
    } finally {
      busy.current = false
    }
  }, [])

  const close = useCallback(() => setPrepared(null), [])
  return { open, node: prepared ? <BugReportModal prepared={prepared} onClose={close} /> : null }
}

type Checks = { capture: boolean; log: boolean; errors: boolean; settings: boolean }

function BugReportModal({ prepared, onClose }: { prepared: ReportPrepared; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [what, setWhat] = useState('')
  const [happened, setHappened] = useState('')
  const [expected, setExpected] = useState('')
  const [name, setName] = useState('')
  const [checks, setChecks] = useState<Checks>({ capture: true, log: true, errors: true, settings: true })
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ReportSendResult | null>(null)
  // 창이 열린 순간의 것 — 신고 창을 다루다 난 오류가 섞이지 않게.
  const errors = useMemo(() => recentErrors(), [])
  const logLines = prepared.log ? prepared.log.split('\n').length : 0

  const canSend = title.trim() !== '' && happened.trim() !== '' && !sending
  // 🔴 실패해도 다시 보내지 않는다(DLP 규칙) — 결과를 보여 주고 사람이 [보내기]를 다시 누를지 정한다.
  const submit = async () => {
    if (!canSend) return
    setSending(true)
    const r = await window.ev.report
      .send({
        title: title.trim(),
        what,
        happened,
        expected,
        name: name.trim(),
        gpu: [termRenderer.kind, termRenderer.gpu].filter(Boolean).join(' · '),
        ...(checks.capture && prepared.capture ? { capture: prepared.capture } : {}),
        ...(checks.log && prepared.log ? { log: prepared.log } : {}),
        ...(checks.errors && errors.length ? { rendererErrors: errors } : {}),
        ...(checks.settings && prepared.settings ? { settings: true } : {})
      })
      .catch((): ReportSendResult => ({ ok: false, reason: 'network' }))
    setSending(false)
    setResult(r)
  }

  const fail =
    result && !result.ok
      ? result.reason === 'server'
        ? result.error
        : result.reason === 'http'
          ? t('report.fail.http').replace('{status}', String(result.status))
          : t('report.fail.network')
      : null

  const check = (k: keyof Checks, label: string) => (
    <label className="fb-check">
      <input type="checkbox" checked={checks[k]} onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))} />
      {label}
    </label>
  )

  return (
    // 오류 신고 #6: 바깥을 눌러도 닫지 않는다 — 써 둔 글이 한 번의 클릭에 사라졌다. [×]·[취소]·Esc 로만 닫는다.
    <div className="overlay open">
      <div
        className="modal sm bug-report"
        role="dialog"
        aria-modal="true"
        aria-label={t('report.title')}
        // 앱 단축키가 뒤로 새지 않게 여기서 끊는다(입력 중인 글자가 탭을 열면 안 된다).
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !sending) onClose()
        }}
      >
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 3l9.5 17H2.5L12 3z" />
              <path d="M12 10v4M12 17h.01" />
            </svg>
          </div>
          <div>
            <h2>{t('report.title')}</h2>
          </div>
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {result?.ok ? (
          <>
            <div className="dlg-body" data-field="report.result">
              <p className="dlg-msg">{t('report.done').replace('{n}', String(result.number))}</p>
              {result.tampered.length > 0 && (
                <p className="dlg-msg br-warn">{t('report.tampered').replace('{names}', result.tampered.join(', '))}</p>
              )}
            </div>
            <div className="modal-ft">
              <span className="sp" />
              <button type="button" className="btn pri" autoFocus onClick={onClose}>
                {t('dlg.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dlg-body">
              <p className="br-note">{t('report.notice')}</p>
              <div className="fld">
                <label>{t('report.f.title')}</label>
                <input type="text" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="fld">
                <label>{t('report.f.what')}</label>
                <textarea rows={2} maxLength={5000} value={what} onChange={(e) => setWhat(e.target.value)} />
              </div>
              <div className="fld">
                <label>{t('report.f.happened')}</label>
                <textarea rows={3} maxLength={5000} value={happened} onChange={(e) => setHappened(e.target.value)} />
              </div>
              <div className="fld">
                <label>{t('report.f.expected')}</label>
                <textarea rows={2} maxLength={5000} value={expected} onChange={(e) => setExpected(e.target.value)} />
              </div>
              <div className="fld">
                <label>{t('report.f.name')}</label>
                <input type="text" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              {/* 첨부 — 보내기 전에 **보여 준다**(기획 §3). 캡처는 그대로 그림으로, 로그는 줄 수와 앞부분. */}
              {prepared.capture && (
                <div className="fld">
                  {check('capture', t('report.a.capture'))}
                  {checks.capture && (
                    <img className="br-cap" alt={t('report.a.capture')} src={'data:image/png;base64,' + prepared.capture} />
                  )}
                </div>
              )}
              {prepared.log && (
                <div className="fld">
                  {check('log', t('report.a.log').replace('{n}', String(logLines)))}
                  {checks.log && (
                    <pre className="br-log">{prepared.log.split('\n').slice(0, LOG_PREVIEW_LINES).join('\n')}</pre>
                  )}
                </div>
              )}
              {errors.length > 0 && check('errors', t('report.a.errors').replace('{n}', String(errors.length)))}
              {prepared.settings && check('settings', t('report.a.settings'))}
            </div>
            <div className="modal-ft">
              {fail && <span className="err">{fail}</span>}
              <span className="sp" />
              <button type="button" className="btn sec" disabled={sending} onClick={onClose}>
                {t('dlg.cancel')}
              </button>
              <button type="button" className="btn pri" data-action="report.send" disabled={!canSend} onClick={() => void submit()}>
                {sending ? t('report.sending') : t('report.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
