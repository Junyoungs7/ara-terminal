// M6 WS-07·08 코드 에디터의 순수 규칙 — main(읽기·쓰기)·렌더러(탭·변경 감지)·단위 시험이 같이 읽는다.
// Orca src/shared/file-write-disk-precondition.ts · ExternalFileChangeBanner(orcaRef 7a7f46f8a3)의 1차 판:
// 읽을 때 받은 디스크 서명(baseline)을 들고 있다가, 저장할 때 디스크가 그 서명이 아니면 덮어쓰기 전에 묻는다.

/** 이 크기를 넘으면 앞부분만 읽기 전용으로 연다 — Orca MAX_TEXT_FILE_SIZE(filesystem-file-content-inspection.ts)와 같은 값. */
export const CODE_READONLY_BYTES = 50 * 1024 * 1024

/** path 가 root 안(같거나 아래)인가. 구분자·win32 대소문자를 맞춘다. 상대 경로는 거른다. */
export function isInsidePath(root: string, path: string, platform: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'win32' ? s.toLowerCase() : s
  }
  const r = norm(root)
  const p = norm(path)
  if (!r || !/^([a-zA-Z]:)?\//.test(p) || p.split('/').includes('..')) return false
  return p === r || p.startsWith(r + '/')
}

/** Monaco 가 아는 언어 목록 모양(monaco.languages.getLanguages() 의 필요한 부분). */
export type LanguageInfo = { id: string; extensions?: string[]; filenames?: string[] }

/**
 * 파일 경로 → 언어 id. 표는 따로 두지 않고 Monaco 가 등록한 목록(확장자·파일 이름)을 그대로 쓴다 — 표가 두 벌이면 어긋난다.
 * 파일 이름(Dockerfile 등)이 먼저, 그다음 맞는 확장자 중 가장 긴 것(겹칠 때 구체적인 쪽). 모르면 plaintext.
 */
export function languageOf(path: string, languages: readonly LanguageInfo[]): string {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const byName = languages.find((l) => l.filenames?.some((f) => f.toLowerCase() === name))
  if (byName) return byName.id
  let best: { id: string; len: number } | null = null
  for (const l of languages) {
    for (const ext of l.extensions ?? []) {
      const e = ext.toLowerCase()
      if (name.endsWith(e) && (!best || e.length > best.len)) best = { id: l.id, len: e.length }
    }
  }
  return best?.id ?? 'plaintext'
}

/**
 * 열린 파일이 밖에서 바뀌었다는 알림을 받았을 때 할 일(WS-08). diskSig = 지금 디스크 서명, null = 지워짐.
 *  · 서명이 그대로 → 무시(내가 방금 저장한 것·mtime 만 바뀐 것)
 *  · 지워짐 → 'missing' 안내(내용은 편집기에 남는다)
 *  · 더럽지 않음 → 조용히 다시 읽기
 *  · 더러움 → 충돌 안내(내 것 유지 / 디스크 것 받기 — 비교는 M7)
 */
export function onDiskChange(file: { sig: string; dirty: boolean }, diskSig: string | null): 'ignore' | 'reload' | 'conflict' | 'missing' {
  if (diskSig === null) return 'missing'
  if (diskSig === file.sig) return 'ignore'
  return file.dirty ? 'conflict' : 'reload'
}

/**
 * 저장 직전 판정(Orca compareDiskWritePrecondition). diskSig = 지금 디스크, baseSig = 열었을(마지막으로 저장·다시 읽은) 때,
 * newSig = 쓰려는 내용. 디스크가 이미 쓰려는 것과 같으면 쓰지 않는다('unchanged').
 */
export function decideWrite(diskSig: string | null, baseSig: string, newSig: string): 'write' | 'unchanged' | 'changed' | 'missing' {
  if (diskSig === null) return 'missing'
  if (diskSig === newSig) return 'unchanged'
  return diskSig === baseSig ? 'write' : 'changed'
}

export type CodeReadResult =
  | { ok: true; text: string; eol: 'lf' | 'crlf'; bytes: number; sig: string; readOnly: boolean }
  | { ok: false; message: string; missing?: boolean }

export type CodeWriteResult = { ok: true; sig: string } | { ok: false; conflict: 'changed' | 'missing' } | { ok: false; message: string }

/** 오른쪽 아이콘 바 [탐색기] → AI 작업 공간 탐색기 패널 켜고 끄기(M12 — 창 이벤트, 진입 청크의 RightBar 가 AI 공간 청크를 import 하지 않게). */
export const EXPLORER_TOGGLE_EVENT = 'ara:explorer-toggle'
/** 탐색기 패널이 열렸나 — AI 작업 공간이 알리고 RightBar 가 눌림 표시를 맞춘다. detail = boolean. */
export const EXPLORER_STATE_EVENT = 'ara:explorer-state'
