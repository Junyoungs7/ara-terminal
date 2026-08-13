// Mac 키보드 → Windows 원격 키 변환. 이 표가 어긋나면 원격에서 수식키가 통째로 다른 키가 되고
// (⌘ 를 눌렀는데 시작 메뉴가 열린다) 화면상으론 원인이 안 보인다 — 자리 대응을 여기서 못 박는다.
import { describe, it, expect } from 'vitest'
import { RDP_KEY_MODES, defaultRdpKeyMode, remapKeyCode, scancodeOf } from '../src/renderer/components/rdpInput'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

describe('기본 모드', () => {
  it('Mac 호스트에서는 자동으로 켜진다(사용자가 설정을 찾지 않아도 된다)', () => {
    expect(defaultRdpKeyMode(MAC_UA)).toBe('mac')
  })
  it('Windows 호스트에서는 꺼져 있다 — 켜면 멀쩡한 Alt·Win 이 뒤바뀐다', () => {
    expect(defaultRdpKeyMode(WIN_UA)).toBe('off')
  })
})

describe('mac 모드 — 자리 그대로 ⌘↔⌥', () => {
  it('좌⌘ 는 Alt 로 간다(⌘ 자리가 Windows 의 Alt 자리)', () => {
    expect(remapKeyCode('MetaLeft', 'mac')).toBe('AltLeft')
  })
  it('우⌘ 는 우Alt = 한국어 101키 Windows 의 한/영 이다', () => {
    expect(remapKeyCode('MetaRight', 'mac')).toBe('AltRight')
  })
  it('⌥ 는 Win 으로 간다 — 그래야 Win 키를 계속 쓸 수 있다', () => {
    expect(remapKeyCode('AltLeft', 'mac')).toBe('MetaLeft')
    expect(remapKeyCode('AltRight', 'mac')).toBe('MetaRight')
  })
  it('수식키가 아닌 키는 건드리지 않는다', () => {
    for (const c of ['KeyA', 'Enter', 'ControlLeft', 'ShiftLeft', 'CapsLock', 'ArrowUp'])
      expect(remapKeyCode(c, 'mac')).toBe(c)
  })
})

describe('macCtrl 모드 — ⌘C/⌘V 를 Ctrl 로', () => {
  it('좌⌘ 만 Ctrl 이 되고 ⌥ 는 Alt 로 남는다', () => {
    expect(remapKeyCode('MetaLeft', 'macCtrl')).toBe('ControlLeft')
    expect(remapKeyCode('AltLeft', 'macCtrl')).toBe('AltLeft')
  })
  it('한/영(우⌘)은 mac 모드와 같다 — 모드를 바꿔도 한글 전환은 안 잃는다', () => {
    expect(remapKeyCode('MetaRight', 'macCtrl')).toBe('AltRight')
  })
})

describe('안전 조건', () => {
  it('off 는 아무것도 바꾸지 않는다', () => {
    for (const c of ['MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'KeyA'])
      expect(remapKeyCode(c, 'off')).toBe(c)
  })
  it('모든 모드의 변환 결과는 실제 스캔코드가 있는 키다(없으면 그 키가 조용히 씹힌다)', () => {
    const codes = ['MetaLeft', 'MetaRight', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'KeyA']
    for (const mode of RDP_KEY_MODES)
      for (const c of codes) expect(scancodeOf(remapKeyCode(c, mode))).not.toBeNull()
  })
  it('변환은 순수 함수 — 같은 키는 누를 때와 뗄 때 같은 코드로 간다(키 고착 방지)', () => {
    for (const mode of RDP_KEY_MODES) expect(remapKeyCode('MetaLeft', mode)).toBe(remapKeyCode('MetaLeft', mode))
  })
})
