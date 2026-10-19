// W4sat F20: 탐색기 2패널 간 복사/이동 계획 조립(순수 함수) — 로컬↔로컬·로컬↔원격 경로 조립,
// 원격↔원격은 스펙 범위 밖(unsupported)임을 확인한다. 실제 IPC 호출은 하지 않는다.
import { describe, it, expect } from 'vitest'
import { planCrossPanelTransfer, type PanelLoc } from '../src/renderer/store/explorerTransfer'
import type { FileEntry } from '../src/shared/ipc'

const file = (name: string, size = 100): FileEntry => ({ name, type: 'file', size, mtime: 0 })
const dir = (name: string): FileEntry => ({ name, type: 'dir', size: 0, mtime: 0 })

// FileTree 계약상 session:null 은 "백엔드 없음"(플레이스홀더)이지 로컬을 뜻하지 않는다 — 탐색기 패널은
// 로컬도 항상 { id, type: 'local' } 로 채워 넘긴다(ExplorerView.LOCAL_SESSION 과 같은 모양).
const local = (path: string): PanelLoc => ({ session: { id: 'local', type: 'local' }, path })
const remote = (id: string, path: string): PanelLoc => ({ session: { id, type: 'ssh' }, path })

describe('planCrossPanelTransfer — 로컬↔로컬', () => {
  it('두 패널 다 로컬이면 절대경로 목록 + 목적지 디렉토리를 조립한다', () => {
    const plan = planCrossPanelTransfer(local('C:\\src'), local('D:\\dest'), [file('a.txt'), dir('sub')], 'copy')
    expect(plan).toEqual({ kind: 'local', mode: 'copy', paths: ['C:\\src\\a.txt', 'C:\\src\\sub'], destDir: 'D:\\dest' })
  })

  it('mode=move 도 그대로 실린다(실행은 호출측이 copy 성공 후 remove)', () => {
    const plan = planCrossPanelTransfer(local('/src'), local('/dest'), [file('a.txt')], 'move')
    expect(plan).toEqual({ kind: 'local', mode: 'move', paths: ['/src/a.txt'], destDir: '/dest' })
  })
})

describe('planCrossPanelTransfer — 로컬↔원격', () => {
  it('로컬 → 원격: sessionId·로컬경로·원격 목적 디렉토리를 조립한다(sftp:upload 그대로 재사용)', () => {
    const plan = planCrossPanelTransfer(local('/home/u'), remote('s1', '/srv/app'), [file('a.txt'), file('b.log')], 'copy')
    expect(plan).toEqual({
      kind: 'localToRemote',
      mode: 'copy',
      sessionId: 's1',
      files: [
        { localPath: '/home/u/a.txt', name: 'a.txt' },
        { localPath: '/home/u/b.log', name: 'b.log' }
      ],
      remoteDir: '/srv/app'
    })
  })

  // 방향 규칙(2026-08-09): 우리 → 원격은 붙여넣기, 원격 → 우리는 다운로드. 어떤 건 되고 어떤 건
  // 안 되는 상태를 없애려고 정한 것이라, 기술적으로 가능해도 여기서 막고 안내로 보낸다.
  it('★ 원격 → 로컬은 붙여넣기로 받지 않는다 — 우클릭 [다운로드]로 안내한다', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/srv/app'), local('/home/u/dl'), [file('a.txt', 2048)], 'copy')
    expect(plan).toEqual({ kind: 'unsupported', reason: 'useDownload' })
  })

  it('이동(move)이어도 마찬가지다 — 방향이 규칙을 정한다', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/a'), local('/b'), [file('x')], 'move')
    expect(plan).toEqual({ kind: 'unsupported', reason: 'useDownload' })
  })
})

// 서버 A → 서버 B (2026-08-08). 데이터는 우리를 거치지만 디스크 임시 파일은 없다 — main 이 두
// SFTP 스트림을 직접 잇는다. 계획이 두 세션 id 를 정확히 갈라 담아야 반대 방향으로 흐르지 않는다.
describe('planCrossPanelTransfer — 원격↔원격(다른 서버)', () => {
  it('출발·도착 세션을 구분해 담고 경로를 조립한다', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/srv/app'), remote('s2', '/backup'), [file('a.log', 512)], 'copy')
    expect(plan).toEqual({
      kind: 'remoteToRemote',
      mode: 'copy',
      srcSessionId: 's1',
      destSessionId: 's2',
      files: [{ remotePath: '/srv/app/a.log', name: 'a.log', size: 512 }],
      destDir: '/backup'
    })
  })

  it('폴더는 걸러 낸다 — 스트림 하나가 파일 하나다(업로드·다운로드와 같은 제약)', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/a'), remote('s2', '/b'), [file('x.txt'), dir('sub')], 'copy')
    if (plan.kind !== 'remoteToRemote') throw new Error('remoteToRemote 여야 한다')
    expect(plan.files.map((f) => f.name)).toEqual(['x.txt'])
  })

  it('폴더만 골랐으면 files 가 비어 호출측이 안내로 분기한다(조용히 성공하지 않는다)', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/a'), remote('s2', '/b'), [dir('sub')], 'copy')
    if (plan.kind !== 'remoteToRemote') throw new Error('remoteToRemote 여야 한다')
    expect(plan.files).toEqual([])
  })

  it('mode 는 그대로 전달된다(이동은 호출측이 성공 후 원본을 지운다)', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/a'), remote('s2', '/b'), [file('x')], 'move')
    if (plan.kind !== 'remoteToRemote') throw new Error('remoteToRemote 여야 한다')
    expect(plan.mode).toBe('move')
  })
})

// 서버↔서버는 폴더를 스트림으로 못 옮긴다(파일 하나 = 스트림 하나) — planner 가 걸러 호출측이 안내하게 한다.
// 로컬→원격은 업로드가 폴더를 통째로 올리므로(SftpService.upload, #18 #19) 거르지 않는다.
describe('planCrossPanelTransfer — 폴더 거르기', () => {
  it('로컬→원격 업로드는 폴더도 넘긴다 — 업로드가 폴더를 통째로 올린다(#18 #19)', () => {
    const plan = planCrossPanelTransfer(local('/a'), remote('s1', '/b'), [file('x.txt'), dir('sub')], 'copy')
    if (plan.kind !== 'localToRemote') throw new Error('localToRemote 여야 한다')
    expect(plan.files.map((f) => f.name)).toEqual(['x.txt', 'sub'])
  })
  it('로컬↔로컬은 폴더를 그대로 둔다 — fs.copy 가 재귀 복사한다', () => {
    const plan = planCrossPanelTransfer(local('/a'), local('/b'), [file('x.txt'), dir('sub')], 'copy')
    if (plan.kind !== 'local') throw new Error('local 이어야 한다')
    expect(plan.paths).toHaveLength(2)
  })
})

describe('planCrossPanelTransfer — 지원 범위 밖', () => {
  it('같은 서버끼리는 sameRemote — 여기 오면 배선 실수다(exec cp 로 가야 한다)', () => {
    const plan = planCrossPanelTransfer(remote('s1', '/a'), remote('s1', '/b'), [file('x')], 'move')
    expect(plan).toEqual({ kind: 'unsupported', reason: 'sameRemote' })
  })

  it('선택 항목이 없으면 unsupported', () => {
    const plan = planCrossPanelTransfer(local('/a'), local('/b'), [], 'copy')
    expect(plan).toEqual({ kind: 'unsupported', reason: 'noTargets' })
  })
})
