// 로그 패널 IPC — 세션의 CLI 내역 읽기 + 내려받기.
// 기록 파일(F12)이 있으면 그걸(세션 시작부터 전부), 없으면 링버퍼(최근 화면)를 준다.
// 긴 로그는 뒤에서부터 창 단위로만 오간다 — readSessionLog.ts 주석 참조.
import { dialog } from 'electron'
import { writeFile, copyFile } from 'node:fs/promises'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { SessionLogService } from '../log/SessionLog'
import { bufferToText, readFileWindow } from '../log/readSessionLog'
import { friendly } from '../util/fsError'

// 저장 파일 기본 이름: 세션 이름 그대로 쓰면 경로 구분자가 섞일 수 있어 글자·숫자만 남긴다.
function defaultName(title: string): string {
  const safe = (title || 'session').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 40)
  return `${safe || 'session'}.log`
}

export function registerSessionLogIpc(
  sessions: MainSessionManager,
  getLog: () => SessionLogService | null
): void {
  handle('sessionlog:read', ({ sessionId, before }) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false as const, message: '세션이 없습니다.' }
    const path = getLog()?.pathOf(sessionId)
    if (path) return readFileWindow(path, typeof before === 'number' ? before : undefined)
    // 기록이 꺼져 있으면 화면 버퍼가 전부다 — 창 나누기도 필요 없다(이미 상한이 있다).
    if (!sessions.has(sessionId)) return { ok: false as const, message: '세션이 없습니다.' }
    const text = bufferToText(sessions.peek(sessionId))
    return { ok: true as const, text, source: 'buffer' as const, start: 0, size: Buffer.byteLength(text, 'utf8') }
  })

  // #86: 지난 세션 목록. 파일 이름이 곧 색인이라(날짜-시각_서버_id8) 폴더를 읽으면 끝난다.
  handle('sessionlog:list', () => ({ list: getLog()?.listPast() ?? [] }))

  // #86: 지난 기록 읽기. sessionId 가 아니라 **파일 이름**으로 찾는다(그 세션은 이미 없다).
  // 이름 검증·경로 확정은 pathOfFile 이 한다 — 렌더러가 보낸 값이라 신뢰 경계다.
  handle('sessionlog:readFile', ({ file, before }) => {
    const path = typeof file === 'string' ? getLog()?.pathOfFile(file) : null
    if (!path) return { ok: false as const, message: '기록을 찾을 수 없습니다.' }
    return readFileWindow(path, typeof before === 'number' ? before : undefined)
  })

  handle('sessionlog:save', async ({ sessionId }) => {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false as const, message: '세션이 없습니다.' }
    const title = sessions.snapshot().find((s) => s.id === sessionId)?.title ?? 'session'
    const res = await dialog.showSaveDialog({ defaultPath: defaultName(title) })
    if (res.canceled || !res.filePath) return { ok: false as const, message: '취소했습니다.', canceled: true }
    try {
      const path = getLog()?.pathOf(sessionId)
      // 창이 아니라 **전체**를 저장한다. 파일이 있으면 통째로 복사(20MB 상한은 기록 쪽이 이미 건다).
      if (path) await copyFile(path, res.filePath)
      else await writeFile(res.filePath, bufferToText(sessions.peek(sessionId)), 'utf8')
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, message: friendly(e as NodeJS.ErrnoException) }
    }
  })
}
