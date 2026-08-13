// 작업 프로필(서버+폴더 즐겨찾기)의 순수 로직. 목록이 곧 관리 화면이라 이름이 겹치면
// 어느 게 어느 건지 알 수 없고, 검색이 서버명을 못 잡으면 서버가 늘었을 때 못 찾는다.
import { describe, it, expect } from 'vitest'
import { matchWorkProfile, uniqueWorkName } from '../src/renderer/store/workProfiles'
import type { WorkProfile } from '../src/shared/types'

const w = (name: string, path: string, profileId: string | null = 'p1'): WorkProfile => ({
  id: name,
  name,
  profileId,
  path
})

describe('작업 프로필 검색', () => {
  const item = w('웹 배포', '/home/jun/deploy/web')

  it('빈 검색어는 전부 통과', () => {
    expect(matchWorkProfile(item, 'kvt', '  ')).toBe(true)
  })

  it('이름·경로·서버명 어디에 걸려도 남는다', () => {
    expect(matchWorkProfile(item, 'kvt', '배포')).toBe(true)
    expect(matchWorkProfile(item, 'kvt', 'deploy')).toBe(true)
    expect(matchWorkProfile(item, 'kvt', 'KVT')).toBe(true) // 대소문자 무시
  })

  it('아무 데도 없으면 걸러진다', () => {
    expect(matchWorkProfile(item, 'kvt', 'nginx')).toBe(false)
  })
})

describe('이름 중복 처리', () => {
  it('겹치지 않으면 그대로', () => {
    expect(uniqueWorkName([], '웹 배포')).toBe('웹 배포')
  })

  it('겹치면 번호를 붙인다 — 목록에서 구분이 안 되면 저장이 의미가 없다', () => {
    const list = [w('웹 배포', '/a')]
    expect(uniqueWorkName(list, '웹 배포')).toBe('웹 배포 2')
    expect(uniqueWorkName([...list, w('웹 배포 2', '/b')], '웹 배포')).toBe('웹 배포 3')
  })

  it('빈 이름은 기본값으로 떨어진다(이름 없는 항목을 만들지 않는다)', () => {
    expect(uniqueWorkName([], '   ')).toBe('작업 위치')
  })
})
