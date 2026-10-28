import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { PasswordInput } from './PasswordInput'

// 커스텀 확인/경고 다이얼로그 — window.confirm/alert 전면 대체 (네이티브 창 제목의 "ev" 노출 제거).
// 앱 전체에서 이 컴포넌트 하나만 쓴다. 호출측은 useDialog().ask(spec) 로 await 하고,
// 반환값('confirm' | 'cancel' | 'alt')으로 분기한다. 스타일은 기존 .overlay/.modal 재사용(.modal.sm).

export type DialogResult = 'confirm' | 'cancel' | 'alt'

export type DialogSpec = {
  title: string
  message: string
  // 지문·호스트 등 등폭으로 보여줄 부가 정보 행(호스트키 확인에서 사용).
  detail?: { label: string; value: string }[]
  // 위험 톤(호스트키 불일치·프로필 삭제): 헤더 아이콘·확인 버튼을 --err 계열로.
  tone?: 'danger'
  confirmLabel?: string
  // null 이면 취소 버튼 없음 = 단일 버튼 알림(window.alert 대체).
  cancelLabel?: string | null
  // 세 번째 선택지(예: 인증 실패 시 "비밀번호 다시 입력"). 선택 시 'alt' 반환.
  altLabel?: string
  // R6: 한 줄 텍스트 입력(그룹 만들기·이름 변경). window.prompt 대체 — askText 로 값을 받는다.
  // password: 접속 시 비밀번호를 받는 용도(2026-08-21). 가려진 칸 + 눈 토글로 그린다 —
  // 서버 비밀번호는 길고 특수문자가 섞여 있어 확인 없이 한 번에 맞게 넣기 어렵다(준영님 제보 18번).
  input?: { value?: string; placeholder?: string; password?: boolean }
}

// 다이얼로그 상태 + ask()/askText() 를 소유하는 훅. node 를 트리 한 곳에 렌더하면 앱 전역에서 재사용된다.
export function useDialog(): {
  ask: (spec: DialogSpec) => Promise<DialogResult>
  askText: (spec: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => Promise<string | null>
  node: JSX.Element
} {
  const [spec, setSpec] = useState<DialogSpec | null>(null)
  const resolveRef = useRef<((r: DialogResult) => void) | null>(null)
  // 입력값은 렌더와 무관하게 최신치만 필요하다(확인 순간 한 번 읽는다) — 상태로 두면 매 타자마다 리렌더된다.
  const textRef = useRef('')

  const ask = useCallback(
    (s: DialogSpec) =>
      new Promise<DialogResult>((resolve) => {
        resolveRef.current = resolve
        textRef.current = s.input?.value ?? ''
        setSpec(s)
        // 사람의 답을 기다린다 — 이 창이 다른 창(탐색기 창)에 가려 있으면 앞으로(다듬기 R2).
        // 탐색기의 [연결]이 호스트키·비밀번호를 물을 때가 이 자리다. 이미 앞이면 아무 일 없다.
        if (!document.hasFocus()) void window.ev?.window.focus().catch(() => {})
      }),
    []
  )

  // 확인 + 공백 아닌 값일 때만 문자열, 취소·빈 입력은 null(호출측이 "아무 일 없음"으로 처리).
  const askText = useCallback(
    async (s: DialogSpec & { input: NonNullable<DialogSpec['input']> }) => {
      const r = await ask(s)
      const v = textRef.current.trim()
      return r === 'confirm' && v ? v : null
    },
    [ask]
  )

  const close = useCallback((r: DialogResult) => {
    setSpec(null)
    const f = resolveRef.current
    resolveRef.current = null
    f?.(r)
  }, [])

  return {
    ask,
    askText,
    node: <Dialog spec={spec} onClose={close} onText={(v) => (textRef.current = v)} />
  }
}

function Dialog({
  spec,
  onClose,
  onText
}: {
  spec: DialogSpec | null
  onClose: (r: DialogResult) => void
  onText: (v: string) => void
}) {
  // 비밀번호 칸만 제어 컴포넌트다(PasswordInput 이 type 을 바꿔 그리므로 defaultValue 로는 안 된다).
  // 다이얼로그가 닫히면 값도 버린다 — 다음에 열 때 앞 비밀번호가 남아 있으면 안 된다.
  const [pw, setPw] = useState('')
  useEffect(() => {
    if (!spec) setPw('')
  }, [spec])

  // 열릴 때 포커스를 창 안으로 들인다(입력칸이 있으면 그쪽이 가져간다 — 아래 autoFocus).
  // ref 로 직접 부르는 이유: div 의 autoFocus 속성은 React 가 실제로 focus() 해 주지 않는다(실측).
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (spec && !spec.input) boxRef.current?.focus()
  }, [spec])

  // ESC=취소 / Enter=확인. 다이얼로그가 열려 있는 동안만 바인딩하고, 뒤쪽 핸들러로 새지 않게 캡처 단계에서 멈춘다.
  useEffect(() => {
    if (!spec) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose('cancel')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onClose('confirm')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [spec, onClose])

  if (!spec) return null
  const danger = spec.tone === 'danger'

  return (
    <div className="overlay open dlg-overlay" onClick={(e) => e.target === e.currentTarget && onClose('cancel')}>
      {/* 포커스는 **창 자체**가 받는다(확인 버튼이 아니라).
          2026-08-27 실측: Enter 로 무언가를 실행하다 이 창이 뜨면 — [서버 로그] 입력칸에 잘못된 값을
          넣고 Enter — 자동 포커스된 확인 버튼이 **같은 타건의 keypress** 로 눌려 창이 떴다 사라졌다
          (keydown → 버튼 포커스 → keypress → click, 2ms 안에 전부). 창이 포커스를 받으면 그 길이
          없어지고, Enter=확인은 위 window 핸들러가 그대로 담당한다(입력칸이 있으면 그쪽이 가져간다). */}
      <div
        className={'modal sm' + (danger ? ' danger' : '')}
        role="alertdialog"
        aria-modal="true"
        aria-label={spec.title}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-hd">
          <div className="mh-ico">
            {danger ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 3l9.5 17H2.5L12 3z" />
                <path d="M12 10v4M12 17h.01" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 16v-4M12 8h.01" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
          </div>
          <div>
            <h2>{spec.title}</h2>
          </div>
        </div>
        <div className="dlg-body">
          <p className="dlg-msg">{spec.message}</p>
          {spec.input?.password ? (
            <PasswordInput
              value={pw}
              autoFocus
              placeholder={spec.input.placeholder}
              ariaLabel={spec.input.placeholder ?? spec.title}
              onChange={(v) => {
                setPw(v)
                onText(v)
              }}
            />
          ) : (
            spec.input && (
              <input
                className="dlg-input"
                type="text"
                autoFocus
                defaultValue={spec.input.value ?? ''}
                placeholder={spec.input.placeholder}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => onText(e.target.value)}
              />
            )
          )}
          {spec.detail && spec.detail.length > 0 && (
            <div className="dlg-detail">
              {spec.detail.map((d) => (
                <div className="dlg-row" key={d.label}>
                  <span className="dlg-k">{d.label}</span>
                  <span className="dlg-v">{d.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-ft">
          <span className="sp" />
          {spec.altLabel && (
            <button className="btn sec" onClick={() => onClose('alt')}>
              {spec.altLabel}
            </button>
          )}
          {spec.cancelLabel !== null && (
            <button className="btn sec" onClick={() => onClose('cancel')}>
              {spec.cancelLabel ?? t('dlg.cancel')}
            </button>
          )}
          {/* 입력이 있으면 포커스는 입력칸이 가져간다(Enter 는 위 window 핸들러가 확인으로 받는다). */}
          <button className={'btn ' + (danger ? 'dgr' : 'pri')} onClick={() => onClose('confirm')}>
            {spec.confirmLabel ?? t('dlg.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
