// 편집기 창(노트) IPC — 창 열기 + 텍스트 읽기/쓰기. sessionId 가 있으면 원격(SFTP), 없으면 로컬.
// 열어도 되는 파일인지(크기·바이너리)는 main 이 판정한다 — 렌더러 말을 믿고 열면 4GB 로그로 창이 멈춘다.
import { type BrowserWindow } from 'electron'
import { handle } from './handle'
import type { SftpService } from '../sftp/SftpService'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { openEditorWindow } from '../editor/EditorWindows'
import { readLocalText, writeLocalText } from '../editor/textIO'

const badPath = { ok: false as const, message: '잘못된 경로입니다.' }

export function registerEditorIpc(
  sftp: SftpService,
  sessions: MainSessionManager,
  getParent: () => BrowserWindow | null
): void {
  handle('editor:open', ({ sessionId, path }) => {
    if (typeof path !== 'string' || !path) return { ok: false }
    // 창 제목에 쓸 서버 이름은 세션 메타에서 꺼낸다 — 로컬 파일은 "로컬".
    const server = sessionId ? (sessions.snapshot().find((s) => s.id === sessionId)?.serverKey ?? '') : '로컬'
    return { ok: openEditorWindow({ sessionId: sessionId ?? null, path, server }, getParent) }
  })

  handle('editor:read', ({ sessionId, path }) => {
    if (typeof path !== 'string' || !path) return badPath
    return sessionId ? sftp.readText(sessionId, path) : readLocalText(path)
  })

  handle('editor:write', ({ sessionId, path, text, eol }) => {
    if (typeof path !== 'string' || !path || typeof text !== 'string') return badPath
    const nl = eol === 'crlf' ? 'crlf' : 'lf'
    return sessionId ? sftp.writeText(sessionId, path, text, nl) : writeLocalText(path, text, nl)
  })
}
