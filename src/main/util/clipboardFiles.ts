// F14: 클립보드에 담긴 "파일" 을 로컬 경로 목록으로 읽는다(텍스트 붙여넣기와 구분하기 위한 판별).
// 플랫폼마다 담기는 형식이 다르다:
//   Windows — 탐색기 복사는 CF_HDROP 이지만 Electron 이 이름으로 노출하는 것은 'FileNameW'
//             (UTF-16LE, NUL 종료, 경로 한 개)다. CF_HDROP 은 번호 형식이라 readBuffer 로 못 집는다.
//   macOS   — 'NSFilenamesPboardType' 에 plist XML 로 여러 경로가 들어온다.
// ponytail: Windows 다중 선택은 첫 파일 하나만 잡힌다(FileNameW 의 한계). 여러 개가 필요해지면
// CF_HDROP 을 읽는 네이티브 애드온이 필요하다 — 그 값이 확인되기 전에는 만들지 않는다.
import { statSync } from 'node:fs'

// Electron clipboard 의 최소 표면(테스트에서 가짜를 끼울 수 있게 좁게 잡는다).
export type ClipboardReader = {
  availableFormats(): string[]
  readBuffer(format: string): Buffer
  read(format: string): string
}

export const WIN_FORMAT = 'FileNameW'
export const MAC_FORMAT = 'NSFilenamesPboardType'

// UTF-16LE + NUL 종료. 빈 버퍼(파일이 아닌 클립보드)는 빈 배열.
export function parseFileNameW(buf: Buffer): string[] {
  if (!buf || buf.length === 0) return []
  const path = buf.toString('utf16le').replace(/\0+$/, '').trim()
  return path ? [path] : []
}

// plist XML 의 <string> 항목들. XML 엔티티만 되돌린다(경로에 & 나 < 가 들어갈 수 있다).
export function parseNSFilenames(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    const p = unescapeXml(m[1]).trim()
    if (p) out.push(p)
  }
  return out
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// 신뢰 경계: 클립보드 문자열을 그대로 업로드 대상으로 넘기지 않는다. 실제로 존재하는 "파일"만
// 통과시킨다 — 디렉토리는 SFTP 업로드가 다루지 못하고, 없는 경로는 전송 큐에서 실패로 끝난다.
export function keepUploadable(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) out.push(p)
    } catch {
      // 존재하지 않거나 접근 불가 — 조용히 제외(클립보드 내용은 오류로 알릴 대상이 아니다).
    }
  }
  return out
}

// 플랫폼 형식 판별 → 파싱 → 실존 파일만. 파일이 없으면 빈 배열(호출측이 텍스트 붙여넣기로 폴백).
export function clipboardFilePaths(cb: ClipboardReader, platform: string = process.platform): string[] {
  let formats: string[]
  try {
    formats = cb.availableFormats()
  } catch {
    return []
  }
  try {
    if (platform === 'darwin') {
      if (!formats.includes(MAC_FORMAT)) return []
      return keepUploadable(parseNSFilenames(cb.read(MAC_FORMAT)))
    }
    if (!formats.includes(WIN_FORMAT)) return []
    return keepUploadable(parseFileNameW(cb.readBuffer(WIN_FORMAT)))
  } catch {
    return []
  }
}
