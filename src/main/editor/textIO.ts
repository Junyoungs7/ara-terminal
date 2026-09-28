// 편집기 창이 쓰는 파일 읽기·쓰기. 로컬(fs)과 원격(SFTP)을 한 곳에서 갈라 준다 —
// 크기 상한·바이너리 거부·줄바꿈 보존 같은 "열어도 되는가" 규칙이 두 경로에서 어긋나면 안 된다.
import { readFile, writeFile, stat } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import type { EditorReadResult, FileOpResult } from '@shared/ipc'
import { EDIT_MAX_BYTES, looksBinary } from '@shared/textFile'
import { friendly } from '../util/fsError'

// 바이트 → 편집기 결과. 규칙 판정은 여기 한 곳에서만 한다.
export function toEditorText(bytes: Buffer, remote = false): EditorReadResult {
  if (bytes.length > EDIT_MAX_BYTES) return { ok: false, message: tooBig(bytes.length, remote) }
  if (looksBinary(bytes)) return { ok: false, message: '텍스트 파일이 아닙니다(바이너리로 보입니다).' }
  const text = bytes.toString('utf8')
  // 원본이 CRLF 면 저장할 때 되돌린다 — 안 그러면 줄바꿈만 바뀐 커밋이 파일 전체 diff 로 잡힌다.
  const eol = text.includes('\r\n') ? 'crlf' : 'lf'
  return { ok: true, text: eol === 'crlf' ? text.replace(/\r\n/g, '\n') : text, eol, bytes: bytes.length }
}

export function fromEditorText(text: string, eol: 'lf' | 'crlf'): Buffer {
  return Buffer.from(eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text, 'utf8')
}

// 권하는 다음 걸음은 **그 자리에 실제로 있는 메뉴**여야 한다(#201 F). 로컬 파일 우클릭엔 [서버 로그 보기]가
// 없는데(원격 tail 전용) 전에는 로컬에도 "tail 로 보기를 쓰세요"라고 했다. 로컬엔 [연결 프로그램으로 열기]가 있다.
export function tooBig(bytes: number, remote: boolean): string {
  const mb = (EDIT_MAX_BYTES / 1024 / 1024).toFixed(0)
  const next = remote ? '[서버 로그 보기]를 쓰세요' : '[연결 프로그램으로 열기]를 쓰세요'
  return `편집기로 열기엔 너무 큽니다(${(bytes / 1024 / 1024).toFixed(1)}MB · 상한 ${mb}MB). ${next}.`
}

export async function readLocalText(path: string): Promise<EditorReadResult> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return { ok: false, message: '파일이 아닙니다.' }
    if (s.size > EDIT_MAX_BYTES) return { ok: false, message: tooBig(s.size, false) }
    return toEditorText(await readFile(path))
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

export async function writeLocalText(path: string, text: string, eol: 'lf' | 'crlf'): Promise<FileOpResult> {
  try {
    await writeFile(path, fromEditorText(text, eol))
    return { ok: true }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}

// ── 원격(SFTP) ──
// 스트림 대신 sftp.readFile/writeFile 을 쓴다: 상한이 2MB 라 한 번에 들고 있어도 되고,
// 진행률 UI 도 필요 없다(전송 큐는 다운·업로드 전용).
export function readRemoteText(sftp: SFTPWrapper, path: string): Promise<EditorReadResult> {
  return new Promise((resolve) => {
    sftp.stat(path, (statErr, st) => {
      if (statErr) return resolve({ ok: false, message: friendly(statErr as NodeJS.ErrnoException) })
      if (st && !st.isFile()) return resolve({ ok: false, message: '파일이 아닙니다.' })
      if (st && st.size > EDIT_MAX_BYTES) return resolve({ ok: false, message: tooBig(st.size, true) })
      sftp.readFile(path, (err, buf) => {
        if (err) return resolve({ ok: false, message: friendly(err as NodeJS.ErrnoException) })
        resolve(toEditorText(buf, true))
      })
    })
  })
}

export function writeRemoteText(
  sftp: SFTPWrapper,
  path: string,
  text: string,
  eol: 'lf' | 'crlf'
): Promise<FileOpResult> {
  return new Promise((resolve) => {
    sftp.writeFile(path, fromEditorText(text, eol), (err) =>
      resolve(err ? { ok: false, message: friendly(err as NodeJS.ErrnoException) } : { ok: true })
    )
  })
}
