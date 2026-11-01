// M12 CV-02 PDF·이미지·오디오/비디오 뷰어 — 순수 규칙(main 읽기·렌더러 탭·단위 시험이 같이 읽는다).
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/shared/media-file-extensions.ts·src/renderer/src/components/editor/MediaViewer.tsx —
// 확장자로 종류를 정하고, 그 종류면 글 에디터가 아니라 뷰어 탭으로 연다.

export type MediaKind = 'image' | 'pdf' | 'audio' | 'video'

const MIME: Record<string, [MediaKind, string]> = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  bmp: ['image', 'image/bmp'],
  ico: ['image', 'image/x-icon'],
  svg: ['image', 'image/svg+xml'],
  avif: ['image', 'image/avif'],
  pdf: ['pdf', 'application/pdf'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  flac: ['audio', 'audio/flac'],
  opus: ['audio', 'audio/ogg'],
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'],
  mov: ['video', 'video/quicktime']
}

/** 경로 → 뷰어 종류와 MIME. 뷰어로 못 여는 파일이면 null(글 에디터로). */
export function mediaOf(path: string): { kind: MediaKind; mime: string } | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const hit = MIME[name.slice(dot + 1).toLowerCase()]
  return hit ? { kind: hit[0], mime: hit[1] } : null
}

/**
 * 뷰어가 한 번에 읽는 상한. ponytail: 통째로 IPC 로 넘겨 Blob URL 로 띄운다(Orca 는 orca-media: 프로토콜로 Range 스트리밍).
 * 큰 동영상을 자주 보게 되면 Range 프로토콜로 — 그전까지 넘는 파일은 [기본 앱으로 열기]로.
 */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 50 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 200 * 1024 * 1024
}

export type BytesResult = { ok: true; data: Uint8Array } | { ok: false; message: string; tooBig?: boolean; size?: number }
