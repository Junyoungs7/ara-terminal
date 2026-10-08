import { useCallback, useEffect, useState } from 'react'
import type { FontConfig } from '@shared/types'
import { stackFor } from '../terminal/fontStacks'
import { applyFontToAll, remeasureAll } from '../terminal/termRegistry'

// F5 폰트 설정 단일 소스. workspace.json ui.font 에서 하이드레이트 →
// (1) --term/--tt/--tl CSS 변수 바인딩(sizePx↔--tt, 계획서 C-5)
// (2) 열린 모든 xterm 즉시 반영(재마운트 금지)
// (3) ui.setFont 로 영속(재시작 후 유지).

const DEFAULT_FONT: FontConfig = { term: 'Nanum Gothic Coding', sizePx: 14, lineHeight: 1.58 }

// CSS 변수 바인딩 — TerminalPane 이 mount 시 --term/--tt/--tl 을 읽으므로,
// 새 탭도 현재 폰트로 열린다(하이드레이트/변경 양쪽에서 호출).
//
// **시스템 글꼴은 고정, 터미널 글꼴만 사용자 설정** (2026-08-21 준영님 확정).
//
// 그래서 여기서 건드리는 것은 `--term` 하나뿐이다. 예전에는 `--mono` 도 같이 세팅해서
// 사용자가 터미널 폰트를 바꾸면 **앱 화면 전체**가 따라 바뀌었다(shell.css 70곳이 --mono 였다)
// — 그게 준영님이 지적하신 "개발용 티"의 8할이었다.
//
// 지금 글꼴은 셋으로 갈린다:
//   --ui   SUIT                크롬 전부. 고정. 설정에 없다
//   --mono 나눔고딕코딩         경로·명령·로그·에디터·키 표기. **고정.** 설정에 없다
//   --term 사용자 선택          터미널 본문 **전용**. 설정 [폰트]가 이것만 바꾼다
//
// --mono 를 왜 고정하나: 그 자리들(경로·로그)은 터미널이 아니라 **앱 화면**이다. 화면 글꼴이
// 사용자 설정에 따라 흔들리면 레이아웃도 같이 흔들린다 — 시스템 글꼴을 고정한다는 결정이
// 곧 이 뜻이다. 고정폭이어야 하는 것은 성격 때문이지 터미널과 같아야 해서가 아니다.
//
// 상단 잘림 증상의 실제 원인은 별개로 확인됨 — 나눔고딕코딩이 11.5px 같은 소수 픽셀 크기에서
// 상단 획 안티에일리어싱이 뭉개지는 래스터화 한계였다(스택 순서와는 무관 — 실측: agent_talk/UI-font-done.md).
// 그래서 크기 쪽은 CSS(design-system §2.2, 12px 하한)에서 별도로 올렸다.
// 크기(--tt/--tl)도 터미널 전용이다 — UI 크기는 설정 [일반]의 UI 배율(--ui-scale)이 따로 쥔다.
export function bindCssVars(font: FontConfig): void {
  const root = document.documentElement.style
  const stack = stackFor(font.term, font.krSystemFallback ?? true)
  root.setProperty('--term', stack)
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

  // 번들 폰트가 **나중에** 도착하면 xterm 이 처음 잰 셀 크기가 틀린 채로 굳는다
  // (`remeasureAll` 주석에 실측값). 한 묶음이 다 왔을 때마다 다시 맞춘다.
  //
  // `document.fonts.ready` 를 쓰지 않는 이유: 그 약속은 **읽는 시점**에 진행 중인 로딩만 기다린다.
  // 터미널 글꼴은 첫 터미널이 그려질 때 비로소 요청되므로, 부팅 때 미리 읽어 둔 ready 는
  // 그보다 먼저 풀려 아무것도 못 잡는다. `loadingdone` 은 그 뒤의 묶음에도 계속 온다.
  useEffect(() => {
    const onLoaded = (): void => remeasureAll()
    document.fonts.addEventListener('loadingdone', onLoaded)
    return () => document.fonts.removeEventListener('loadingdone', onLoaded)
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
