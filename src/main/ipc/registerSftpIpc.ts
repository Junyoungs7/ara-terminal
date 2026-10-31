// sftp 도메인 IPC 핸들러 (계획서 §C F7). 활성 SSH 세션의 커넥션에서 sftp 재사용(새 연결 금지).
// list/download/upload/cancel + sftp:progress:{transferId} 이벤트. 저장/업로드 파일 선택은 dialog.
import { dialog, type WebContents } from 'electron'
import { basename } from 'node:path'
import { handle } from './handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { SftpService } from '../sftp/SftpService'
import { pushSend } from '../util/windowPush'
import { dialogDefaultPath, pickedDir, type LastDir } from '../util/dialogDir'

// F23: 반환값(service)을 MCP sftp_* 툴이 같은 인스턴스로 재사용한다(세 번째 호출자 — F16 패턴).
export function registerSftpIpc(
  sessions: MainSessionManager,
  getWebContents: () => WebContents | null,
  // 2026-10-28: 본창이 아닌 창(탐색기 독립 창)도 전송을 건다 — 진행률은 그 창에도 가야 한다.
  // 채널이 전송 id 별이라 안 건 창은 듣지 않는다(telemetry 의 alsoTo 와 같은 방식).
  alsoTo: () => WebContents[] = () => [],
  // ME-1 E4: 대화상자 마지막 폴더(Electron 43 은 기억하지 않는다).
  lastDir: LastDir = { get: () => undefined, set: () => {} }
): SftpService {
  const service = new SftpService(
    (sessionId) => sessions.sshClient(sessionId),
    (p) => {
      const owner = getWebContents()
      pushSend(owner, `sftp:progress:${p.transferId}`, p)
      for (const wc of alsoTo()) if (wc !== owner) pushSend(wc, `sftp:progress:${p.transferId}`, p)
    }
  )

  handle('sftp:list', ({ sessionId, path }) => service.list(sessionId, path))
  // R7 원격 파일 조작(로컬 fs:* 와 같은 형태). 삭제는 opId 로 취소 가능(sftp:cancel).
  handle('sftp:rename', ({ sessionId, path, name }) => service.rename(sessionId, path, name))
  handle('sftp:mkdir', ({ sessionId, dir, name }) => service.mkdir(sessionId, dir, name))
  handle('sftp:newFile', ({ sessionId, dir, name }) => service.makeFile(sessionId, dir, name))
  handle('sftp:remove', ({ sessionId, opId, paths }) => service.remove(sessionId, opId, paths))
  handle('sftp:copyRemote', ({ sessionId, paths, destDir }) =>
    Array.isArray(paths) && paths.every((p) => typeof p === 'string' && p) && typeof destDir === 'string' && destDir
      ? service.copyRemote(sessionId, paths, destDir)
      : { ok: false as const, message: '잘못된 경로입니다.' }
  )
  handle('sftp:download', ({ sessionId, transferId, remotePath, localPath, size }) =>
    service.download(sessionId, transferId, remotePath, localPath, size)
  )
  // R15 폴더째 받기. 경로 검사(절대경로만)는 서비스가 한다 — 시험이 거기서 문다.
  handle('sftp:downloadDir', ({ sessionId, transferId, remotePath, localDir, confirmed }) =>
    service.downloadDir(sessionId, transferId, remotePath, localDir, confirmed === true)
  )
  handle('sftp:upload', ({ sessionId, transferId, localPath, remoteDir }) =>
    service.upload(sessionId, transferId, localPath, remoteDir)
  )
  handle('sftp:copyBetween', ({ srcSessionId, destSessionId, transferId, remotePath, destDir, size }) =>
    service.copyBetween(srcSessionId, destSessionId, transferId, remotePath, destDir, size)
  )
  handle('sftp:cancel', ({ transferId }) => {
    service.cancel(transferId)
    return { ok: true } as const
  })

  // 다운로드 저장 위치 선택(save dialog). 취소 시 null.
  handle('sftp:pickSavePath', async ({ defaultName }) => {
    const res = await dialog.showSaveDialog({ defaultPath: dialogDefaultPath(lastDir.get(), basename(defaultName)) })
    const path = res.canceled || !res.filePath ? null : res.filePath
    const dir = pickedDir(path ?? undefined, false)
    if (dir) lastDir.set(dir)
    return { path }
  })
  // 다중 다운로드 저장 폴더 선택(파일마다 대화상자를 띄우지 않는다). 취소 시 null.
  handle('sftp:pickSaveDir', async () => {
    const res = await dialog.showOpenDialog({ defaultPath: dialogDefaultPath(lastDir.get()), properties: ['openDirectory', 'createDirectory'] })
    const path = res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    if (path) lastDir.set(path)
    return { path }
  })
  // 업로드 파일 선택(드래그 불가 환경 폴백). 취소 시 빈 배열. dir: 폴더 고르기(신고 #18/#19).
  handle('sftp:pickUploadPaths', async (req) => {
    const res = await dialog.showOpenDialog({
      defaultPath: dialogDefaultPath(lastDir.get()),
      properties: [req?.dir ? 'openDirectory' : 'openFile', 'multiSelections']
    })
    const paths = res.canceled ? [] : res.filePaths
    // 여러 개를 골랐어도 한 폴더 안이다 — 폴더를 골랐으면 그 부모가 "고르던 자리"다.
    const dir = pickedDir(paths[0], false)
    if (dir) lastDir.set(dir)
    return { paths }
  })

  return service
}
