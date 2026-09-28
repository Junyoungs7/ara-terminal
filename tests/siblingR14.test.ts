// #201 남은 형제 경로 갈림(R14-B) — 항목마다 가장 작은 시험 하나.
// A-2 는 detachedWiring.test.ts, B-2 는 w1c-qol.test.ts(uploadBus) 에 붙였다.
// ⚠️ 화면을 안 띄운다. 순수 함수는 값으로, 배선은 소스에 그 줄이 있는지로 본다 — 눌러 보는 것은 실기 몫.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({ shell: { trashItem: async () => {} } }))

const { invalidName } = await import('../src/main/fs/LocalFs')
const { tooBig } = await import('../src/main/editor/textIO')
const { withSize, freeShellTitle } = await import('../src/renderer/store/sessions')
const { SftpService } = await import('../src/main/sftp/SftpService')

const src = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')

describe('D — 새 로컬 셸', () => {
  const spec = { type: 'local' as const, title: 't', serverKey: 'localhost', profileId: null }

  it('★ 지금 칸의 치수를 싣는다 — 안 실으면 pty 가 80×24 로 열려 첫 프롬프트가 접힌다', () => {
    expect(withSize(spec, { cols: 180, rows: 40 })).toMatchObject({ cols: 180, rows: 40 })
  })

  it('치수를 들고 온 스펙(복원)은 건드리지 않고, 못 쓸 치수(usableSize)는 버린다', () => {
    expect(withSize({ ...spec, cols: 100, rows: 30 }, { cols: 180, rows: 40 })).toMatchObject({ cols: 100, rows: 30 })
    expect(withSize(spec, { cols: 9, rows: 4 })).not.toHaveProperty('cols')
    expect(withSize(spec, null)).not.toHaveProperty('cols')
  })

  it('★ 이름은 쓰이지 않은 가장 작은 `셸 N` — 복원된 `셸 1` 옆에 `셸 1` 을 또 만들지 않는다', () => {
    expect(freeShellTitle([])).toBe('셸 1')
    expect(freeShellTitle(['셸 1', '셸 2'])).toBe('셸 3')
    expect(freeShellTitle(['셸 2'])).toBe('셸 1')
  })
})

describe('F — 이름 규칙 · 안내 문구', () => {
  it('★ Windows 장치명은 로컬에만 — 리눅스 서버의 `aux` 는 만든다', () => {
    expect(invalidName('aux')).not.toBeNull()
    expect(invalidName('aux', false)).toBeNull()
    // 경로 탈출 검사는 원격에도 남는다
    expect(invalidName('../x', false)).not.toBeNull()
    expect(invalidName('a/b', false)).not.toBeNull()
  })

  it('★ 로컬 큰 파일 안내는 로컬에 있는 메뉴를 권한다', () => {
    expect(tooBig(5e6, false)).not.toMatch(/로그 보기|tail/)
    expect(tooBig(5e6, true)).toMatch(/서버 로그 보기/)
  })
})

describe('E — 중복 구현', () => {
  it('★ 시스템 모니터가 단위 규칙을 따로 들지 않는다(humanSize 하나)', () => {
    const s = src('src/renderer/components/SysMonitorPanel.tsx')
    expect(s).toMatch(/return humanSize\(kb \* 1024\)/)
    expect(s).not.toMatch(/toFixed\(1\)\}G/)
  })

  it('★ 파일 트리 드롭이 정본 filePaths() 를 쓰고, 손복제한 `.path` 식이 없다', () => {
    const s = src('src/renderer/components/FileTree.tsx')
    expect(s).toMatch(/filePaths\(\[\.\.\.e\.dataTransfer\.files\]\)/)
    expect(s).not.toMatch(/as File & \{ path\?: string \}/)
  })
})

describe('F — 원격 [새 파일]이 있는 파일을 건드리지 않는다', () => {
  // 가짜 SFTP: 디스크 대신 Map. open 의 플래그를 기록해, TRUNC 가 섞인 'w'·'wx' 를 쓰면 문다.
  const fake = (files: Map<string, string>, flagsSeen: string[]) => {
    const sftp = {
      stat: (p: string, cb: (e?: Error) => void) => cb(files.has(p) ? undefined : new Error('No such file')),
      open: (p: string, flags: string, cb: (e: Error | null, h?: Buffer) => void) => {
        flagsSeen.push(flags)
        if (flags.includes('w')) files.set(p, '') // 잘라쓰기
        else if (!files.has(p)) files.set(p, '')
        cb(null, Buffer.from('h'))
      },
      close: (_h: Buffer, cb: (e?: Error) => void) => cb(),
      end: () => {}
    }
    const client = { sftp: (cb: (e: Error | null, s: unknown) => void) => cb(null, sftp) }
    return new SftpService(() => client as never, () => {})
  }

  it('★ 있는 이름이면 거절하고 내용이 그대로다', async () => {
    const files = new Map([['/srv/app.conf', '중요한 설정']])
    const r = await fake(files, []).makeFile('s', '/srv', 'app.conf')
    expect(r.ok).toBe(false)
    expect(files.get('/srv/app.conf')).toBe('중요한 설정')
  })

  it('★ 없는 이름이면 만들고, 잘라쓰기(TRUNC) 플래그를 쓰지 않는다', async () => {
    const files = new Map<string, string>()
    const seen: string[] = []
    expect((await fake(files, seen).makeFile('s', '/srv', 'new.txt')).ok).toBe(true)
    expect(files.has('/srv/new.txt')).toBe(true)
    expect(seen).toEqual(['ax'])
  })
})
