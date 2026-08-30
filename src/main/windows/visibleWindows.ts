// "지금 이 앱을 보고 있는 사람이 있나" — 창 하나가 아니라 **전부**로 판정한다 (#147).
//
// 왜 한 함수인가: 이 판정이 걸리는 자리가 창마다·이벤트마다(show/hide/minimize/restore/closed)
// 여럿이라, 각자 세면 그중 하나가 곧 어긋난다(그 순간 원격 폴링이 안 멎거나, 보고 있는데 멎는다).
//
// 왜 "본창이 최소화됐나"가 아닌가: 탭을 떼어낸 세션 창(SessionWindows)과 포트 모니터 독립 창
// (PortWindow)이 있다. 본창을 내려놓고 다른 모니터의 포트 모니터를 보는 것이 그 창들의 용도 자체다 —
// 본창만 보고 멈추면 **보고 있는 화면이 죽는다.**
//
// isVisible 과 isMinimized 를 둘 다 본다: Windows 에서 최소화된 창은 isVisible() 이 그대로 true 다.
// Electron 없이 도는 순수 함수 — tests/telemetry.test.ts 가 검증한다.
export type WindowVisibility = {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
}

export function anyWindowVisible(windows: readonly WindowVisibility[]): boolean {
  return windows.some((w) => {
    try {
      return !w.isDestroyed() && w.isVisible() && !w.isMinimized()
    } catch {
      return false // 파괴 레이스 — 그 창은 없는 것으로 친다(SessionWindows.araWindowAt 과 같은 관행)
    }
  })
}
