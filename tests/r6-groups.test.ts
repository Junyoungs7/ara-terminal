import { describe, it, expect } from 'vitest'
import type { ConnectionProfile } from '../src/shared/types'
import { groupsOf, matchProfile, noneGroup, sortGroups } from '../src/renderer/store/groups'

// R6 연결 그룹 — 하드코딩 배열(['개발','운영'])과 하드코딩 정렬(운영→개발→기타)을 걷어낸 뒤의 규칙.
const p = (name: string, host: string, group?: string): ConnectionProfile => ({
  id: name,
  name,
  host,
  port: 22,
  username: 'deploy',
  type: 'ssh',
  auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' },
  ...(group ? { group } : {})
})

describe('그룹 목록 파생', () => {
  it('프로필의 group 값에서 파생된다(앱이 정한 기본 그룹 없음)', () => {
    expect(groupsOf([p('a', '10.0.0.1', '결제'), p('b', '10.0.0.2', '배송')], [])).toEqual(['결제', '배송'])
    expect(groupsOf([], [])).toEqual([])
  })

  it('프로필 없는 빈 그룹은 저장 목록에서 살아남는다', () => {
    expect(groupsOf([], ['신규팀'])).toEqual(['신규팀'])
    // 파생 + 저장이 겹쳐도 한 번만.
    expect(groupsOf([p('a', '10.0.0.1', '결제')], ['결제', '배송'])).toEqual(['결제', '배송'])
  })

  it('그룹 미지정 프로필은 그룹 목록을 늘리지 않는다("기타"는 표시용 자리)', () => {
    expect(groupsOf([p('a', '10.0.0.1')], [])).toEqual([])
  })
})

describe('그룹 정렬', () => {
  it('이름순(ko 콜레이션 — 한글 먼저) + "기타" 마지막', () => {
    expect(sortGroups(['기타', '운영', '개발', 'zeta', 'alpha'])).toEqual([
      '개발',
      '운영',
      'alpha',
      'zeta',
      noneGroup()
    ])
  })

  it('운영·개발이 더 이상 특별 대접을 받지 않는다', () => {
    // 예전 order()는 운영=0, 개발=1 이라 "가"로 시작하는 그룹보다 항상 앞이었다.
    expect(sortGroups(['운영', '가나다'])).toEqual(['가나다', '운영'])
  })
})

describe('프로필 검색', () => {
  const list = [p('결제서버', '10.20.30.40', '운영'), p('web-01', '192.168.0.7', '개발')]
  const hits = (q: string) => list.filter((x) => matchProfile(x, q)).map((x) => x.name)

  it('이름·호스트·그룹 어느 쪽이든 걸린다', () => {
    expect(hits('결제')).toEqual(['결제서버'])
    expect(hits('192.168')).toEqual(['web-01'])
    expect(hits('운영')).toEqual(['결제서버'])
  })

  it('대소문자 무시 · 빈 질의는 전부 통과', () => {
    expect(hits('WEB')).toEqual(['web-01'])
    expect(hits('   ')).toEqual(['결제서버', 'web-01'])
    expect(hits('없는서버')).toEqual([])
  })
})
