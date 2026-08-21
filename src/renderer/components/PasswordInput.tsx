import { useState } from 'react'
import { IconEye, IconEyeOff } from './icons'
import { t } from '../i18n'

// 비밀번호 칸 + 표시 토글 (2026-08-21 준영님 요청).
//
// 왜 필요한가: 준영님 제보 30번("신규 서버 등록시 비밀번호가 전부 틀리대")의 절반이 **오타를
// 확인할 방법이 없었다는 것**이다. 나머지 절반은 인증 방식이 키로 기본 잡혀 있던 것(ConnectionModal).
// 서버 비밀번호는 길고 특수문자가 섞여 있어 가려진 칸에 한 번에 맞게 넣기 어렵다.
//
// 기본은 가려진 상태다 — 눌러서 보는 것은 사용자의 선택이고, 화면 공유 중에 저절로 드러나면 안 된다.
// 값은 상태에 남기지 않는다(호출측이 저장 직후 비운다) — 이 컴포넌트는 표시 방식만 바꾼다.
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  ariaLabel
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  ariaLabel?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className={'pw-wrap' + (show ? ' shown' : '')}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pw-eye"
        // 토글 버튼이 폼 제출을 겸하지 않게(모달은 Enter 로 제출된다) tabIndex 는 살려 둔다 —
        // 키보드로도 값을 확인할 수 있어야 한다.
        title={t(show ? 'pw.hide' : 'pw.show')}
        aria-label={t(show ? 'pw.hide' : 'pw.show')}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  )
}
