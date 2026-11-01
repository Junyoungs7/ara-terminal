/**
 * M8 herdr H10 — 클립보드 이미지 → 원격 붙여넣기. 렌더러(크기 확인)와 main(업로드)이 같은 규칙을 쓴다.
 * herdr 방식: 이미지를 원격 임시 폴더에 올리고 **그 경로를 입력에 넣는다**(AI CLI 에게는 경로가 곧 첨부다).
 */

/** 원격 홈 아래 임시 폴더. 세션이 닫히면 올린 파일을 지우고, 못 지운 것(끊김)은 다음 업로드 때 하루 지난 것부터 걷는다. */
export const PASTE_DIR = '.ara-paste'
export const PASTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const PASTE_STALE_MS = 24 * 60 * 60 * 1000

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }

export function pasteImageExt(mime: string): string | null {
  return EXT[mime] ?? null
}

/** `<홈>/.ara-paste/paste-20261101-142233-ab12.png` — 같은 초에 두 장이어도 꼬리가 갈라 준다. */
export function remotePastePath(home: string, mime: string, now: Date, tail: string): string | null {
  const ext = pasteImageExt(mime)
  if (!ext) return null
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
  return `${home.replace(/\/+$/, '')}/${PASTE_DIR}/paste-${stamp}-${tail}.${ext}`
}

/** 하루 지난 것만(mtime 은 SFTP 관례대로 초). 우리 이름 꼴(paste-*)만 건드린다. */
export function stalePasteNames(entries: readonly { filename: string; mtime: number }[], nowMs: number): string[] {
  return entries.filter((e) => /^paste-.+\.\w+$/.test(e.filename) && nowMs - e.mtime * 1000 > PASTE_STALE_MS).map((e) => e.filename)
}
