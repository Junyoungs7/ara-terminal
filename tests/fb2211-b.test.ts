import { describe, it, expect } from 'vitest'
import { serverDotClass } from '../src/renderer/store/profiles'
import { sideMenuX, MENU_EDGE } from '../src/renderer/interactions/ContextMenu'

// FB-2.2.3 7번: 세션이 끝나면 서버 점이 초록에서 내려간다.
describe('serverDotClass', () => {
  it('살아 있는(on) 세션이 있으면 초록', () => {
    expect(serverDotClass(['lost', 'on'], undefined)).toBe('on')
  })
  it('exit·끊김으로 세션이 lost 면 접속 기록이 connected 여도 내려간다', () => {
    expect(serverDotClass(['lost'], 'connected')).toBe('off')
  })
  it('탭을 닫아 세션이 없으면 connected 기록은 미연결', () => {
    expect(serverDotClass([], 'connected')).toBe('off')
  })
  it('붙는 중·실패는 그대로 말한다', () => {
    expect(serverDotClass([], 'connecting')).toBe('connecting')
    expect(serverDotClass([], 'error')).toBe('error')
    expect(serverDotClass(['connecting'], 'connected')).toBe('connecting')
  })
})

// FB-2.2.3 6번: ≡ 옆 메뉴는 펼침 패널 바깥 오른쪽, 자리가 없으면 왼쪽으로 뒤집는다.
describe('sideMenuX', () => {
  it('오른쪽에 자리가 있으면 패널 오른쪽 끝', () => {
    expect(sideMenuX({ left: 10, right: 150 }, 1280)).toBe(150)
  })
  it('오른쪽에 자리가 없으면 패널 왼쪽으로 뒤집는다', () => {
    expect(sideMenuX({ left: 500, right: 640 }, 800)).toBe(500 - 224)
  })
  it('양쪽 다 없으면 왼쪽 가장자리', () => {
    expect(sideMenuX({ left: 20, right: 160 }, 300)).toBe(MENU_EDGE)
  })
})
