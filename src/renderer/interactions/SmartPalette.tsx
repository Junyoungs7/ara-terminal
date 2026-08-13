import { useEffect, useMemo, useRef, useState } from 'react'
import { CONTEXT_ACTIONS, type ActionId } from './actions'

// 스마트 팔레트 (design-system §9.2 / 목업 openSmartPalette). 커서 옆 280px, 뷰포트 클램프.
// 검색은 액션 라벨(한글) 필터. 라디얼과 동일한 CONTEXT_ACTIONS 를 공유(이중 정의 금지).
const PW = 280
const PH = 320

type Props = {
  open: boolean
  x: number
  y: number
  onAction: (id: ActionId) => void
}

// 뷰포트 경계 안으로 보정한 좌표(순수 — 경계 보정 단위 테스트 대상).
export function clampToViewport(
  x: number,
  y: number,
  vw: number,
  vh: number
): { left: number; top: number } {
  return { left: Math.min(x, vw - PW - 8), top: Math.min(y, vh - PH - 8) }
}

export function SmartPalette({ open, x, y, onAction }: Props) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      // 등장 애니메이션 뒤 포커스.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, x, y])

  const filtered = useMemo(() => {
    const s = q.trim()
    if (!s) return CONTEXT_ACTIONS
    return CONTEXT_ACTIONS.filter((a) => a.labelKo.includes(s))
  }, [q])

  if (!open) return null
  const pos = clampToViewport(x, y, window.innerWidth, window.innerHeight)

  return (
    <div className="smart-palette open" style={{ left: pos.left, top: pos.top }}>
      <div className="sp-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          placeholder="작업 검색…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="esc-kbd">ESC</span>
      </div>
      <div className="sp-section">작업</div>
      {filtered.length === 0 ? (
        <div className="sp-empty">일치하는 작업이 없습니다</div>
      ) : (
        <div className="sp-grid">
          {filtered.map((a) => (
            <div
              key={a.id}
              className={'sp-item' + (a.tint ? ` tint-${a.tint}` : '') + (a.future ? ' future' : '')}
              data-action={a.id}
              onClick={() => onAction(a.id)}
            >
              <div className="sp-ic">{a.icon}</div>
              <div className="sp-lbl">{a.labelKo}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
