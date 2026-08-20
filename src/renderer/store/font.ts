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
// --mono 는 **터미널이 고른 글꼴을 따라간다.** 여기까지는 UI-font(2026-08-04) 때와 같다.
//
// 달라진 것(2026-08-21 · G 채택): `--mono` 가 더 이상 **크롬 전체**를 칠하지 않는다.
// 그때는 "UI 라벨도 터미널과 같은 폰트"가 확정 요구였고 shell.css 70곳이 --mono 였는데,
// 그 결과가 준영님이 지적하신 "개발용 티"의 8할이었다(사이드바 이름·설정 항목·드롭다운까지
// 코딩용 고정폭). 지금은 크롬이 --ui(Pretendard)를 쓰고, --mono 는 **22곳**에만 남는다:
// 경로 · 명령줄 · 로그 본문 · 에디터 · 키 표기 · API 키 — *격자에 맞아야 뜻이 사는* 자리들.
// 그 22곳이 터미널 글꼴 선택을 따라가는 것은 여전히 맞다(같은 성격의 글자다).
//
// 상단 잘림 증상의 실제 원인은 별개로 확인됨 — 나눔고딕코딩이 11.5px 같은 소수 픽셀 크기에서
// 상단 획 안티에일리어싱이 뭉개지는 래스터화 한계였다(스택 순서와는 무관 — 실측: agent_talk/UI-font-done.md).
// 그래서 크기 쪽은 CSS(design-system §2.2, 12px 하한)에서 별도로 올렸다.
// 크기(--tt/--tl)는 터미널 전용이라 UI 크기 체계는 그대로 — font-family만 맞춘다.
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
