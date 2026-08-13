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
}

export function useFloatWindow(): FloatWindow {
  const [rect, setRect] = useState<Rect>(() => initialRect(window.innerWidth, window.innerHeight))
  // 최대화: 되돌릴 때를 위해 직전 사각형을 들고 있는다(브라우저 창 관례).
  const [restore, setRestore] = useState<Rect | null>(null)
  const rectRef = useRef(rect)
  rectRef.current = rect

  const drag = useCallback((e: React.MouseEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
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
  }, [])

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

  return { rect, maximized: restore !== null, drag, toggleMax }
}
