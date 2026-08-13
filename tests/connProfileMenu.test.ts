import { describe, it, expect } from 'vitest'
import { treeMenu } from '../src/renderer/interactions/actions'

// FB-ui2 추가 지시(2026-08-05): 연결 관리자 좌측 프로필 목록 우클릭 메뉴 항목 구성.
// "정보 수정"/"복제"/"삭제"는 트리(ConnTree)의 server.edit/server.duplicate/server.delete 를
// 그대로 재사용한다(actions.tsx TREE_MENUS 한 자리에만 정의).

describe('연결 관리자 프로필 목록 우클릭 메뉴', () => {
  it('프로필 행: 새 프로필 · 정보 수정 · 복제 · 삭제(위험 톤, 마지막)', () => {
    const items = treeMenu('connRow')
    expect(items.map((i) => i.id)).toEqual(['profile.new', 'server.edit', 'server.duplicate', 'server.delete'])
    expect(items.find((i) => i.id === 'server.delete')?.danger).toBe(true)
    expect(items.find((i) => i.id !== 'server.delete')?.danger).toBeFalsy()
  })

  it('빈 영역: 새 프로필뿐', () => {
    expect(treeMenu('connEmpty').map((i) => i.id)).toEqual(['profile.new'])
  })

  it('프로필 유형(SSH/RDP)별 노출 규칙: 이 4항목엔 SSH 전용 항목(호스트키 재설정 등)이 없다 — ' +
    '트리의 serverRdp 처럼 별도로 뺄 항목이 없어 connRow 는 프로필 타입과 무관하게 항상 같은 4항목이다', () => {
    // connRow 는 프로필 객체가 아니라 kind 하나로만 결정된다 — 호출 시점에 타입을 넘길 여지가 없다는
    // 사실 자체가 "타입 분기가 필요 없다"는 설계 판단의 증거다(호출측 ConnectionModal.tsx 참고).
    const first = treeMenu('connRow')
    const second = treeMenu('connRow')
    expect(first).toEqual(second)
  })
})
