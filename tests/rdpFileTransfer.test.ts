// RDP 클립보드 파일 전송 — main 쪽 순수 로직.
//
// 여기가 왜 중요한가: 파일 이름과 하위 폴더 문자열은 **원격 Windows 가 준 것**이다. 그대로
// join 하면 `..\..\` 나 `C:\Windows\` 로 사용자가 고른 폴더 밖에 파일을 쓸 수 있다. 조용히 성공하고
// 되돌릴 수도 없는 종류의 사고라 경계 검사를 여기서 못 박는다.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeBase, safeSegments, uniqueName, saveBytes } from '../src/main/fs/saveBytes'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})
const tmp = (): string => (dir = mkdtempSync(join(tmpdir(), 'ara-rdpfile-')))

describe('파일명 검사(safeBase)', () => {
  it('평범한 이름은 통과', () => {
    expect(safeBase('보고서.pdf')).toBe('보고서.pdf')
  })
  it('경로가 붙어 오면 파일명만 남긴다', () => {
    expect(safeBase('docs\\images\\a.png')).toBe('a.png')
    expect(safeBase('docs/images/a.png')).toBe('a.png')
  })
  it('상위 참조·빈 이름은 거절', () => {
    for (const bad of ['..', '.', '', '   ', '../../x'.replace('x', '..')]) expect(safeBase(bad)).toBeNull()
  })
  it('Windows 예약 문자는 거절 — 조용히 치환하지 않는다', () => {
    for (const bad of ['a<b.txt', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0001b']) expect(safeBase(bad)).toBeNull()
  })
  it('문자열이 아니면 거절', () => {
    expect(safeBase(undefined)).toBeNull()
    expect(safeBase(42)).toBeNull()
  })
})

describe('하위 폴더 검사(safeSegments)', () => {
  it('없으면 루트(빈 배열)', () => {
    expect(safeSegments(undefined)).toEqual([])
    expect(safeSegments('')).toEqual([])
  })
  it('윈도우 구분자를 조각으로 나눈다', () => {
    expect(safeSegments('docs\\images')).toEqual(['docs', 'images'])
  })
  it('빈 조각은 접어 준다', () => {
    expect(safeSegments('docs\\\\images\\')).toEqual(['docs', 'images'])
  })
  it('상위 참조가 하나라도 있으면 전체 거절 — 부분 통과는 없다', () => {
    expect(safeSegments('docs\\..\\..\\Windows')).toBeNull()
    expect(safeSegments('..')).toBeNull()
  })
  it('드라이브 문자(절대 경로)는 거절', () => {
    expect(safeSegments('C:\\Windows')).toBeNull()
  })
})

describe('이름 충돌 회피(uniqueName)', () => {
  const has = (...names: string[]) => (n: string) => names.includes(n)
  it('없으면 그대로', () => {
    expect(uniqueName('a.txt', has())).toBe('a.txt')
  })
  it('있으면 (2) 를 붙이고 확장자는 뒤에 남긴다', () => {
    expect(uniqueName('a.txt', has('a.txt'))).toBe('a (2).txt')
  })
  it('연달아 있으면 계속 올라간다', () => {
    expect(uniqueName('a.txt', has('a.txt', 'a (2).txt'))).toBe('a (3).txt')
  })
  it('확장자 없는 이름도 된다', () => {
    expect(uniqueName('README', has('README'))).toBe('README (2)')
  })
})

describe('saveBytes 실제 쓰기', () => {
  it('폴더에 파일을 쓴다', async () => {
    const d = tmp()
    const r = await saveBytes({ dir: d, name: 'a.bin', bytes: new Uint8Array([1, 2, 3]) })
    expect(r.ok).toBe(true)
    expect([...readFileSync(join(d, 'a.bin'))]).toEqual([1, 2, 3])
  })

  it('하위 폴더를 만들어 쓴다', async () => {
    const d = tmp()
    const r = await saveBytes({ dir: d, sub: 'docs\\images', name: 'a.png', bytes: new Uint8Array([9]) })
    expect(r.ok).toBe(true)
    expect(existsSync(join(d, 'docs', 'images', 'a.png'))).toBe(true)
  })

  it('★ 폴더 밖으로 나가려는 경로는 쓰지 않는다', async () => {
    const d = tmp()
    const outside = join(d, '..', 'ara-escaped.bin')
    const r = await saveBytes({ dir: join(d, 'inner'), sub: '..\\..', name: 'ara-escaped.bin', bytes: new Uint8Array([1]) })
    expect(r.ok).toBe(false)
    expect(existsSync(outside)).toBe(false)
  })

  it('★ 이름에 경로가 박혀 와도 폴더 안에만 쓴다', async () => {
    const d = tmp()
    const r = await saveBytes({ dir: d, name: '..\\ara-escaped2.bin', bytes: new Uint8Array([1]) })
    // basename 으로 떨어져 폴더 안에 쓰인다(밖으로는 안 나간다).
    expect(r.ok).toBe(true)
    expect(existsSync(join(d, 'ara-escaped2.bin'))).toBe(true)
    expect(existsSync(join(d, '..', 'ara-escaped2.bin'))).toBe(false)
  })

  it('같은 이름을 두 번 받으면 덮어쓰지 않는다', async () => {
    const d = tmp()
    writeFileSync(join(d, 'a.bin'), Buffer.from([7]))
    const r = await saveBytes({ dir: d, name: 'a.bin', bytes: new Uint8Array([8]) })
    expect(r.ok).toBe(true)
    expect([...readFileSync(join(d, 'a.bin'))]).toEqual([7]) // 원본 그대로
    expect([...readFileSync(join(d, 'a (2).bin'))]).toEqual([8])
  })

  it('바이트가 없으면 구조화 오류(크래시 없음)', async () => {
    const d = tmp()
    expect((await saveBytes({ dir: d, name: 'a.bin', bytes: 'nope' })).ok).toBe(false)
    expect((await saveBytes({ dir: '', name: 'a.bin', bytes: new Uint8Array([1]) })).ok).toBe(false)
  })

  it('쓸 수 없는 폴더는 오류로 돌려준다(예외를 던지지 않는다)', async () => {
    const d = tmp()
    const filePath = join(d, 'notadir')
    mkdirSync(join(d, 'x'))
    writeFileSync(filePath, 'x')
    // 파일을 폴더처럼 쓰려 하면 실패해야 한다.
    const r = await saveBytes({ dir: filePath, name: 'a.bin', bytes: new Uint8Array([1]) })
    expect(r.ok).toBe(false)
  })
})
