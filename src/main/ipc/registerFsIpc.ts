// fs 도메인 IPC 핸들러 (R7). 로컬 세션의 [파일] 탭 — sftp:* 와 같은 계약 형태(sessionId 만 없다).
// 실제 파일시스템 조작이므로 렌더러가 보낸 값은 여기서 형만 확인하고 통과시킨다
// (경로 탈출 방지는 LocalFs.invalidName 이 이름 입력에서 막는다 — 경로 자체는 사용자가 트리에서 고른 것).
import { handle } from './handle'
import { list, renameEntry, makeDir, remove, copyEntries } from '../fs/LocalFs'
import { saveBytes } from '../fs/saveBytes'

const badPath = { ok: false as const, message: '잘못된 경로입니다.' }

export function registerFsIpc(): void {
  handle('fs:list', ({ path }) =>
    typeof path === 'string' ? list(path) : Promise.resolve({ ok: false as const, message: badPath.message })
  )
  handle('fs:rename', ({ path, name }) =>
    typeof path === 'string' && path ? renameEntry(path, name) : badPath
  )
  handle('fs:mkdir', ({ dir, name }) => (typeof dir === 'string' && dir ? makeDir(dir, name) : badPath))
  handle('fs:remove', ({ paths }) =>
    Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p)
      ? remove(paths)
      : badPath
  )
  // 원격(RDP 클립보드)에서 내려온 바이트 저장. 이름·하위경로 검사는 saveBytes 가 한다.
  handle('fs:saveBytes', (req) => saveBytes(req))
  handle('fs:copy', ({ paths, destDir }) =>
    Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p) && typeof destDir === 'string' && destDir
      ? copyEntries(paths, destDir)
      : badPath
  )
}
