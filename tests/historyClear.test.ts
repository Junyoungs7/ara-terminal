// 🔴 **[명령 기록 지우기]가 진짜로 지우는가** (#204-2, 2026-09-21).
//
// 지금까지 쌓인 명령을 지울 길은 `history.json` 을 손으로 여는 것뿐이었다. 그 파일에는
// 프롬프트에 그냥 친 비밀번호가 섞여 있다(준영님 실측 7건) — 지울 손잡이가 없는 것 자체가 결함이다.
//
// ⚠️ 시험은 **임시 폴더의 가짜 파일**로만 한다. 실제 `%APPDATA%\A.R.A\history.json` 은 읽지도
//    건드리지도 않는다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../src/main/history/HistoryStore'

describe('HistoryStore 통 목록·지우기', () => {
  let dir = ''
  let path = ''
  const opened: HistoryStore[] = []
  const store = (p = path): HistoryStore => {
    const s = new HistoryStore(p)
    opened.push(s)
    return s
  }
  // 디스크에 실제로 무엇이 남았나 — 이 시험의 핵심은 "메모리 말고 파일"이다.
  const onDisk = (): Record<string, string[]> =>
    existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>) : {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ara-histclear-'))
    path = join(dir, 'history.json')
    opened.length = 0
  })
  afterEach(() => {
    // append 가 걸어 둔 디바운스 타이머를 끄고 나서 폴더를 지운다.
    for (const s of opened) s.flush()
    rmSync(dir, { recursive: true, force: true })
  })

  it('scopes() 가 통 이름과 줄 수를 센다 — 내용은 주지 않는다', () => {
    const s = store()
    s.append('local', 'dir')
    s.append('local', 'npm run build')
    s.append('결제서버', 'systemctl status pay')
    expect(s.scopes()).toEqual([
      { scope: 'local', count: 2 },
      { scope: '결제서버', count: 1 }
    ])
  })

  it('빈 파일이면 빈 목록', () => {
    expect(store().scopes()).toEqual([])
  })

  it("clear('local') 은 그 통만 버린다", () => {
    const s = store()
    s.append('local', 'dir')
    s.append('결제서버', 'systemctl status pay')
    s.clear('local')
    expect(s.load('local')).toEqual([])
    expect(s.load('결제서버')).toEqual(['systemctl status pay'])
    expect(s.scopes()).toEqual([{ scope: '결제서버', count: 1 }])
  })

  it('clear() 는 전부 버린다', () => {
    const s = store()
    s.append('local', 'dir')
    s.append('결제서버', 'systemctl status pay')
    s.clear()
    expect(s.scopes()).toEqual([])
    expect(s.load('local')).toEqual([])
  })

  it('없는 통을 지워도 조용히 끝난다(목록과 화면 사이에 시차가 있다)', () => {
    const s = store()
    s.append('local', 'dir')
    s.clear('없는서버')
    expect(s.scopes()).toEqual([{ scope: 'local', count: 1 }])
  })

  /**
   * 🔴 **이 시험이 이 절의 본체다.** `append` 는 5초 디바운스로 쓰는데, `clear` 까지 그 타이머에
   * 맡기면 사용자가 [지우기]를 누르고 바로 앱을 꺼도 파일에 그대로 남는다 — 지웠다고 믿는데
   * 안 지워진 것이 이 기능의 최악이다. 그래서 **기다리지 않고** 파일을 읽어서 확인한다.
   */
  it("🔴 clear('local') 직후 **파일이 이미** 갱신돼 있다(디바운스를 기다리지 않는다)", () => {
    const s = store()
    s.append('local', 'dir')
    s.append('결제서버', 'systemctl status pay')
    s.clear('local')
    const raw = onDisk()
    expect(raw.local).toBeUndefined()
    expect(raw['결제서버']).toEqual(['systemctl status pay'])
  })

  it('🔴 clear() 직후 파일이 이미 비어 있다', () => {
    const s = store()
    s.append('local', 'dir')
    s.clear()
    expect(onDisk()).toEqual({})
  })

  /**
   * **양성 대조.** 위 두 건만 두면 "`append` 가 애초에 파일을 안 만들어서 통과"하는 경우와
   * 구분이 안 된다. 디바운스가 아직 안 돌았을 때 파일이 **비어 있다**는 것을 먼저 못 박는다.
   */
  it('양성 대조 — append 만으로는 아직 파일이 없다(그러니 위 두 건은 clear 가 쓴 것이다)', () => {
    const s = store()
    s.append('local', 'dir')
    expect(existsSync(path)).toBe(false)
  })

  it('지운 뒤 재기동해도 안 돌아온다', () => {
    const s = store()
    s.append('local', 'dir')
    s.append('결제서버', 'systemctl status pay')
    s.clear('local')
    expect(store().load('local')).toEqual([])
    expect(store().load('결제서버')).toEqual(['systemctl status pay'])
  })

  it('지운 뒤 다시 쌓으면 새 줄만 남는다', () => {
    const s = store()
    s.append('local', 'dir')
    s.clear('local')
    s.append('local', 'pwd')
    s.flush()
    expect(store().load('local')).toEqual(['pwd'])
  })
})

// ── 소스 검사 ──
describe('🔴 IPC 가 그 함수를 **실제로 쓰는가**', () => {
  const src = readFileSync(join(__dirname, '..', 'src/main/ipc/registerWorkspaceIpc.ts'), 'utf8')

  it('history:scopes 가 배선돼 있다', () => {
    expect(src).toMatch(/handle\('history:scopes'/)
  })

  it('history:clear 가 배선돼 있다', () => {
    expect(src).toMatch(/handle\('history:clear'/)
  })
})
