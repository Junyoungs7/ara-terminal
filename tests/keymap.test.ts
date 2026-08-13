import { describe, it, expect } from 'vitest'
import { KEYMAP, matchBinding, matchArrow, matchNumber, isAppShortcut } from '../src/shared/keymap'

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent

describe('keymap 단일 진실 소스', () => {
  it('action이 중복되지 않는다', () => {
    const actions = KEYMAP.map((k) => k.action)
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('같은 조합을 두 action 이 쓰지 않는다(재배치 후 충돌 방지)', () => {
    const combos = KEYMAP.map((k) => k.win)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('모든 바인딩이 win·mac·라벨을 채운다', () => {
    for (const b of KEYMAP) {
      expect(b.win).toBeTruthy()
      expect(b.mac).toBeTruthy()
      expect(b.labelKo).toBeTruthy()
    }
  })

  it('계획서 §B.8 확정 키를 포함한다(팔레트=Ctrl+K, 터미널 토글=Ctrl+`)', () => {
    const palette = KEYMAP.find((k) => k.action === 'palette.smart')
    const toggle = KEYMAP.find((k) => k.action === 'terminal.toggle')
    expect(palette?.win).toBe('Ctrl+K')
    expect(toggle?.win).toBe('Ctrl+`')
  })
})

// ── R3.8 단축키 충돌 정책 ──
// 앱 전용 키는 Ctrl+Shift+* / Alt+* / F-키에서만. 셸이 쓰는 단일 Ctrl+문자는 앱이 가로채지 않는다.
describe('R3.8 충돌 정책', () => {
  // 셸/리드라인이 쓰는 단일 Ctrl+문자. 이 조합이 KEYMAP 에 남아 있으면 정책 위반이다.
  const SHELL_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'H', 'K', 'L', 'N', 'P', 'Q', 'R', 'S', 'T', 'U', 'W', 'Y', 'Z', '\\', ']', '[']
  // 유일한 합의 예외 — 스마트 팔레트는 Ctrl+K 를 유지한다(사용자 확정 키).
  const ALLOWED = new Set(['palette.smart'])

  it('단일 Ctrl+문자 조합을 쓰는 앱 키는 팔레트(Ctrl+K) 하나뿐이다', () => {
    const offenders = KEYMAP.filter(
      (b) => !ALLOWED.has(b.action) && SHELL_KEYS.some((k) => b.win === `Ctrl+${k}`)
    ).map((b) => `${b.action}=${b.win}`)
    expect(offenders).toEqual([])
  })

  it('셸 표준 키는 터미널을 그대로 통과한다(앱이 가로채지 않는다)', () => {
    for (const key of ['c', 'd', 'z', 'l', 'r', 'w', 'u', 'a', 'e', 't', 'b', 'f', 's', '\\']) {
      expect(isAppShortcut(ev({ ctrlKey: true, key }))).toBe(false)
    }
  })

  it('R2 에서 가로채던 Ctrl+D(EOF)·Ctrl+W(단어삭제)가 셸로 되돌아왔다', () => {
    expect(isAppShortcut(ev({ ctrlKey: true, key: 'd' }))).toBe(false)
    expect(isAppShortcut(ev({ ctrlKey: true, key: 'w' }))).toBe(false)
    // 대신 Shift 를 얹은 조합이 앱 키다.
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'd' }), 'session.duplicate')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'w' }), 'pane.close')).toBe(true)
  })

  it('재배치된 키가 전부 keymap 에 반영돼 있다', () => {
    const win = (a: string) => KEYMAP.find((k) => k.action === a)?.win
    expect(win('session.duplicate')).toBe('Ctrl+Shift+D')
    expect(win('session.new')).toBe('Ctrl+Shift+T')
    expect(win('pane.close')).toBe('Ctrl+Shift+W')
    expect(win('split.horizontal')).toBe('Ctrl+Shift+-')
    expect(win('split.vertical')).toBe('Ctrl+Shift+\\')
    expect(win('tab.next')).toBe('Ctrl+Tab')
    expect(win('tab.prev')).toBe('Ctrl+Shift+Tab')
    expect(win('fileTree.toggle')).toBe('Ctrl+Shift+E')
    expect(win('connection.manager')).toBe('Ctrl+Shift+M')
    expect(win('terminal.search')).toBe('Ctrl+Shift+F')
    expect(win('clipboard.copy')).toBe('Ctrl+Shift+C')
    expect(win('clipboard.paste')).toBe('Ctrl+Shift+V')
  })
})

describe('matchBinding (렌더러 단축키 배선)', () => {
  it('Ctrl+Shift+T → session.new 일치', () => {
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 't' }), 'session.new')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'T' }), 'session.new')).toBe(true)
  })

  it('Shift 없는 Ctrl+T 는 미일치(셸로 간다)', () => {
    expect(matchBinding(ev({ ctrlKey: true, key: 't' }), 'session.new')).toBe(false)
  })

  it('modifier 없는 t는 session.new 미일치', () => {
    expect(matchBinding(ev({ key: 't' }), 'session.new')).toBe(false)
  })

  // R2.5: 'Ctrl+Up' 표기와 KeyboardEvent.key 'ArrowUp' 이 안 맞아 패널 최대화가 죽어 있었다.
  it('Ctrl+ArrowUp → pane.maximize 일치(Arrow 별칭)', () => {
    expect(matchBinding(ev({ ctrlKey: true, key: 'ArrowUp' }), 'pane.maximize')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, key: 'ArrowDown' }), 'pane.maximize')).toBe(false)
    expect(matchBinding(ev({ key: 'ArrowUp' }), 'pane.maximize')).toBe(false)
  })

  // R3.8: Shift 를 누르면 기호 키의 e.key 가 상단 문자로 바뀐다(- → _, \ → |).
  // 두 표기를 모두 인정하지 않으면 재배치한 분할 단축키가 통째로 죽는다.
  it('Ctrl+Shift+기호는 shifted 문자(_ |)로 와도 일치한다', () => {
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: '-' }), 'split.horizontal')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: '_' }), 'split.horizontal')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: '\\' }), 'split.vertical')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: '|' }), 'split.vertical')).toBe(true)
    // Shift 없는 Ctrl+\ 는 SIGQUIT — 앱이 먹지 않는다.
    expect(matchBinding(ev({ ctrlKey: true, key: '\\' }), 'split.vertical')).toBe(false)
  })

  it('Ctrl+Tab / Ctrl+Shift+Tab 탭 순환', () => {
    expect(matchBinding(ev({ ctrlKey: true, key: 'Tab' }), 'tab.next')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'Tab' }), 'tab.prev')).toBe(true)
    // Shift 유무로 정확히 갈린다(둘 다 반응하면 순환이 제자리걸음이 된다).
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'Tab' }), 'tab.next')).toBe(false)
    expect(matchBinding(ev({ ctrlKey: true, key: 'Tab' }), 'tab.prev')).toBe(false)
  })

  it('Ctrl+` 기호 키 일치', () => {
    expect(matchBinding(ev({ ctrlKey: true, key: '`' }), 'terminal.toggle')).toBe(true)
  })

  it('범위·방향 표기는 matchBinding 이 아니라 전용 판정이 처리한다', () => {
    expect(matchBinding(ev({ ctrlKey: true, key: '3' }), 'tab.byNumber')).toBe(false)
    expect(matchBinding(ev({ altKey: true, key: 'ArrowLeft' }), 'focus.move')).toBe(false)
    expect(matchArrow(ev({ altKey: true, key: 'ArrowLeft' }), 'focus.move')).toBe('left')
    expect(matchArrow(ev({ key: 'ArrowLeft' }), 'focus.move')).toBeNull()
  })
})

describe('matchNumber (Ctrl+1-9 탭 번호 이동)', () => {
  it('Ctrl+1 ~ Ctrl+9 는 눌린 숫자를 돌려준다', () => {
    expect(matchNumber(ev({ ctrlKey: true, key: '1' }), 'tab.byNumber')).toBe(1)
    expect(matchNumber(ev({ ctrlKey: true, key: '9' }), 'tab.byNumber')).toBe(9)
  })

  it('범위 밖(0)·modifier 없음·다른 action 은 null', () => {
    expect(matchNumber(ev({ ctrlKey: true, key: '0' }), 'tab.byNumber')).toBeNull()
    expect(matchNumber(ev({ key: '3' }), 'tab.byNumber')).toBeNull()
    expect(matchNumber(ev({ ctrlKey: true, key: '3' }), 'session.new')).toBeNull()
  })
})

describe('isAppShortcut (터미널이 셸로 흘리면 안 되는 키)', () => {
  it('배선된 앱 단축키는 가로챈다', () => {
    expect(isAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'd' }))).toBe(true)
    expect(isAppShortcut(ev({ ctrlKey: true, key: 'ArrowUp' }))).toBe(true)
    expect(isAppShortcut(ev({ ctrlKey: true, key: '5' }))).toBe(true)
    expect(isAppShortcut(ev({ altKey: true, key: 'ArrowLeft' }))).toBe(true)
    expect(isAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'c' }))).toBe(true) // 복사
    expect(isAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'f' }))).toBe(true) // 검색
    // W3: 아라가 배선되면서 두 조합이 앱 키가 됐다 — 이제 셸로 흘리지 않는다.
    expect(isAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'a' }))).toBe(true) // ai.ask
    expect(isAppShortcut(ev({ altKey: true, key: 'a' }))).toBe(true) // ai.toggle
  })

  it('미구현 키와 평범한 타이핑은 셸로 그대로 보낸다', () => {
    expect(isAppShortcut(ev({ ctrlKey: true, shiftKey: true, key: 's' }))).toBe(false) // log.save 미배선
    expect(isAppShortcut(ev({ key: 'a' }))).toBe(false)
    expect(isAppShortcut(ev({ shiftKey: true, key: '?' }))).toBe(false) // 치트시트는 입력 포커스에서 제외
  })
})

describe('치트시트 노출 대상 (R2.5 implemented 플래그)', () => {
  it('미구현으로 표시된 키는 실제 미배선 기능뿐이다', () => {
    // R3.8 에서 fileTree.toggle(Ctrl+Shift+E)·terminal.search(Ctrl+Shift+F)가 실배선됐고,
    // W3(F16)에서 ai.ask(Ctrl+Shift+A)·ai.toggle(Alt+A)가 배선됐다. 남은 것은 log.save 뿐이다.
    const dead = KEYMAP.filter((k) => !k.implemented).map((k) => k.action).sort()
    expect(dead).toEqual(['log.save'])
  })

  it('배선된 항목이 치트시트를 채운다(4열 표 기준 15행 이상)', () => {
    expect(KEYMAP.filter((k) => k.implemented).length).toBeGreaterThanOrEqual(15)
  })
})
