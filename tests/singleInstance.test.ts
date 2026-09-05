// 단일 인스턴스 잠금 (#176) — **막는 코드라서** 창 없이 검사한다.
//
// 여기서 틀리면 사용자에게 보이는 것은 하나다: **"앱이 안 켜진다."** 두 번째 프로세스는 창을 만들기
// 전에 끝나므로 화면에도 로그에도 이유가 남지 않는다(tests/sessionWin.test.ts 의 '아라 종료 확인'과
// 같은 자리 — 그쪽은 안 닫히는 사고, 이쪽은 안 켜지는 사고다).
//
// 반대 방향의 실패는 등급이 다르다 — 인스턴스가 둘이면 workspace.json 을 두 프로세스가 쓰는 불편이고,
// 안 켜지면 그 PC 에서 아라를 못 쓴다. 그래서 애매하면 **켜는 쪽**으로 판정한다.
import { describe, it, expect } from 'vitest'
import { shouldLockSingleInstance, windowToRaise, type RaisableWindow } from '../src/main/windows/singleInstance'

describe('잠금을 걸 자리인가', () => {
  it('설치본은 잠근다 — 사고가 나는 곳이 여기다(아이콘 두 번 누르기)', () => {
    expect(shouldLockSingleInstance({ packaged: true })).toBe(true)
    expect(shouldLockSingleInstance({ packaged: true, allowMulti: undefined })).toBe(true)
  })

  it('★ 개발·검사는 잠그지 않는다 — 이게 true 면 e2e 스위트와 dev 가 통째로 죽는다', () => {
    // 하네스는 out/main/index.js 를 electron 으로 직접 띄우므로 packaged 가 아니고, 앱을 여러 개
    // **동시에** 띄운다. dev 는 설치본과 userData(%APPDATA%\A.R.A)가 같아 잠그면 서로를 막는다.
    expect(shouldLockSingleInstance({ packaged: false })).toBe(false)
    expect(shouldLockSingleInstance({ packaged: false, allowMulti: '1' })).toBe(false)
  })

  it('★ ARA_ALLOW_MULTI=1 이면 안 잠근다 — 현장에서 "안 켜진다"를 되돌릴 유일한 손잡이다', () => {
    expect(shouldLockSingleInstance({ packaged: true, allowMulti: '1' })).toBe(false)
  })

  it("'1' 이 아닌 값은 탈출구가 아니다 — ARA_E2E·ARA_AI_FAKE 와 같은 규칙", () => {
    for (const v of ['', '0', 'true', 'yes', ' 1']) {
      expect(shouldLockSingleInstance({ packaged: true, allowMulti: v })).toBe(true)
    }
  })
})

describe('두 번째 인스턴스가 왔을 때 올릴 창', () => {
  const win = (destroyed = false): RaisableWindow => ({ isDestroyed: () => destroyed })
  const boom: RaisableWindow = {
    isDestroyed: () => {
      throw new Error('destroyed')
    }
  }

  it('본창이 있으면 본창이다 — 종료 확인 모달도 그 창 안에 그려져 함께 올라온다', () => {
    const main = win()
    expect(windowToRaise(main, [main, win()])).toBe(main)
  })

  it('★ 본창이 없고 보조 창만 있으면 그 창을 올린다 — 아무것도 안 올리면 "앱이 안 켜진다"', () => {
    // 실제로 가능한 상태다: 세션 없는 본창은 묻지 않고 닫히지만, 떼어낸 세션 창·RDP 창이 남아
    // 있으면 window-all-closed 가 안 와서 앱은 그대로 산다.
    const detached = win()
    expect(windowToRaise(null, [detached])).toBe(detached)
  })

  it('★ 본창이 파괴 중이면 건너뛰고 다음 창으로 — 목록에 남은 껍데기를 올리지 않는다', () => {
    const dead = win(true)
    const alive = win()
    expect(windowToRaise(dead, [dead, alive])).toBe(alive)
  })

  it('창 상태를 묻다 던지면 그 창은 없는 것으로 친다(파괴 레이스)', () => {
    const alive = win()
    expect(windowToRaise(boom, [boom, alive])).toBe(alive)
    expect(windowToRaise(boom, [boom])).toBeNull()
  })

  it('올릴 창이 없으면 null — 부팅 중이거나 이미 내려가는 중이다(창을 새로 만들지 않는다)', () => {
    expect(windowToRaise(null, [])).toBeNull()
    expect(windowToRaise(null, [win(true)])).toBeNull()
  })
})
