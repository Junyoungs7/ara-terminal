import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { placeDropdown } from '../src/renderer/components/Dropdown'

// FB-dropdown: 연결 관리자 그룹 콤보의 목록(.dd-list)이 스크롤 부모(.prof-form, overflow-y:auto)
// 경계에 잘려 하단 버튼([취소]/[저장 후 접속]) 뒤로 사라지던 문제. 원인은 position:absolute 목록이
// overflow:auto/hidden 조상 안에서 클리핑된 것(z-index 문제 아님 — 실측 확인, agent_talk/FB-dropdown-done.md).
// 고침: 뷰포트 기준 position:fixed 로 좌표를 직접 계산(placeDropdown, Dropdown.tsx).

describe('드롭다운 배치(placeDropdown) — 아래 공간 부족 시 위로 flip', () => {
  it('아래 공간이 충분하면 버튼 바로 아래(top)에 연다', () => {
    const anchor = { left: 100, right: 300, top: 500, bottom: 537 }
    const pos = placeDropdown(anchor, 900) // 아래 여유 363px > 240px
    expect(pos.top).toBe(541)
    expect(pos.bottom).toBeUndefined()
    expect(pos.left).toBe(100)
    expect(pos.width).toBe(200)
  })

  it('아래 공간이 240px 미만이고 위가 더 넓으면 버튼 위(bottom 기준)로 연다', () => {
    const anchor = { left: 100, right: 300, top: 700, bottom: 737 }
    const pos = placeDropdown(anchor, 800) // 아래 여유 63px < 240px, 위 여유 700px > 63px
    expect(pos.bottom).toBe(104) // vh - anchor.top + 4
    expect(pos.top).toBeUndefined()
  })

  it('아래·위 모두 좁으면(둘 다 작음) 위가 더 넓을 때만 flip — 위가 더 좁으면 그대로 아래', () => {
    const anchor = { left: 0, right: 100, top: 30, bottom: 60 } // 위 30px, 아래 40px(vh=100)
    const pos = placeDropdown(anchor, 100)
    expect(pos.top).toBe(64) // 위(30)가 아래(40)보다 좁으므로 flip 안 함
  })
})

describe('회귀 가드: .dd-list 는 position:fixed(스크롤 부모 클리핑을 다시 받지 않음)', () => {
  it('shell.css .dd-list 규칙이 absolute 로 되돌아가지 않았다', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/shell.css'), 'utf8')
    const rule = /\.dd-list\s*\{[^}]*\}/.exec(css)
    expect(rule, '.dd-list 규칙을 못 찾음').toBeTruthy()
    expect(rule![0]).toMatch(/position:\s*fixed/)
    expect(rule![0]).not.toMatch(/position:\s*absolute/)
  })

  it('.dd-list 의 z-index(120)가 모달 푸터(.modal-ft, z-index 없음=auto)보다 위다', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/styles/shell.css'), 'utf8')
    const ddZ = Number(/\.dd-list\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1])
    expect(ddZ).toBeGreaterThan(0)
    // 모달 푸터(.modal-ft)에 z-index가 없으면 auto(부모 흐름 그대로) — dd-list가 배타적으로 위다.
    const ftRule = /\.modal-ft\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(ftRule).not.toMatch(/z-index/)
  })
})
