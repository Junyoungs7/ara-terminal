// R15(오류 신고 #3) 폴더째 받기 · 설정 [다운로드 폴더].
//
// 폴더 받기는 **실제 SFTP 프로토콜**로 잰다(ssh2 하네스 — 실서버 없음). 가짜 객체로는 readdir 의 attrs 가
// lstat 이라는 사실(링크를 안 따라가는 판정의 근거)을 확인할 수 없다.
//
// ⚠️ 못 재는 것: 원격에만 있는 이름(`a:b.txt`, `CON`, 대소문자만 다른 두 파일)은 **이 PC 가 Windows 라
//    하네스 원격 폴더에 만들 수가 없다** — 그 변환은 localName 단위 시험이 대신한다. 실제 리눅스 서버에서의
//    확인은 실기 항목이다.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connectSsh, SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { SftpService, DIR_CONFIRM_FILES } from '../src/main/sftp/SftpService'
import { localName, downloadTarget } from '../src/main/fs/LocalFs'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'
import type { SftpProgress } from '../src/shared/ipc'

let harness: Harness | null = null
let backend: SshBackend | null = null
let remoteRoot = ''
let localDir = ''

async function connect(port: number): Promise<SshBackend> {
  const profile: SshProfile = {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
  const res = await connectSsh(profile, {
    knownHosts: {},
    secret: harness!.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  return res.backend
}

function service(progress: SftpProgress[] = []): SftpService {
  const client = backend!.sshClient()
  return new SftpService((sid) => (sid === 'sid' ? client : null), (p) => progress.push(p))
}

describe('R15 폴더째 받기 (ssh2 하네스)', () => {
  beforeEach(async () => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'ev-sftpdir-remote-'))
    localDir = mkdtempSync(join(tmpdir(), 'ev-sftpdir-local-'))
    mkdirSync(join(remoteRoot, '배포', '설정', '깊은곳'), { recursive: true })
    mkdirSync(join(remoteRoot, '배포', '빈폴더'))
    writeFileSync(join(remoteRoot, '배포', 'run.sh'), '#!/bin/sh\necho 배포\n')
    writeFileSync(join(remoteRoot, '배포', '설정', 'app.yml'), 'port: 8080\n')
    writeFileSync(join(remoteRoot, '배포', '설정', '깊은곳', '비밀.txt'), '깊다')
    harness = await startPasswordServer({ sftpRoot: remoteRoot })
    backend = await connect(harness.port)
  })

  afterEach(async () => {
    backend?.kill()
    backend = null
    if (harness) await harness.close()
    harness = null
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(localDir, { recursive: true, force: true })
  })

  it('하위 구조째 받는다 — 빈 폴더·빈 파일까지, 내용 그대로, 진행률에 파일 수가 온다', async () => {
    // 0바이트 파일은 pump 의 "바이트 수 도달" 신호가 없다 — 'end' 로 끝나야 한다(굳으면 여기서 멎는다).
    writeFileSync(join(remoteRoot, '배포', '빈.txt'), '')
    const progress: SftpProgress[] = []
    const r = await service(progress).downloadDir('sid', 'd1', '/배포', localDir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.localPath).toBe(join(localDir, '배포'))
    expect(r.files).toBe(4)
    expect(r.skipped).toBe(0)
    expect(readFileSync(join(localDir, '배포', '빈.txt'), 'utf8')).toBe('')
    expect(readFileSync(join(localDir, '배포', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho 배포\n')
    expect(readFileSync(join(localDir, '배포', '설정', 'app.yml'), 'utf8')).toBe('port: 8080\n')
    expect(readFileSync(join(localDir, '배포', '설정', '깊은곳', '비밀.txt'), 'utf8')).toBe('깊다')
    expect(existsSync(join(localDir, '배포', '빈폴더'))).toBe(true)
    const last = progress[progress.length - 1]
    expect(last).toMatchObject({ transferId: 'd1', files: 4, fileTotal: 4 })
    expect(last.transferred).toBe(last.total)
  })

  it('🔴 같은 이름 폴더가 있으면 **새 이름**으로 — 있는 폴더에 섞지 않는다', async () => {
    mkdirSync(join(localDir, '배포'))
    writeFileSync(join(localDir, '배포', 'run.sh'), '내 파일')
    const r = await service().downloadDir('sid', 'd2', '/배포', localDir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.localPath).toBe(join(localDir, '배포 (2)'))
    expect(readFileSync(join(localDir, '배포', 'run.sh'), 'utf8')).toBe('내 파일') // 원래 것은 그대로
    expect(readdirSync(join(localDir, '배포'))).toEqual(['run.sh']) // 섞이지 않았다
    expect(existsSync(join(localDir, '배포 (2)', '설정', 'app.yml'))).toBe(true)
  })

  it('🔴 심볼릭 링크는 따라가지 않는다 — 자기 부모를 가리키는 링크로 루프를 만들어도 끝난다', async () => {
    // Windows 는 폴더 링크를 junction 으로 권한 없이 만들 수 있다(sftp.test 의 링크 시험과 같은 방식).
    symlinkSync(join(remoteRoot, '배포'), join(remoteRoot, '배포', '설정', '루프'), 'junction')
    const r = await service().downloadDir('sid', 'd3', '/배포', localDir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.links).toBe(1)
    expect(r.files).toBe(3)
    expect(existsSync(join(localDir, '배포', '설정', '루프'))).toBe(false)
  })

  it('권한 없는 파일 하나 때문에 멈추지 않는다 — 건너뛰고 이름을 돌려준다', async () => {
    writeFileSync(join(remoteRoot, '배포', 'noread.key'), 'x')
    const r = await service().downloadDir('sid', 'd4', '/배포', localDir)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files).toBe(3) // 나머지는 다 받았다
    expect(r.skipped).toBe(1)
    expect(r.skippedNames).toEqual(['noread.key'])
    expect(existsSync(join(localDir, '배포', 'noread.key'))).toBe(false) // 반쪽 파일을 남기지 않는다
  })

  it('🔴 크면 **쓰기 전에** 확인을 요구한다 — 아무것도 만들지 않은 채로', async () => {
    const big = join(remoteRoot, '큰폴더')
    mkdirSync(big)
    for (let i = 0; i <= DIR_CONFIRM_FILES; i++) writeFileSync(join(big, `f${i}`), '')
    const svc = service()
    const r = await svc.downloadDir('sid', 'd5', '/큰폴더', localDir)
    expect(r).toEqual({ ok: false, confirm: { files: DIR_CONFIRM_FILES + 1, bytes: 0 } })
    expect(readdirSync(localDir)).toEqual([]) // 아무것도 안 만들었다
  }, 60_000)

  it('취소하면 만들던 폴더를 통째로 치운다(C-4 폴더판)', async () => {
    writeFileSync(join(remoteRoot, '배포', 'big.log'), Buffer.alloc(4 * 1024 * 1024, 0x41))
    // 첫 진행 이벤트에서 끊는다 — 진행 중인 fastGet 이 채널 종료로 끊겨야 한다.
    const client = backend!.sshClient()
    let fired = false
    const svc: SftpService = new SftpService(
      (sid) => (sid === 'sid' ? client : null),
      () => {
        if (!fired) {
          fired = true
          svc.cancel('d6')
        }
      }
    )
    const r = await svc.downloadDir('sid', 'd6', '/배포', localDir)
    expect(r.ok).toBe(false)
    if (r.ok || 'confirm' in r) return
    expect(r.canceled).toBe(true)
    expect(r.cleaned).toBe(true)
    expect(readdirSync(localDir)).toEqual([])
  })

  it('받는 자리가 절대경로가 아니면 거절한다(렌더러 값은 신뢰 경계 밖)', async () => {
    const r = await service().downloadDir('sid', 'd7', '/배포', 'relative\\dir')
    expect(r).toMatchObject({ ok: false, message: '잘못된 경로입니다.' })
  })
})

describe('localName — 원격 이름을 이 PC 에서 쓸 수 있게', () => {
  it('Windows 가 못 쓰는 글자는 _ 로', () => {
    expect(localName('a:b*c?.txt')).toBe('a_b_c_.txt')
    expect(localName('x<y>|"z')).toBe('x_y___z')
    expect(localName('tab\there')).toBe('tab_here')
  })
  it('예약 장치명은 앞에 _ (확장자가 붙어도)', () => {
    expect(localName('CON')).toBe('_CON')
    expect(localName('nul.txt')).toBe('_nul.txt')
    expect(localName('console.log')).toBe('console.log') // 예약명이 아니다
  })
  it('🔴 끝의 점·공백은 _ 로 — Windows 가 조용히 떼어 내 다른 파일과 같아진다', () => {
    expect(localName('a.')).toBe('a_')
    expect(localName('b ')).toBe('b_')
    expect(localName('..')).toBe('__')
  })
  it('멀쩡한 이름은 그대로', () => {
    expect(localName('보고서 (2).xlsx')).toBe('보고서 (2).xlsx')
    expect(localName('.env')).toBe('.env')
  })
})

describe('downloadTarget — 설정 [다운로드 폴더]', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ev-dltarget-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('비었으면 OS 다운로드 폴더(지금까지의 동작)', async () => {
    expect(await downloadTarget('', 'C:\\dl')).toEqual({ dir: 'C:\\dl' })
    expect(await downloadTarget(undefined, 'C:\\dl')).toEqual({ dir: 'C:\\dl' })
  })
  it('있는 폴더면 그것', async () => {
    expect(await downloadTarget(dir, 'C:\\dl')).toEqual({ dir })
  })
  it('🔴 사라진 폴더는 **조용히 넘어가지 않는다** — missing 으로 알린다', async () => {
    const gone = join(dir, '뺀USB')
    expect(await downloadTarget(gone, 'C:\\dl')).toEqual({ dir: 'C:\\dl', missing: gone })
  })
  it('상대경로·파일·형이 틀린 값도 missing(신뢰 경계)', async () => {
    writeFileSync(join(dir, 'file'), '')
    expect((await downloadTarget('rel\\dir', 'C:\\dl')).missing).toBe('rel\\dir')
    expect((await downloadTarget(join(dir, 'file'), 'C:\\dl')).missing).toBe(join(dir, 'file'))
    expect(await downloadTarget(42, 'C:\\dl')).toEqual({ dir: 'C:\\dl' })
  })
  it('설정 스냅샷: 없으면 빈 값, 형이 틀리면 빈 값', () => {
    expect(prefsFrom({}).downloadDir).toBe('')
    expect(prefsFrom({ downloadDir: 'D:\\받음' }).downloadDir).toBe('D:\\받음')
    expect(prefsFrom({ downloadDir: 7 as unknown as string }).downloadDir).toBe('')
  })
})
