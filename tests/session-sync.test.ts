import { describe, it, expect } from 'vitest'
import {
  groupSessions,
  groupColor,
  reorderSessions,
  pickBackgroundSession,
  type Session
} from '../src/renderer/store/sessions'

// F4b: 서버 그룹핑(탭바) + 트리·탭·패널 동기의 순수 로직 검증.
const s = (id: string, serverKey: string, type: Session['type']): Session => ({ id, title: id, serverKey, type })

describe('groupSessions (탭바 서버 그룹핑)', () => {
  it('같은 serverKey 세션은 하나의 그룹으로 묶인다', () => {
    const groups = groupSessions([
      s('a', 'dev-server', 'ssh'),
      s('b', 'dev-server', 'ssh'),
      s('c', 'localhost', 'local')
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].serverKey).toBe('dev-server')
    expect(groups[0].sessions.map((x) => x.id)).toEqual(['a', 'b'])
    expect(groups[0].local).toBe(false)
    expect(groups[1].local).toBe(true) // localhost = 단독(로컬) 그룹
  })

  it('삽입 순서를 보존한다(그룹·세션 모두)', () => {
    const groups = groupSessions([s('a', 'localhost', 'local'), s('b', 'prod', 'ssh'), s('c', 'localhost', 'local')])
    expect(groups.map((g) => g.serverKey)).toEqual(['localhost', 'prod'])
    expect(groups[0].sessions.map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('로컬 그룹색은 accent, 원격은 결정론적(같은 키 → 같은 색)', () => {
    expect(groupColor('localhost', true)).toBe('var(--accent)')
    expect(groupColor('web-prod-01', false)).toBe(groupColor('web-prod-01', false))
    // HEX 팔레트에서 선택(디자인 토큰 팔레트).
    expect(groupColor('web-prod-01', false)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('빈 세션 목록은 빈 그룹 배열', () => {
    expect(groupSessions([])).toEqual([])
  })
})

// R2.3: 탭 드래그 재정렬. 순서는 sessions 배열이 곧 진실(탭바·스냅샷이 같은 배열을 읽는다).
describe('reorderSessions (탭 드래그 재정렬)', () => {
  const list = [
    s('a', 'localhost', 'local'),
    s('b', 'localhost', 'local'),
    s('c', 'dev', 'ssh'),
    s('d', 'dev', 'ssh')
  ]

  it('같은 그룹 안에서 순서를 바꾼다', () => {
    expect(reorderSessions(list, 'b', 'a').map((x) => x.id)).toEqual(['b', 'a', 'c', 'd'])
    expect(reorderSessions(list, 'c', 'd').map((x) => x.id)).toEqual(['a', 'b', 'd', 'c'])
  })

  // FB-tabs: 그룹 래퍼를 없앤 뒤로는 평평한 개별 탭이라 서버가 달라도 자유롭게 옮길 수 있다.
  it('서버가 달라도 자유롭게 옮긴다(그룹 래퍼 제거 — FB-tabs)', () => {
    expect(reorderSessions(list, 'a', 'c').map((x) => x.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorderSessions(list, 'd', 'b').map((x) => x.id)).toEqual(['a', 'd', 'b', 'c'])
    // 서버 소속(serverKey)은 위치와 무관하게 그대로 — 옮겨도 세션 속성은 안 바뀐다.
    expect(reorderSessions(list, 'a', 'c').find((x) => x.id === 'a')?.serverKey).toBe('localhost')
  })

  it('같은 탭·없는 id 는 원본 그대로', () => {
    expect(reorderSessions(list, 'a', 'a')).toBe(list)
    expect(reorderSessions(list, 'zz', 'a')).toBe(list)
  })
})

// R2.0: 분할은 새 셸이 아니라 "이미 열려 있는 배경 탭"을 새 패널에 올린다.
describe('pickBackgroundSession (분할이 올릴 세션 선택)', () => {
  const list = [s('a', 'localhost', 'local'), s('b', 'localhost', 'local'), s('c', 'dev', 'ssh')]

  it('패널에 없는 세션 중 최근 사용한 것을 고른다', () => {
    expect(pickBackgroundSession(list, new Set(['a']), ['a', 'c', 'b'])).toBe('c')
  })

  it('MRU 에 없는 세션도 탭 순서로 폴백한다', () => {
    expect(pickBackgroundSession(list, new Set(['a']), [])).toBe('b')
  })

  it('모든 세션이 이미 패널에 있으면 null(호출부가 새 셸을 만든다)', () => {
    expect(pickBackgroundSession(list, new Set(['a', 'b', 'c']), ['a'])).toBeNull()
    expect(pickBackgroundSession([], new Set(), [])).toBeNull()
  })
})
