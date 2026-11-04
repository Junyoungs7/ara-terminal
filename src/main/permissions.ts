// 렌더러 권한 요청 판정 — main/index.ts 의 setPermissionRequestHandler 가 부른다(순수 함수 — 시험 대상).
// 열어 주는 것은 둘뿐이다: 마이크(2.1 음성, 오디오만)와 **아라 자기 화면의 알림**(창을 내려 두면 승인·완료를 Windows 알림으로).
// 2026-11-04: 알림까지 거절하던 탓에 렌더러 Notification 이 조용히 버려져, 아라를 내리면 알림이 하나도 오지 않았다.
// 알림은 아라 본 화면(최상위 프레임, 아라가 띄운 주소)에서만 — HTML 미리보기(ara-doc:)·iframe 은 계속 거절.
export type PermissionAsk = {
  permission: string
  mediaTypes?: readonly string[]
  isMainFrame?: boolean
  requestingUrl?: string
}

export function allowPermission(ask: PermissionAsk, appUrl: (url: string) => boolean): boolean {
  if (ask.permission === 'media') {
    const types = ask.mediaTypes ?? []
    return types.length > 0 && types.every((t) => t === 'audio')
  }
  if (ask.permission === 'notifications') return ask.isMainFrame === true && !!ask.requestingUrl && appUrl(ask.requestingUrl)
  return false
}
