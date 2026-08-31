// 2026-08-31 준영님 제보: ① 고스트를 Tab 으로만 받는다(→ 로도 받게) ② 목록이 떠 있는데 Enter 가
// 셸로 가서 **명령이 실행된다**. 키 판정만 순수 함수로 떼어 냈으므로(completionKeys.ts) 여기서
// 상태 → 행동을 그대로 검사한다. 제일 중요한 것은 **가로채지 않는 경우**다 — 가로채기가 넘치면
// 터미널의 본래 키(커서 이동·명령 실행)를 잃는다.
import { describe, it, expect } from 'vitest'
import { completionKey, type CompState } from '../src/renderer/terminal/completionKeys'

// 고스트가 떠 있고 목록도 떠 있는(후보 2) 기본 상황. 각 검사는 필요한 것만 덮어쓴다.
const S = (over: Partial<CompState> = {}): CompState => ({
  key: 'Tab',
  ghost: true,
  items: 2,
  atLineEnd: true,
  ...over
})

describe('completionKey — → 로 고스트 받기', () => {
  it('줄 끝 + 고스트 → 오른쪽 화살표가 고스트를 받는다', () => {
    expect(completionKey(S({ key: 'ArrowRight', atLineEnd: true }))).toBe('accept')
  })

  it('줄 가운데면 → 는 셸로 간다 (커서 이동이 죽으면 그게 더 큰 회귀다)', () => {
    expect(completionKey(S({ key: 'ArrowRight', atLineEnd: false }))).toBe('pass')
  })

  it('고스트가 없으면 줄 끝이어도 → 는 셸로 간다', () => {
    expect(completionKey(S({ key: 'ArrowRight', ghost: false, atLineEnd: true }))).toBe('pass')
  })

  it('목록 없이 고스트만 있어도 → 는 받는다(Tab 과 같은 조건)', () => {
    expect(completionKey(S({ key: 'ArrowRight', items: 1 }))).toBe('accept')
  })
})

describe('completionKey — 목록에서의 Enter', () => {
  it('목록이 떠 있으면 Enter 는 고르기다 (셸로 가지 않는다)', () => {
    expect(completionKey(S({ key: 'Enter', items: 2 }))).toBe('accept')
  })

  it('목록이 없으면 Enter 는 셸로 간다 — 고스트만 떠 있는 줄은 친 그대로 실행된다', () => {
    expect(completionKey(S({ key: 'Enter', items: 0 }))).toBe('pass')
    expect(completionKey(S({ key: 'Enter', items: 1 }))).toBe('pass')
  })

  it('저절로 뜬 목록도 Enter 를 가져간다 — 그 대가를 알고 고른 동작이다 (2026-08-31 준영님 결정)', () => {
    // `ls` 를 쳤는데 히스토리의 `ls -la`·`ls -l` 로 목록이 뜬 상황. 여기서 Enter 는 ls 를
    // 실행하지 않고 `ls -la` 를 넣는다. **친 그대로 실행하려면 Esc 를 먼저** — 아래가 그 검사다.
    expect(completionKey(S({ key: 'Enter', items: 2 }))).toBe('accept')
  })

  it('고스트가 없으면 목록 값과 무관하게 Enter 는 셸로 간다', () => {
    expect(completionKey(S({ key: 'Enter', ghost: false }))).toBe('pass')
  })

  it('🔴 탈출구: Esc 로 닫으면 그다음 Enter 는 친 그대로 실행된다', () => {
    // 이 두 줄이 위 동작의 안전장치 전부다. 막히면 목록이 뜬 줄은 실행할 방법이 없어진다.
    const open = S({ key: 'Escape', items: 2 })
    expect(completionKey(open)).toBe('dismiss')
    // dismiss = TerminalPane 의 clearGhost — 고스트도 목록도 함께 지운다(ghostSuffix='' · compItems=[]).
    expect(completionKey({ ...open, key: 'Enter', ghost: false, items: 0 })).toBe('pass')
  })
})

describe('completionKey — 기존 동작(회귀 방지)', () => {
  it('Tab 은 고스트가 있으면 채택, 없으면 셸의 자동완성', () => {
    expect(completionKey(S({ key: 'Tab' }))).toBe('accept')
    expect(completionKey(S({ key: 'Tab', ghost: false }))).toBe('pass')
  })

  it('Esc 는 빠져나갈 문이다 — 고스트가 있으면 닫고, 없으면 셸로(인터럽트)', () => {
    expect(completionKey(S({ key: 'Escape' }))).toBe('dismiss')
    expect(completionKey(S({ key: 'Escape', ghost: false }))).toBe('pass')
  })

  it('↓↑ 는 목록이 있을 때만 후보를 옮긴다(없으면 셸의 히스토리 탐색)', () => {
    expect(completionKey(S({ key: 'ArrowDown' }))).toBe('next')
    expect(completionKey(S({ key: 'ArrowUp' }))).toBe('prev')
    expect(completionKey(S({ key: 'ArrowDown', items: 1 }))).toBe('pass')
    expect(completionKey(S({ key: 'ArrowUp', items: 1 }))).toBe('pass')
  })

  it('그 밖의 키(글자·←·Home)는 언제나 셸로 간다', () => {
    for (const key of ['a', 'ArrowLeft', 'Home', 'End', 'Backspace', ' ']) {
      expect(completionKey(S({ key }))).toBe('pass')
    }
  })
})
