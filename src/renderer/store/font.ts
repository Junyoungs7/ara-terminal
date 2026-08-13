import { useCallback, useEffect, useState } from 'react'
import type { FontConfig } from '@shared/types'
import { stackFor } from '../terminal/fontStacks'
import { applyFontToAll } from '../terminal/termRegistry'

// F5 폰트 설정 단일 소스. workspace.json ui.font 에서 하이드레이트 →
// (1) --term/--tt/--tl CSS 변수 바인딩(sizePx↔--tt, 계획서 C-5)
// (2) 열린 모든 xterm 즉시 반영(재마운트 금지)
// (3) ui.setFont 로 영속(재시작 후 유지).

const DEFAULT_FONT: FontConfig = { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }

// CSS 변수 바인딩 — TerminalPane 이 mount 시 --term/--tt/--tl 을 읽으므로,
// 새 탭도 현재 폰트로 열린다(하이드레이트/변경 양쪽에서 호출).
//
// UI-font: --mono(사이드바·상태바·탭·설정 등 UI 라벨)를 --term과 같은 스택으로 맞춘다 — 준영님 확정 요구.
// 이전엔 --mono 1순위가 JetBrains Mono(한글 미지원)라 UI 한글은 항상 2순위 폴백으로 렌더링됐다.
// 그 자체가 버그였고(선택하지도 않은 폰트가 화면에 나온다) 이번에 함께 고친다.
// 상단 잘림 증상의 실제 원인은 별개로 확인됨 — 나눔고딕코딩이 11.5px 같은 소수 픽셀 크기에서
// 상단 획 안티에일리어싱이 뭉개지는 래스터화 한계였다(스택 순서와는 무관 — 실측: agent_talk/UI-font-done.md).
// 그래서 크기 쪽은 CSS(design-system §2.2, 12px 하한)에서 별도로 올렸고, 여기서는 폰트 패밀리만 맞춘다.
// 크기(--tt/--tl)는 터미널 전용이라 UI 크기 체계는 그대로 — font-family만 통일.
export function bindCssVars(font: FontConfig): void {
  const root = document.documentElement.style
  const stack = stackFor(font.term, font.krSystemFallback ?? true)
  root.setProperty('--term', stack)
  root.setProperty('--mono', stack)
  root.setProperty('--tt', `${font.sizePx}px`)
  root.setProperty('--tl', String(font.lineHeight))
}

export function useFont() {
  const [font, setFont] = useState<FontConfig>(DEFAULT_FONT)

  // 초기 하이드레이트: 스냅샷 ui.font → CSS 변수 + 상태.
  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => {
        const f = snap.ui.font ?? DEFAULT_FONT
        bindCssVars(f)
        setFont(f)
      })
      .catch(() => {})
  }, [])

  // 변경 적용: 상태 + CSS 변수 + 열린 xterm 전체 + 영속. 부분 갱신(크기만/폰트만) 지원.
  const update = useCallback((patch: Partial<FontConfig>) => {
    setFont((prev) => {
      const next: FontConfig = { ...prev, ...patch }
      bindCssVars(next)
      applyFontToAll(stackFor(next.term, next.krSystemFallback ?? true), next.sizePx, next.lineHeight)
      window.ev?.ui.setFont(next)
      return next
    })
  }, [])

  return { font, update }
}
