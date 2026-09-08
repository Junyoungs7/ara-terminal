import { describe, it, expect } from 'vitest'
import type { ConnectionProfile, RdpProfile } from '../src/shared/types'
import {
  applyGroupDrop,
  canNest,
  dropZone,
  flatGroups,
  groupDropVerdict,
  groupTree,
  matchProfile,
  noneGroup,
  parentGroupOf,
  removeFromLayout,
  renameInLayout,
  sortSiblings,
  type GroupLayout
} from '../src/renderer/store/groups'
import { profileInput } from '../src/renderer/store/profiles'

// #193 1라운드(2026-09-08) 사이드바 — 끌어다 정한 순서 · 2단 중첩 · 서버 행 색.
//
// **창 없이 검사할 수 있어야 한다**(singleInstance.ts · webglChoice.ts 와 같은 관행): 여기 걸린 셋은
// 전부 "화면을 열어 눈으로 봐야만 아는" 종류의 사고를 낸다 —
//   · 순서·중첩이 어긋나면 사용자가 정리해 둔 목록이 **말없이 다시 섞인다**
//   · 상한을 못 막으면 3단이 생기고, 그리는 쪽은 2단만 그리므로 그 그룹이 **화면에서 사라진다**
//   · 서버 행 색은 "지금 무엇을 보고 있나"를 말하는 자리라 두 뜻이 섞이면 계속 헷갈린다
//
// ⚠️ 이 검사가 **못 보는 것**: 실제 드래그(마우스로 끌어 놓는 몸짓)·놓을 자리 표시의 생김새·
//    dataTransfer 배선. 그건 창을 띄워야 보인다.

const none = noneGroup() // "기타" — 실제 그룹이 아니라 그룹 미지정 프로필이 모이는 자리

const ssh = (name: string, group?: string): ConnectionProfile => ({
  id: name,
  type: 'ssh',
  name,
  host: '10.0.0.1',
  port: 22,
  username: 'deploy',
  auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' },
  ...(group ? { group } : {})
})

describe('그룹 순서 — 끌어다 정한 것 먼저, 나머지는 가나다순', () => {
  it('순서에 있는 것 · 없는 것 · "기타"가 섞여도 규칙은 하나다', () => {
    // 저장된 순서: 배송 → 결제. 순서에 없는 "가나다"는 그 뒤로, "기타"는 언제나 맨 끝.
    expect(sortSiblings(['가나다', '결제', none, '배송'], ['배송', '결제'])).toEqual([
      '배송',
      '결제',
      '가나다',
      none
    ])
  })

  it('"기타"는 순서 목록에 적혀 있어도 마지막이다', () => {
    expect(sortSiblings(['결제', none], [none, '결제'])).toEqual(['결제', none])
  })

  it('순서가 없으면 지금까지와 같다(가나다순 + "기타" 마지막)', () => {
    expect(sortSiblings(['운영', '개발', none])).toEqual(['개발', '운영', none])
  })
})

describe('2단 중첩 — 그리기', () => {
  const names = ['운영', '결제', '배송', '개발']

  it('부모 밑으로 들어가고, 형제끼리는 순서를 따른다', () => {
    const tree = groupTree(names, { order: ['운영', '배송', '결제'], parents: { 결제: '운영', 배송: '운영' } })
    expect(tree).toEqual([
      { name: '운영', children: ['배송', '결제'] },
      { name: '개발', children: [] }
    ])
    expect(flatGroups(tree)).toEqual(['운영', '배송', '결제', '개발'])
  })

  it('없는 그룹을 부모로 가리키면 무시하고 최상위로 올린다(옛 앱이 지운 흔적)', () => {
    expect(groupTree(['결제'], { parents: { 결제: '사라진그룹' } })).toEqual([{ name: '결제', children: [] }])
    expect(parentGroupOf('결제', ['결제'], { 결제: '사라진그룹' })).toBeUndefined()
  })

  it('저장된 값이 3단이면 **더 깊은 쪽을 버린다** — 손자가 조부모 밑으로 붙지 않는다', () => {
    // 손:자식:부모 로 저장돼 있어도 그릴 수 있는 것은 2단뿐이다.
    const tree = groupTree(['부모', '자식', '손자'], { parents: { 자식: '부모', 손자: '자식' } })
    expect(tree).toEqual([
      { name: '부모', children: ['자식'] },
      { name: '손자', children: [] } // 조부모(부모) 밑이 아니라 최상위로 — 계층을 몰래 바꾸지 않는다
    ])
  })

  it('"기타"는 부모도 자식도 되지 않는다', () => {
    expect(groupTree(['결제', none], { parents: { [none]: '결제', 결제: none } })).toEqual([
      { name: '결제', children: [] },
      { name: none, children: [] }
    ])
  })

  it('자기 자신을 부모로 적어도 무한 루프가 아니라 최상위다', () => {
    expect(groupTree(['결제'], { parents: { 결제: '결제' } })).toEqual([{ name: '결제', children: [] }])
  })
})

describe('2단 중첩 — 상한 강제', () => {
  const names = ['운영', '결제', '배송']

  it('그냥 넣는 것은 된다', () => {
    expect(canNest('결제', '운영', names)).toEqual({ ok: true })
  })

  it('부모가 이미 남의 자식이면 거부(3단)', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } }
    expect(canNest('배송', '결제', names, layout)).toEqual({ ok: false, reason: 'depth' })
  })

  it('자식이 딸린 그룹을 남의 안에 넣는 것도 거부(3단)', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } }
    expect(canNest('운영', '배송', names, layout)).toEqual({ ok: false, reason: 'depth' })
  })

  it('순환(A→B→A)은 상한이 대신 막는다 — 순환 검사를 따로 두지 않았다', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } } // 결제가 운영 안
    expect(canNest('운영', '결제', names, layout)).toEqual({ ok: false, reason: 'depth' })
  })

  it('자기 자신 · "기타"는 각각 다른 사유로 거부된다', () => {
    expect(canNest('운영', '운영', names)).toEqual({ ok: false, reason: 'self' })
    expect(canNest('운영', none, [...names, none])).toEqual({ ok: false, reason: 'none' })
    expect(canNest(none, '운영', [...names, none])).toEqual({ ok: false, reason: 'none' })
  })
})

describe('드래그 — 놓을 자리 판정', () => {
  it('머리글 위/아래 가장자리는 순서, 가운데는 그 안에', () => {
    expect(dropZone(1, 24)).toBe('before')
    expect(dropZone(12, 24)).toBe('into')
    expect(dropZone(23, 24)).toBe('after')
  })

  it('높이가 0이면(아직 안 그려진 행) 중첩으로 본다 — 0 으로 나누지 않는다', () => {
    expect(dropZone(0, 0)).toBe('into')
  })
})

describe('드래그 — 놓았을 때', () => {
  const names = ['운영', '결제', '배송']
  // 끌기 전 화면 순서(가나다) — 아래 기대값은 전부 이 줄과 비교해서 읽는다.
  const before = ['결제', '배송', '운영']

  it('끌기 전에는 가나다순이다', () => {
    expect(flatGroups(groupTree(names))).toEqual(before)
  })

  it('가운데에 놓으면 그 안으로 — 나머지 순서는 보이던 그대로 굳는다', () => {
    const next = applyGroupDrop('결제', '운영', 'into', names)
    expect(next.parents).toEqual({ 결제: '운영' })
    expect(flatGroups(groupTree(names, next))).toEqual(['배송', '운영', '결제'])
  })

  it('앞/뒤로 놓으면 순서만 바뀐다', () => {
    const next = applyGroupDrop('배송', '결제', 'before', names)
    expect(next.parents).toEqual({})
    expect(flatGroups(groupTree(names, next))).toEqual(['배송', '결제', '운영'])
  })

  it('최상위 그룹의 앞/뒤에 놓으면 **밖으로 나온다**(중첩을 푸는 유일한 드래그)', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } }
    const next = applyGroupDrop('결제', '배송', 'after', names, layout)
    expect(next.parents).toEqual({})
    expect(flatGroups(groupTree(names, next))).toEqual(['배송', '결제', '운영'])
  })

  it('자식 그룹의 앞/뒤에 놓으면 그 형제가 된다(= 같은 부모 안으로)', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } }
    const next = applyGroupDrop('배송', '결제', 'after', names, layout)
    expect(next.parents).toEqual({ 결제: '운영', 배송: '운영' })
    expect(groupTree(names, next)).toEqual([{ name: '운영', children: ['결제', '배송'] }])
  })

  it('상한을 넘기는 자리는 이유와 함께 거부된다 — 자기 자신 위는 잘못이 아니다', () => {
    const layout: GroupLayout = { parents: { 결제: '운영' } }
    expect(groupDropVerdict('배송', '결제', 'into', names, layout)).toEqual({ ok: false, reason: 'depth' })
    expect(groupDropVerdict('배송', '결제', 'after', names, layout)).toEqual({ ok: true })
    expect(groupDropVerdict('운영', '운영', 'into', names, layout)).toEqual({ ok: false, reason: 'self' })
    expect(groupDropVerdict('운영', none, 'into', [...names, none], layout)).toEqual({ ok: false, reason: 'none' })
  })

  it('"기타"는 저장되는 순서에 들어가지 않는다(번역된 표시용 이름이다)', () => {
    const next = applyGroupDrop('배송', '운영', 'before', [...names, none])
    expect(next.order).not.toContain(none)
  })

  it('순서에 남아 있던 죽은 이름은 놓는 김에 걷힌다', () => {
    const next = applyGroupDrop('배송', '운영', 'before', names, { order: ['사라진그룹', '운영'] })
    expect(next.order).not.toContain('사라진그룹')
  })
})

describe('그룹 이름 변경 · 삭제가 배치에 남기는 것', () => {
  it('이름이 바뀌면 순서·부모 관계가 따라간다', () => {
    const next = renameInLayout({ order: ['운영', '결제'], parents: { 결제: '운영' } }, '운영', '운영2')
    expect(next.order).toEqual(['운영2', '결제'])
    expect(next.parents).toEqual({ 결제: '운영2' })
  })

  it('부모를 지우면 자식은 **최상위로 올라온다**(함께 지우지 않는다)', () => {
    const next = removeFromLayout({ order: ['운영', '결제'], parents: { 결제: '운영' } }, '운영')
    expect(next.order).toEqual(['결제'])
    expect(next.parents).toEqual({})
    expect(groupTree(['결제'], next)).toEqual([{ name: '결제', children: [] }])
  })

  it('자식을 지우면 부모는 그대로다', () => {
    const next = removeFromLayout({ parents: { 결제: '운영', 배송: '운영' } }, '결제')
    expect(next.parents).toEqual({ 배송: '운영' })
  })
})

describe('검색 — 부모 그룹 이름으로도 걸린다', () => {
  const p = ssh('결제서버', '결제')

  it('자기 그룹이 아니어도 부모 이름이 걸리면 남는다', () => {
    expect(matchProfile(p, '운영')).toBe(false)
    expect(matchProfile(p, '운영', '운영')).toBe(true)
  })

  it('부모를 안 주면 지금까지와 같다(연결 관리자는 중첩을 모른다)', () => {
    expect(matchProfile(p, '결제')).toBe(true)
    expect(matchProfile(p, '   ')).toBe(true)
  })
})

// 여기 있던 `serverRowActive` 검사는 2026-09-08 에 걷었다. 그 판정 자체가 없어졌기 때문이다 —
// 준영님 확정: *"사람이 직접 서버를 클릭할때도 굳이 남길 필요는 없을것 같아. (…) 원클릭은 굳이
// 필요 없을것 같아. 상태dot은 남겨줘."* 서버 행에는 색으로 말할 상태가 하나도 없다.
// 없어진 규칙을 지키는 검사를 남겨 두면 다음 사람이 그것을 살아 있는 의도로 믿는다.
// 지금 그 자리를 지키는 것: ConnTree 의 선언부 주석(왜 색이 없나) · 상태 점(connDotClass) ·
// 전역 `:focus-visible`(키보드 위치).

describe('프로필 저장 입력 조립', () => {
  const rdp: RdpProfile = {
    id: 'r1',
    type: 'rdp',
    name: '윈도우서버',
    host: '10.0.0.9',
    port: 3389,
    username: 'admin',
    group: '운영',
    multiMonitor: true
  }

  it('그룹만 바꿔도 rdp 의 [다중 모니터]는 살아남는다(저장은 통째 덮어쓰기다)', () => {
    expect(profileInput(rdp, { group: '개발' })).toEqual({
      id: 'r1',
      type: 'rdp',
      name: '윈도우서버',
      host: '10.0.0.9',
      port: 3389,
      username: 'admin',
      multiMonitor: true,
      group: '개발'
    })
  })

  it('그룹에서 빼면 group 이 undefined 로 간다("기타"라는 그룹을 만들지 않는다)', () => {
    expect(profileInput(ssh('web-01', '운영'), { group: undefined }).group).toBeUndefined()
  })

  it('ssh 는 인증 방식이 따라간다 — 비밀은 싣지 않는다(vault 의 기존 값을 그대로 둔다)', () => {
    const input = profileInput(ssh('web-01', '운영'))
    expect(input).toMatchObject({ type: 'ssh', authType: 'key', keyPath: '~/.ssh/id_ed25519' })
    expect(input).not.toHaveProperty('secret')
  })
})
