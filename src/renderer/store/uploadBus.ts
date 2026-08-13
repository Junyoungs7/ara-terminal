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

// 업로드를 넘겼으면 true. false 면 호출측이 기존 동작(텍스트 붙여넣기)으로 폴백한다.
export function uploadFiles(sessionId: string, paths: string[]): boolean {
  if (!current || current.sessionId !== sessionId || paths.length === 0) return false
  current.reveal()
  current.upload(paths)
  return true
}
