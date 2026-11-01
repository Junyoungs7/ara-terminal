// M6 WS-07·08 — 코드 에디터 파일 읽기·쓰기(로컬만 — 원격 워크트리는 M8). 규칙은 @shared/codeFiles(순수), 여기는 디스크만.
// 서명 = 디스크 바이트의 sha1. 렌더러는 읽을 때 받은 서명을 들고 있다가 저장 때 돌려준다(main 은 상태를 안 든다).
import { createHash } from 'node:crypto'
import { open, readFile, writeFile } from 'node:fs/promises'
import { looksBinary } from '@shared/textFile'
import { CODE_READONLY_BYTES, decideWrite, type CodeReadResult, type CodeWriteResult } from '@shared/codeFiles'
import { fromEditorText } from '../editor/textIO'
import { friendly } from '../util/fsError'

export const sigOf = (b: Buffer): string => createHash('sha1').update(b).digest('hex')
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

export async function readCode(path: string): Promise<CodeReadResult> {
  try {
    const fh = await open(path, 'r')
    try {
      const st = await fh.stat()
      if (!st.isFile()) return { ok: false, message: '파일이 아닙니다.' }
      // 상한을 넘으면 앞부분만 — 읽기 전용으로 연다(잘린 내용을 저장하면 뒷부분이 날아간다).
      const len = Math.min(st.size, CODE_READONLY_BYTES)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, 0)
      return codeOf(buf, st.size)
    } finally {
      await fh.close()
    }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException), ...(isMissing(e) ? { missing: true } : {}) }
  }
}

/** 읽은 앞부분(buf, 최대 CODE_READONLY_BYTES) + 파일 크기 → 결과. M8 R5 원격(SFTP)도 이것을 쓴다. */
export function codeOf(buf: Buffer, size: number): CodeReadResult {
  if (looksBinary(buf)) return { ok: false, message: '텍스트 파일이 아닙니다(바이너리로 보입니다).' }
  const raw = buf.toString('utf8')
  // 원본이 CRLF 면 저장할 때 되돌린다(editor/textIO 와 같은 규칙 — 줄바꿈만 바뀐 diff 를 안 만든다).
  const eol = raw.includes('\r\n') ? 'crlf' : 'lf'
  return { ok: true, text: eol === 'crlf' ? raw.replace(/\r\n/g, '\n') : raw, eol, bytes: size, sig: sigOf(buf), readOnly: size > CODE_READONLY_BYTES }
}

/** 저장의 디스크 쪽 — 지금 바이트(없으면 null) · 쓰기. 로컬 fs 와 M8 R5 원격 SFTP 가 같은 판정(서명 비교)을 탄다. */
export type CodeDisk = { read: () => Promise<Buffer | null>; write: (bytes: Buffer) => Promise<void> }
const LOCAL_DISK = (path: string): CodeDisk => ({
  read: () => readFile(path).catch((e) => (isMissing(e) ? null : Promise.reject(e))),
  write: (b) => writeFile(path, b)
})

/**
 * 저장(WS-08). force 가 아니면 디스크를 다시 읽어 baseSig 와 맞는지 본다 — 다르면 쓰지 않고 conflict 를 돌려준다(렌더러가 묻는다).
 * ponytail: 읽고 쓰는 사이에 다른 프로세스가 끼어드는 틈은 남는다(Orca 도 같다 — 같은 앱 안의 저장끼리만 경로 잠금으로 줄 세움). 여기선 저장 주체가 탭 하나라 잠금은 뺐다.
 */
export async function writeCode(path: string, text: string, eol: 'lf' | 'crlf', baseSig: string, force = false, disk: CodeDisk = LOCAL_DISK(path)): Promise<CodeWriteResult> {
  const bytes = fromEditorText(text, eol)
  const sig = sigOf(bytes)
  try {
    if (!force) {
      const now = await disk.read()
      const d = decideWrite(now ? sigOf(now) : null, baseSig, sig)
      if (d === 'unchanged') return { ok: true, sig }
      if (d !== 'write') return { ok: false, conflict: d }
    }
    await disk.write(bytes)
    return { ok: true, sig }
  } catch (e) {
    return { ok: false, message: friendly(e as NodeJS.ErrnoException) }
  }
}
