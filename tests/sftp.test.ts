// SFTP 통합 검증(계획서 §C F7) — ssh2 하네스의 sftp 서브시스템에 실접속해 파이프라인 전체를 실증한다.
// 검증: 커넥션 재사용(새 연결 없음) · 디렉토리 리스팅(폴더 우선·한글 파일명) · 다운로드 · 업로드 ·
//       전송 취소 + 부분 파일 정리(C-4, 축소 불가). 실패는 예외 없이 구조화 결과.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connectSsh } from '../src/main/sessions/ssh/SshBackend'
import { SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { SftpService } from '../src/main/sftp/SftpService'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'
import type { Client } from 'ssh2'
import type { SftpProgress } from '../src/shared/ipc'

let harness: Harness | null = null
let remoteRoot = ''
let localDir = ''
let backend: SshBackend | null = null

function pwProfile(port: number): SshProfile {
  return {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
}

// 하네스 접속 → SshBackend 반환. SFTP는 이 커넥션(client)을 재사용한다.
async function connect(port: number): Promise<SshBackend> {
  const res = await connectSsh(pwProfile(port), {
    knownHosts: {},
    secret: harness!.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  return res.backend
}

// 서비스 팩토리 — 세션 id 'sid' 를 backend 의 ssh client 로 매핑. 진행 이벤트 수집.
function makeService(client: Client, progress: SftpProgress[] = []): SftpService {
  return new SftpService(
    (sid) => (sid === 'sid' ? client : null),
    (p) => progress.push(p)
  )
}

beforeEach(async () => {
  // 원격 루트(임시 디렉토리)에 한글 파일/폴더를 심는다.
  remoteRoot = mkdtempSync(join(tmpdir(), 'ev-sftp-remote-'))
  localDir = mkdtempSync(join(tmpdir(), 'ev-sftp-local-'))
  mkdirSync(join(remoteRoot, '배포스크립트'))
  writeFileSync(join(remoteRoot, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
  writeFileSync(join(remoteRoot, 'README_한글.md'), '# 한글 문서\n서비스 안내\n')
  // 취소 검증용 대용량(~4MB) 파일.
  writeFileSync(join(remoteRoot, 'access_20260731.log'), Buffer.alloc(4 * 1024 * 1024, 0x41))

  harness = await startPasswordServer({ sftpRoot: remoteRoot })
  backend = await connect(harness.port)
})

afterEach(async () => {
  backend?.kill()
  backend = null
  if (harness) await harness.close()
  harness = null
  try {
    rmSync(remoteRoot, { recursive: true, force: true })
    rmSync(localDir, { recursive: true, force: true })
  } catch {
    /* 정리 실패 무시 */
  }
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SFTP (ssh2 하네스, 커넥션 재사용)', () => {
  it('디렉토리 리스팅 — 폴더 우선 정렬 + 한글 파일/폴더명', async () => {
    const svc = makeService(backend!.sshClient())
    const res = await svc.list('sid', '/')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 폴더가 먼저(배포스크립트/), 그다음 파일들.
    expect(res.entries[0].type).toBe('dir')
    expect(res.entries[0].name).toBe('배포스크립트')
    const names = res.entries.map((e) => e.name)
    expect(names).toContain('README_한글.md')
    expect(names).toContain('access_20260731.log')
    // 파일 크기 메타(디렉토리는 0).
    const readme = res.entries.find((e) => e.name === 'README_한글.md')!
    expect(readme.type).toBe('file')
    expect(readme.size).toBeGreaterThan(0)
  })

  // 준영님 제보: 링크가 전부 파일로 보였다. readdir 이 주는 attrs 는 lstat 이라 링크의 대상 종류를
  // 모른다 — 링크만 골라 stat 으로 풀어야 폴더 링크가 폴더로 보이고 더블클릭으로 들어갈 수 있다.
  it('심볼릭 링크 — 대상 종류로 표시되고 링크임이 구분된다', async () => {
    // Windows 에서 파일 심링크는 권한이 필요하지만 폴더는 junction 으로 만들 수 있다.
    // 파일 심링크를 못 만드는 환경에서는 폴더 링크만 검증한다(스킵하지 않는다 — 핵심은 폴더 쪽이다).
    let fileLink = false
    try {
      symlinkSync(join(remoteRoot, 'README_한글.md'), join(remoteRoot, 'readme-link'), 'file')
      fileLink = true
    } catch {
      /* 권한 없음 — 폴더 링크만 본다 */
    }
    symlinkSync(join(remoteRoot, '배포스크립트'), join(remoteRoot, '스크립트-링크'), 'junction')
    symlinkSync(join(remoteRoot, '없는대상'), join(remoteRoot, '끊긴링크'), 'junction')

    const svc = makeService(backend!.sshClient())
    const res = await svc.list('sid', '/')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const by = (n: string) => res.entries.find((e) => e.name === n)!

    const dirLink = by('스크립트-링크')
    expect(dirLink.link).toBe(true)
    expect(dirLink.type).toBe('dir') // 대상이 폴더 → 폴더로 동작(정렬·더블클릭 진입)
    expect(dirLink.broken).toBeUndefined()

    expect(by('끊긴링크').broken).toBe(true)

    // 링크가 아닌 항목에는 표시가 붙지 않는다.
    expect(by('README_한글.md').link).toBeUndefined()

    if (fileLink) {
      const fl = by('readme-link')
      expect(fl.link).toBe(true)
      expect(fl.type).toBe('file')
      expect(fl.size).toBeGreaterThan(0) // 크기도 대상 기준
    }
  })

  it('로컬(비 SSH) 세션은 SFTP 사용 불가 — 구조화 오류(크래시 없음)', async () => {
    const svc = makeService(backend!.sshClient())
    const res = await svc.list('other-session', '/') // 매핑 없는 세션 → client null
    expect(res.ok).toBe(false)
  })

  it('다운로드 — 원격 파일을 로컬로 저장 + 진행률 방출', async () => {
    const progress: SftpProgress[] = []
    const svc = makeService(backend!.sshClient(), progress)
    const remotePath = '/README_한글.md'
    const localPath = join(localDir, 'README_다운.md')
    const size = statSync(join(remoteRoot, 'README_한글.md')).size
    const res = await svc.download('sid', 'dl1', remotePath, localPath, size)
    expect(res.ok).toBe(true)
    expect(existsSync(localPath)).toBe(true)
    expect(readFileSync(localPath, 'utf8')).toContain('한글 문서')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1].transferred).toBe(size)
  })

  it('업로드 — 로컬 파일을 원격 현재 디렉토리로 전송', async () => {
    const svc = makeService(backend!.sshClient())
    const localPath = join(localDir, '업로드_대상.txt')
    writeFileSync(localPath, '업로드 콘텐츠 한글\n')
    const res = await svc.upload('sid', 'up1', localPath, '/')
    expect(res.ok).toBe(true)
    // 원격 루트(=remoteRoot)에 실제 파일이 생겼는지.
    const uploaded = join(remoteRoot, '업로드_대상.txt')
    expect(existsSync(uploaded)).toBe(true)
    expect(readFileSync(uploaded, 'utf8')).toContain('업로드 콘텐츠 한글')
  })

  // F14: 터미널 Ctrl+V 로 넘어온 클립보드 파일 경로가 전송 큐를 거쳐 "현재 원격 디렉토리"에
  // 올라간다. 홈이 아니라 트리가 보고 있는 폴더로 가는지가 요점이라 하위 폴더로 올린다.
  it('F14 클립보드 파일 → 현재 원격 디렉토리로 업로드(전송 큐 재사용)', async () => {
    const progress: SftpProgress[] = []
    const svc = makeService(backend!.sshClient(), progress)
    // 탐색기에서 복사했다고 가정한 로컬 파일 두 개(한글 이름 포함).
    const clipboard = ['배포_설정.yaml', 'release_notes.txt'].map((name) => {
      const p = join(localDir, name)
      writeFileSync(p, `# ${name}\n한글 내용\n`)
      return p
    })
    // 전송 큐가 하는 일과 같은 순차 실행(FileTree.runQueue). remoteDir = 트리의 현재 경로.
    const remoteDir = '/배포스크립트'
    for (const [i, localPath] of clipboard.entries()) {
      const res = await svc.upload('sid', `clip${i}`, localPath, remoteDir)
      expect(res.ok).toBe(true)
    }
    for (const name of ['배포_설정.yaml', 'release_notes.txt']) {
      const landed = join(remoteRoot, '배포스크립트', name)
      expect(existsSync(landed)).toBe(true)
      expect(readFileSync(landed, 'utf8')).toContain('한글 내용')
      // 홈(원격 루트)에 잘못 올라가지 않았다.
      expect(existsSync(join(remoteRoot, name))).toBe(false)
    }
    // 항목마다 진행 이벤트가 붙는다(큐 UI 의 진행률 · 취소가 그대로 동작한다는 근거).
    expect(new Set(progress.map((p) => p.transferId))).toEqual(new Set(['clip0', 'clip1']))
  })

  it('다운로드 취소 → 부분 파일 정리(C-4): 로컬 임시 파일 삭제됨', async () => {
    const svc = makeService(backend!.sshClient())
    const remotePath = '/access_20260731.log' // 4MB — 취소 여지 확보
    const localPath = join(localDir, 'access_부분.log')
    const size = statSync(join(remoteRoot, 'access_20260731.log')).size
    const p = svc.download('sid', 'cxl1', remotePath, localPath, size)
    // 전송 시작 직후 취소.
    await wait(15)
    svc.cancel('cxl1')
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.canceled).toBe(true)
      // 부분 파일 정리 완료 → 로컬 파일 부재.
      expect(res.cleaned).toBe(true)
    }
    expect(existsSync(localPath)).toBe(false)
  })

  it('업로드 취소 → 원격 부분 파일 정리 시도(C-4)', async () => {
    const svc = makeService(backend!.sshClient())
    const localPath = join(localDir, '대용량_업로드.bin')
    writeFileSync(localPath, Buffer.alloc(4 * 1024 * 1024, 0x42))
    const res = svc.upload('sid', 'cxl2', localPath, '/')
    await wait(15)
    svc.cancel('cxl2')
    const out = await res
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.canceled).toBe(true)
    // 원격 불완전 파일은 정리 시도됨(성공 시 부재).
    const remoteUploaded = join(remoteRoot, '대용량_업로드.bin')
    if (!out.ok && out.cleaned) expect(existsSync(remoteUploaded)).toBe(false)
  })

  // ── R7 원격 파일 조작(로컬 fs 와 같은 계약) ──
  it('이름 변경 — 성공 / 권한 거부 실패', async () => {
    const svc = makeService(backend!.sshClient())
    expect(await svc.rename('sid', '/README_한글.md', '읽어보기.md')).toEqual({ ok: true })
    expect(existsSync(join(remoteRoot, '읽어보기.md'))).toBe(true)
    // 하네스는 'readonly' 경로에 PERMISSION_DENIED 를 돌려준다(권한 실패 경로 실증).
    mkdirSync(join(remoteRoot, 'readonly'))
    writeFileSync(join(remoteRoot, 'readonly', '설정.conf'), 'x')
    const denied = await svc.rename('sid', '/readonly/설정.conf', '바뀐.conf')
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.message).toContain('권한')
    expect(existsSync(join(remoteRoot, 'readonly', '설정.conf'))).toBe(true)
  })

  it('이름 변경 — 경로 구분자가 든 이름은 서버에 가기 전에 거부', async () => {
    const svc = makeService(backend!.sshClient())
    const res = await svc.rename('sid', '/README_한글.md', '../탈출.md')
    expect(res.ok).toBe(false)
    expect(existsSync(join(remoteRoot, 'README_한글.md'))).toBe(true)
  })

  it('새 폴더 — 성공 / 권한 거부 실패', async () => {
    const svc = makeService(backend!.sshClient())
    expect(await svc.mkdir('sid', '/', '신규_배포')).toEqual({ ok: true })
    expect(statSync(join(remoteRoot, '신규_배포')).isDirectory()).toBe(true)
    mkdirSync(join(remoteRoot, 'readonly'))
    const denied = await svc.mkdir('sid', '/readonly', '하위')
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.message).toContain('권한')
  })

  it('삭제 — 파일 + 재귀 폴더(SFTP 에는 재귀 op 가 없어 직접 내려간다)', async () => {
    const svc = makeService(backend!.sshClient())
    // 중첩 폴더를 만들어 재귀 삭제를 강제한다.
    mkdirSync(join(remoteRoot, '배포스크립트', '보관'), { recursive: true })
    writeFileSync(join(remoteRoot, '배포스크립트', '보관', 'old_운영.sh'), '#!/bin/sh\n')
    const res = await svc.remove('sid', 'rm1', ['/배포스크립트', '/README_한글.md'])
    expect(res).toEqual({ ok: true })
    expect(existsSync(join(remoteRoot, '배포스크립트'))).toBe(false)
    expect(existsSync(join(remoteRoot, 'README_한글.md'))).toBe(false)
  })

  it('삭제 — 없는 경로는 성공으로 위장하지 않는다', async () => {
    const svc = makeService(backend!.sshClient())
    const res = await svc.remove('sid', 'rm2', ['/없는파일.txt'])
    expect(res.ok).toBe(false)
  })

  it('삭제 취소 — 취소 후에는 아무것도 지우지 않는다', async () => {
    const svc = makeService(backend!.sshClient())
    // remove() 는 첫 await 전에 취소 토큰을 등록하므로 호출 직후 취소하면 결정적으로 잡힌다.
    const p = svc.remove('sid', 'rm3', ['/배포스크립트'])
    svc.cancel('rm3')
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.canceled).toBe(true)
    expect(existsSync(join(remoteRoot, '배포스크립트', 'deploy_운영.sh'))).toBe(true)
  })

  it('로컬(비 SSH) 세션은 파일 조작도 불가 — 구조화 오류', async () => {
    const svc = makeService(backend!.sshClient())
    expect((await svc.mkdir('other-session', '/', 'x')).ok).toBe(false)
    expect((await svc.remove('other-session', 'rm4', ['/x'])).ok).toBe(false)
  })

  it('SshBackend.sshClient()는 접속에 쓴 커넥션을 그대로 반환(새 연결 금지)', () => {
    // 동일 인스턴스 반환 확인 — SFTP가 shell과 같은 Client를 재사용한다.
    const c1 = backend!.sshClient()
    const c2 = backend!.sshClient()
    expect(c1).toBe(c2)
  })
})
