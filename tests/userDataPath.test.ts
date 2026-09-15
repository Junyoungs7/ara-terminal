// #199 사용자 데이터 폴더가 **제품명에서 떨어져 있는가** — 이름을 바꿔도 데이터가 안 사라지게.
//
// 이 시험이 막으려는 사고 하나:
//   `productName` 을 `ARA` 로 바꾸면서 `LEGACY_USER_DATA` 도 같이 `ARA` 로 고치는 것.
//   그러면 앱이 빈 폴더를 보고 **프로필·호스트키·설정이 전부 사라진 것처럼 보인다.**
//   두 값이 **달라야 한다**는 것이 이 장치의 전부이고, 여기서 그것만 지킨다.
//
// ⚠️ 이건 소스 텍스트를 읽는 시험이다. 실행 시점의 진짜 경로는 못 본다(Electron 이 필요하다) —
//    그건 실기 확인 항목이고 `docs/plan-rename-ara.md` 에 절차로 적혀 있다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const mainSrc = readFileSync(join(root, 'src/main/index.ts'), 'utf8')

describe('#199 userData 를 제품명에서 떼어 냈나', () => {
  it('main 이 userData 를 명시적으로 고정한다', () => {
    expect(mainSrc).toContain("app.setPath('userData'")
    expect(mainSrc).toMatch(/const LEGACY_USER_DATA = '[^']+'/)
  })

  it('🔴 고정값은 **영원히 `A.R.A`** 다 — 여기가 바뀌면 사용자 데이터가 사라진다', () => {
    const m = mainSrc.match(/const LEGACY_USER_DATA = '([^']+)'/)
    expect(m).not.toBeNull()
    /**
     * 역사적인 폴더 이름이다. 제품명이 무엇이 되든 **이 값은 안 바뀐다** — 기존 사용자의 프로필·
     * 호스트키·설정이 그 폴더에 있기 때문이다.
     *
     * ⚠️ "productName 과 달라야 한다"로 쓰면 안 된다 — 이름을 바꾸기 **전**(1단계)에는 둘이 같고,
     *    그때 시험이 실패해 버린다. 지켜야 할 것은 "다름"이 아니라 **"이 값이 고정"** 이다.
     */
    expect(m![1]).toBe('A.R.A')
  })

  it('★ 고정값이 리터럴이다 — productName 에서 읽어 오면 같이 바뀌어 장치가 죽는다', () => {
    // `app.getName()`·`pkg.productName` 같은 것을 끌어다 쓰면 이름을 바꾸는 순간 함께 바뀐다.
    const line = mainSrc.split('\n').find((l) => l.includes('LEGACY_USER_DATA =')) ?? ''
    expect(line).not.toContain('getName')
    expect(line).not.toContain('productName')
  })

  it('whenReady 보다 먼저 부른다 — 그 뒤엔 경로가 이미 굳는다', () => {
    const setPathAt = mainSrc.indexOf("app.setPath('userData'")
    const readyAt = mainSrc.indexOf('app.whenReady()')
    expect(setPathAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(-1)
    expect(setPathAt).toBeLessThan(readyAt)
  })
})
