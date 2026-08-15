// fs 도메인 IPC 핸들러 (R7). 로컬 세션의 [파일] 탭 — sftp:* 와 같은 계약 형태(sessionId 만 없다).
// 실제 파일시스템 조작이므로 렌더러가 보낸 값은 여기서 형만 확인하고 통과시킨다
// (경로 탈출 방지는 LocalFs.invalidName 이 이름 입력에서 막는다 — 경로 자체는 사용자가 트리에서 고른 것).
import { app, shell } from 'electron'
import { handle } from './handle'
import { list, renameEntry, makeDir, makeDirP, trash, copyEntries, freeName } from '../fs/LocalFs'
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
  // #89: 이름이 `remove` 가 아니라 `trash` 인 이유 — 실제로 휴지통으로 간다. 영구 삭제 경로는
  // 남겨 두지 않는다(있으면 언젠가 실수로 그쪽이 배선된다). 원격 삭제는 sftp:remove 로 따로 간다.
  handle('fs:trash', ({ paths }) =>
    Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p)
      ? trash(paths)
      : badPath
  )
  // #89: 연결 프로그램으로 열기. openPath 는 성공 시 빈 문자열, 실패 시 사유를 준다 — 삼키지 않는다.
  handle('fs:openPath', async ({ path }) => {
    if (typeof path !== 'string' || !path) return badPath
    const message = await shell.openPath(path)
    return message === '' ? { ok: true as const } : { ok: false as const, message }
  })
  // #92: [폴더 열기] — 받은 파일이 어디 갔는지 눈으로 확인시킨다(세션 로그의 sessionlog:reveal 과 같은 결).
  handle('fs:reveal', ({ path }) => {
    if (typeof path !== 'string' || !path) return badPath
    shell.showItemInFolder(path)
    return { ok: true as const }
  })
  // #92: 받는 곳. 설정 항목은 만들지 않았다 — 값이 하나뿐이면 설정이 아니다(필요해지면 UiPrefs 로).
  handle('fs:downloadsDir', () => ({ dir: app.getPath('downloads') }))
  // #92: 덮어쓰기 없이 받기 위한 빈 이름. 조립 규칙은 LocalFs.nthName(순수 함수)에 있다.
  handle('fs:freeName', async ({ dir, name }) =>
    typeof dir === 'string' && dir && typeof name === 'string' && name
      ? { name: await freeName(dir, name) }
      : { name: typeof name === 'string' ? name : '' }
  )
  // 원격(RDP 클립보드)에서 내려온 바이트 저장. 이름·하위경로 검사는 saveBytes 가 한다.
  handle('fs:saveBytes', (req) => saveBytes(req))
  // #90: 경로 구분자를 허용한다 — 여기 오는 값은 사용자가 폼에 적은 전체 경로다(makeDir 과 계약이 다르다).
  handle('fs:mkdirp', ({ path }) => (typeof path === 'string' && path ? makeDirP(path) : badPath))
  handle('fs:copy', ({ paths, destDir }) =>
    Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p) && typeof destDir === 'string' && destDir
      ? copyEntries(paths, destDir)
      : badPath
  )
}
