// 떠 있는 창(파일 탐색기 · F26 서버 콘솔)의 위치·크기·최대화. ExplorerView 안에 있던 것을 그대로
// 옮겼다 — 두 번째 떠 있는 창이 생기면서 같은 50 줄을 복사하는 대신 한 곳으로 모은다.
// 사각형 계산(clampRect·initialRect)과 Rect 타입은 explorerTabs.ts 가 이미 갖고 있어 그대로 쓴다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { clampRect, initialRect, type Rect } from './explorerTabs'

export type FloatWindow = {
  rect: Rect
  /** 최대화 상태(제목줄 버튼 글리프·툴팁이 이 값으로 갈린다). */
  maximized: boolean
  /** 제목줄 mousedown = 이동, 우하단 손잡이 mousedown = 크기. */
  drag: (e: React.MouseEvent, mode: 'move' | 'resize') => void
  toggleMax: () => void
  /** 쌓임 순서. 창을 누르면 다른 창 위로 올라온다(#72). style 의 zIndex 에 그대로 넣는다. */
  z: number
  /** 아무 데나 눌렀을 때 앞으로 — 제목줄 drag 와 별개다(본문을 눌러도 올라와야 한다). */
  toFront: () => void
}

// #72(2026-08-14): 창이 둘(탐색기·서버 콘솔)인데 **좌표가 정확히 같았다** — 둘 다 같은
// initialRect 로 시작하고 z-index 도 같아서(둘 다 95), 렌더 순서상 뒤에 있는 콘솔이 항상 위였다.
// 둘 다 열면 탐색기를 앞으로 꺼낼 방법이 없었다.
//
// 고치는 법 둘: ① 두 번째 창은 어긋난 자리에서 시작한다(cascade — OS 창 관례) ② 누르면 앞으로.
let openCount = 0
const CASCADE_PX = 28
// 마지막으로 앞에 온 창의 번호. 95 는 기존 .exp-win z-index(드로어 90 위, 모달 100 아래)라
// 그 사이를 벗어나지 않게 얇게만 올린다 — 모달이 창 뒤로 가면 안 된다.
const Z_BASE = 95
let zTop = Z_BASE

export function useFloatWindow(): FloatWindow {
  // 이 창이 몇 번째로 열렸는지 — 그만큼 오른아래로 밀어 시작한다. 창을 닫으면 되돌려
  // 다음 창이 다시 가운데에서 시작한다(계단이 화면 밖으로 걸어 나가지 않게).
  const orderRef = useRef(0)
  const [z, setZ] = useState(Z_BASE)
  const [rect, setRect] = useState<Rect>(() => {
    const step = openCount * CASCADE_PX
    orderRef.current = openCount
    openCount += 1
    const base = initialRect(window.innerWidth, window.innerHeight)
    return clampRect({ ...base, x: base.x + step, y: base.y + step }, window.innerWidth, window.innerHeight)
  })
  const toFront = useCallback(() => {
    setZ((cur) => (cur === zTop ? cur : (zTop += 1)))
  }, [])
  // 열릴 때 이미 맨 앞이다 — 방금 연 창이 뒤에 숨어 있으면 안 된다.
  useEffect(() => {
    setZ((zTop += 1))
    return () => {
      openCount = Math.max(0, openCount - 1)
    }
  }, [])
  // 최대화: 되돌릴 때를 위해 직전 사각형을 들고 있는다(브라우저 창 관례).
  const [restore, setRestore] = useState<Rect | null>(null)
  const rectRef = useRef(rect)
  rectRef.current = rect

  const drag = useCallback((e: React.MouseEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    toFront()
    // 제목줄 안의 버튼(최대화·닫기)을 누른 것은 창 끌기가 아니다. 이 가드가 없으면 버튼의
    // mousedown 이 끌기로 잡혀 아래 "움직이면 최대화 해제"가 먼저 돌고, 뒤이은 click 이
    // 복원 대신 다시 최대화한다(최대화 버튼이 먹통이 된다).
    if ((e.target as HTMLElement).closest('.exp-wbtn')) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const from = rectRef.current
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const next =
        mode === 'move' ? { ...from, x: from.x + dx, y: from.y + dy } : { ...from, w: from.w + dx, h: from.h + dy }
      setRect(clampRect(next, window.innerWidth, window.innerHeight))
      // 실제로 움직인 뒤에야 최대화가 풀린다 — 누르기만 한 것으로 풀면 복원 크기를 잃는다.
      setRestore(null)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [toFront])

  const toggleMax = useCallback(() => {
    if (restore) {
      setRect(clampRect(restore, window.innerWidth, window.innerHeight))
      setRestore(null)
      return
    }
    setRestore(rectRef.current)
    setRect({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
  }, [restore])

  // 앱 창 크기가 바뀌면 떠 있는 창이 화면 밖으로 밀려날 수 있다 — 다시 안으로 당긴다.
  useEffect(() => {
    const onResize = (): void => setRect((r) => clampRect(r, window.innerWidth, window.innerHeight))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return { rect, maximized: restore !== null, drag, toggleMax, z, toFront }
}
