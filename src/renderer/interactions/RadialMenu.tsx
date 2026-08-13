import { useEffect, useRef, useState } from 'react'
import { CONTEXT_ACTIONS, type ActionId } from './actions'
import { IconClose } from '../components/icons'

// 라디얼 컨텍스트 메뉴 (design-system §9.1 / 목업 openRadialMenu 공식 그대로).
// 배치 공식: angleDeg = -90 + (360/n)*i, ix=cos·RADIUS, iy=sin·RADIUS. 스태거 38ms×i.
const RADIUS = 88
const STAGGER_MS = 38

type Props = {
  open: boolean
  x: number
  y: number
  onAction: (id: ActionId) => void
  onClose: () => void
}

// i번째 항목의 중심 오프셋(px). 순수 함수 — 단위 테스트 대상(경계 공식 고정).
export function radialOffset(i: number, n: number): { x: number; y: number } {
  const angleRad = ((-90 + (360 / n) * i) * Math.PI) / 180
  return { x: Math.cos(angleRad) * RADIUS, y: Math.sin(angleRad) * RADIUS }
}

export function RadialMenu({ open, x, y, onAction, onClose }: Props) {
  const items = CONTEXT_ACTIONS
  const n = items.length
  // 스태거 등장: open 되면 인덱스 순으로 shown 부여.
  const [shown, setShown] = useState<number>(-1)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (!open) {
      setShown(-1)
      return
    }
    setShown(-1)
    items.forEach((_, i) => {
      timers.current.push(setTimeout(() => setShown((s) => Math.max(s, i)), i * STAGGER_MS))
    })
    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
  }, [open, items])

  if (!open) return null

  return (
    // M-3: 컨테이너는 항목이 절대 배치라 width/height 가 0 이다(실기기 크기를 주면 항목들의 좌표
    // 계산을 전부 다시 해야 하고 시각 결과가 바뀔 위험이 있다 — role/menu 로 접근성 트리에서만
    // "보이는" 요소가 되게 한다. 시각 결과는 그대로다).
    <div className="radial-menu open" style={{ left: x, top: y }} role="menu" aria-label="컨텍스트 메뉴">
      <div className="radial-center" onClick={onClose} title="닫기 (ESC)" role="menuitem" aria-label="닫기">
        <IconClose />
      </div>
      {items.map((a, i) => {
        const off = radialOffset(i, n)
        const cls =
          'ri' +
          (i <= shown ? ' shown' : '') +
          (a.tint ? ` tint-${a.tint}` : '') +
          (a.future ? ' future' : '')
        return (
          <div
            key={a.id}
            className={cls}
            data-action={a.id}
            style={{ left: off.x, top: off.y }}
            onClick={() => onAction(a.id)}
            role="menuitem"
            aria-label={a.labelKo}
          >
            <div className="ri-icon">{a.icon}</div>
            <div className="ri-label">{a.labelKo}</div>
          </div>
        )
      })}
    </div>
  )
}
