// F14: 터미널 Ctrl+V(파일) → [파일] 탭의 SFTP 전송 큐.
// 업로드 경로·진행률·취소 UI 를 두 벌 만들지 않으려고 R7 큐를 그대로 호출한다. FileTree 가
// 자기 uploadPaths 와 현재 원격 디렉토리를 쥐고 있으므로 그쪽이 등록하고 터미널이 부른다
// (termRegistry 와 같은 모듈 슬롯 패턴 — UI 상태가 아니라 배선이라 스토어가 아니다).
type Uploader = {
  // 등록한 세션. 터미널이 다른 세션이면 호출하지 않는다(엉뚱한 서버로 올리는 사고 방지).
  sessionId: string
  upload: (paths: string[]) => void
  // 큐가 사이드바 [파일] 탭 안에 있어서, 접혀 있거나 [연결] 탭이면 진행률이 보이지 않는다.
  reveal: () => void
}

let current: Uploader | null = null

export function setUploader(u: Uploader | null): void {
  current = u
}

/**
 * 폴백이 일어났다고 알릴 곳(2026-08-16). 슬롯이 **하나**뿐이라 원격 트리가 둘 이상 뜨면
 * 나중에 마운트된 쪽이 가져간다 — 작업대는 한 번 열면 안 죽으므로(#74) 그 뒤로 터미널 Ctrl+V 가
 * 사이드바 트리 대신 작업대 세션을 겨누고, 세션이 다르면 조용히 텍스트 붙여넣기로 떨어졌다.
 * **말없이 다르게 동작한 것**이 문제의 본체다. 근본 수리(세션별 Map)는 따로 잡고, 우선 말하게 한다.
 * setSpanNotifier·setClipboardNotifier 와 같은 패턴 — MainArea 의 토스트로 나간다.
 */
let notify: ((msg: string) => void) | null = null

export function setUploadNotifier(fn: ((msg: string) => void) | null): void {
  notify = fn
}

/** 업로드로 넘기지 못해 텍스트 붙여넣기로 떨어졌다 — 그 사실을 화면에 낸다. */
export function notifyPasteFallback(msg: string): void {
  notify?.(msg)
}

// 업로드를 넘겼으면 true. false 면 호출측이 기존 동작(텍스트 붙여넣기)으로 폴백한다.
export function uploadFiles(sessionId: string, paths: string[]): boolean {
  if (!current || current.sessionId !== sessionId || paths.length === 0) return false
  current.reveal()
  current.upload(paths)
  return true
}
