// #88 R2 목록 보기 규칙 — 숨김·정렬·검색·이력. 전부 순수 함수라 화면 없이 여기서 못 박는다.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SORT,
  EMPTY_HISTORY,
  extOf,
  isHidden,
  nextSort,
  pushHistory,
  viewEntries
} from '../src/renderer/store/fileView'
import type { FileEntry } from '../src/shared/ipc'

const f = (name: string, size = 0, mtime = 0, type: 'dir' | 'file' = 'file'): FileEntry => ({ name, type, size, mtime })
const d = (name: string, mtime = 0): FileEntry => f(name, 0, mtime, 'dir')
const names = (es: FileEntry[]) => es.map((e) => e.name)

describe('isHidden / extOf', () => {
  it('점으로 시작하면 숨김 — 이름 안의 점은 아니다', () => {
    expect(isHidden('.git')).toBe(true)
    expect(isHidden('.env.local')).toBe(true)
    expect(isHidden('보고서.xlsx')).toBe(false)
  })

  it('확장자는 마지막 점 뒤 소문자. 점으로 시작하는 이름은 확장자가 없다', () => {
    expect(extOf('a.TAR.GZ')).toBe('gz')
    expect(extOf('README')).toBe('')
    // `.env` 의 점은 숨김 표시지 확장자가 아니다 — i > 0 조건이 그것을 지킨다.
    expect(extOf('.env')).toBe('')
  })
})

describe('viewEntries', () => {
  const list = [f('b.txt', 300, 30), d('zeta'), f('A.md', 100, 10), d('alpha'), f('.env', 200, 20)]

  it('폴더가 항상 먼저다 — 내림차순에서도', () => {
    const asc = viewEntries(list, { showHidden: true, sort: DEFAULT_SORT, filter: '' })
    expect(names(asc).slice(0, 2)).toEqual(['alpha', 'zeta'])
    const desc = viewEntries(list, { showHidden: true, sort: { key: 'name', asc: false }, filter: '' })
    // 내림차순이라 폴더끼리는 뒤집히지만, 폴더 묶음 자체는 여전히 위다.
    expect(names(desc).slice(0, 2)).toEqual(['zeta', 'alpha'])
  })

  it('숨김을 끄면 점 파일이 빠진다(기본은 보인다)', () => {
    expect(names(viewEntries(list, { showHidden: true, sort: DEFAULT_SORT, filter: '' }))).toContain('.env')
    expect(names(viewEntries(list, { showHidden: false, sort: DEFAULT_SORT, filter: '' }))).not.toContain('.env')
  })

  it('검색은 대소문자를 가리지 않고 부분 일치', () => {
    const r = viewEntries(list, { showHidden: true, sort: DEFAULT_SORT, filter: 'A' })
    expect(names(r)).toEqual(['alpha', 'zeta', 'A.md']) // zetA 도 걸린다
  })

  it('크기·날짜 정렬', () => {
    const bySize = viewEntries(list, { showHidden: true, sort: { key: 'size', asc: false }, filter: '' })
    expect(names(bySize).slice(2)).toEqual(['b.txt', '.env', 'A.md'])
    const byTime = viewEntries(list, { showHidden: true, sort: { key: 'mtime', asc: true }, filter: '' })
    expect(names(byTime).slice(2)).toEqual(['A.md', '.env', 'b.txt'])
  })

  it('종류(확장자) 정렬 — 같은 확장자끼리는 이름순으로 갈라진다', () => {
    const es = [f('z.md'), f('a.txt'), f('b.md'), f('c.txt')]
    const r = viewEntries(es, { showHidden: true, sort: { key: 'ext', asc: true }, filter: '' })
    expect(names(r)).toEqual(['b.md', 'z.md', 'a.txt', 'c.txt'])
  })

  it('값이 같으면 이름으로 갈라 목록이 흔들리지 않는다', () => {
    const es = [f('c', 0, 0), f('a', 0, 0), f('b', 0, 0)]
    const once = names(viewEntries(es, { showHidden: true, sort: { key: 'size', asc: true }, filter: '' }))
    const twice = names(viewEntries([...es].reverse(), { showHidden: true, sort: { key: 'size', asc: true }, filter: '' }))
    expect(once).toEqual(['a', 'b', 'c'])
    expect(twice).toEqual(once)
  })

  it('원본 배열을 건드리지 않는다(정렬은 사본에서)', () => {
    const es = [f('b'), f('a')]
    viewEntries(es, { showHidden: true, sort: DEFAULT_SORT, filter: '' })
    expect(names(es)).toEqual(['b', 'a'])
  })
})

describe('nextSort', () => {
  it('같은 기준을 다시 고르면 방향이 뒤집히고, 다른 기준은 오름차순부터', () => {
    expect(nextSort({ key: 'name', asc: true }, 'name')).toEqual({ key: 'name', asc: false })
    expect(nextSort({ key: 'name', asc: false }, 'name')).toEqual({ key: 'name', asc: true })
    expect(nextSort({ key: 'name', asc: false }, 'size')).toEqual({ key: 'size', asc: true })
  })
})

describe('pushHistory', () => {
  it('방문한 순서대로 쌓인다', () => {
    let h = pushHistory(EMPTY_HISTORY, '/a')
    h = pushHistory(h, '/b')
    expect(h).toEqual({ stack: ['/a', '/b'], idx: 1 })
  })

  it('같은 곳을 다시 읽으면(새로고침) 쌓지 않는다', () => {
    const h = pushHistory(pushHistory(EMPTY_HISTORY, '/a'), '/a')
    expect(h.stack).toEqual(['/a'])
  })

  it('뒤로 간 뒤 새 곳으로 가면 앞쪽 이력이 잘린다(브라우저와 같다)', () => {
    let h = pushHistory(pushHistory(pushHistory(EMPTY_HISTORY, '/a'), '/b'), '/c')
    h = { ...h, idx: 0 } // 뒤로 두 번
    h = pushHistory(h, '/d')
    expect(h).toEqual({ stack: ['/a', '/d'], idx: 1 })
  })
})
