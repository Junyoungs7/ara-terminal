// 2026-08-31 준영님 제보: ① 고스트를 Tab 으로만 받는다(→ 로도 받게) ② 목록이 떠 있는데 Enter 가
// 셸로 가서 **명령이 실행된다**. 키 판정만 순수 함수로 떼어 냈으므로(completionKeys.ts) 여기서
// 상태 → 행동을 그대로 검사한다. 제일 중요한 것은 **가로채지 않는 경우**다 — 가로채기가 넘치면
// 터미널의 본래 키(커서 이동·명령 실행)를 잃는다.
//
// 2026-09-08 #194: 목록이 **저절로 뜨지 않게** 되면서 `items > 1`(후보가 있다)과
// `listOpen`(목록이 화면에 있다)이 갈렸다. Tab 은 셸에 돌려줬다. 아래 검사가 그 경계 전부다.
import { describe, it, expect } from 'vitest'
import { completionKey, type CompState } from '../src/renderer/terminal/completionKeys'

// 고스트가 떠 있고 후보가 둘인데 **목록은 아직 안 연** 기본 상황(= 타이핑을 막 멈춘 순간).
// 목록이 열린 경우는 각 검사가 listOpen: true 로 덮어쓴다.
const S = (over: Partial<CompState> = {}): CompState => ({
  key: 'ArrowRight',
  ghost: true,
  items: 2,
  listOpen: false,
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

  it('목록 없이 고스트만 있어도 → 는 받는다', () => {
    expect(completionKey(S({ key: 'ArrowRight', items: 1 }))).toBe('accept')
  })
})

describe('completionKey — 목록에서의 Enter', () => {
  it('목록이 떠 있으면 Enter 는 고르기다 (셸로 가지 않는다)', () => {
    expect(completionKey(S({ key: 'Enter', listOpen: true }))).toBe('accept')
  })

  it('목록이 없으면 Enter 는 셸로 간다 — 고스트만 떠 있는 줄은 친 그대로 실행된다', () => {
    expect(completionKey(S({ key: 'Enter', items: 0 }))).toBe('pass')
    expect(completionKey(S({ key: 'Enter', items: 1 }))).toBe('pass')
  })

  it('🔴 #194 ①: 후보가 여럿이어도 **열지 않은** 목록은 Enter 를 안 가져간다', () => {
    // 예전 함정이 여기 있었다. `ls` 를 치면 히스토리의 `ls -la`·`ls -l` 로 목록이 **저절로** 떠서
    // 그 Enter 가 ls 를 실행하지 않고 `ls -la` 를 넣었다(Esc 를 먼저 눌러야 했다). 목록을
    // ↓ 로만 열게 된 지금, 열지 않은 사람의 Enter 는 언제나 친 그대로 실행된다.
    // ⚠️ 이 줄이 깨지면 판정이 items 로 되돌아간 것이다 — 함정이 함께 돌아온다.
    expect(completionKey(S({ key: 'Enter', items: 6, listOpen: false }))).toBe('pass')
  })

  it('고스트가 없으면 목록 값과 무관하게 Enter 는 셸로 간다', () => {
    expect(completionKey(S({ key: 'Enter', ghost: false, listOpen: true }))).toBe('pass')
  })

  it('🔴 탈출구: Esc 로 닫으면 그다음 Enter 는 친 그대로 실행된다', () => {
    // 이 두 줄이 위 동작의 안전장치 전부다. 막히면 목록이 뜬 줄은 실행할 방법이 없어진다.
    const open = S({ key: 'Escape', listOpen: true })
    expect(completionKey(open)).toBe('dismiss')
    // dismiss = TerminalPane 의 clearGhost — 고스트도 목록도 함께 지운다(ghostSuffix='' · compItems=[]).
    expect(completionKey({ ...open, key: 'Enter', ghost: false, items: 0, listOpen: false })).toBe('pass')
  })
})

describe('completionKey — #194 ① 목록은 ↓ 로만 연다', () => {
  it('후보가 둘 이상이면 ↓ 가 목록을 연다(고르기가 아니라 열기다)', () => {
    expect(completionKey(S({ key: 'ArrowDown', items: 2, listOpen: false }))).toBe('open')
  })

  it('열린 뒤의 ↓↑ 는 후보를 옮긴다', () => {
    expect(completionKey(S({ key: 'ArrowDown', listOpen: true }))).toBe('next')
    expect(completionKey(S({ key: 'ArrowUp', listOpen: true }))).toBe('prev')
  })

  it('🔴 셸 히스토리 탐색을 뺏지 않는다 — 고스트가 없으면 ↓↑ 는 언제나 셸로 간다', () => {
    // 셸 히스토리를 타는 순간 고스트는 이미 없다(↑ 는 ESC 시퀀스라 feedInput 이 줄 버퍼를 비운다).
    // 그래서 "히스토리를 오르내리는 중의 ↓↑" 는 전부 이 줄에 걸린다.
    expect(completionKey(S({ key: 'ArrowDown', ghost: false }))).toBe('pass')
    expect(completionKey(S({ key: 'ArrowUp', ghost: false }))).toBe('pass')
  })

  it('후보가 하나뿐이면 ↓ 도 셸로 간다 — 열어 봐야 고스트와 같은 말이다', () => {
    expect(completionKey(S({ key: 'ArrowDown', items: 1, listOpen: false }))).toBe('pass')
  })

  it('목록을 안 열었으면 ↑ 는 셸 히스토리 그대로다(고스트가 떠 있어도)', () => {
    expect(completionKey(S({ key: 'ArrowUp', items: 6, listOpen: false }))).toBe('pass')
  })
})

describe('completionKey — 기존 동작(회귀 방지)', () => {
  it('🔴 #194 ⑤: Tab 은 셸의 것이다 — 고스트가 떠 있어도 가로채지 않는다', () => {
    // 파일 이름 완성(`cd Doc<Tab>`)이 히스토리 제안보다 자주 필요하다. 받는 키는 → 가 맡는다.
    expect(completionKey(S({ key: 'Tab' }))).toBe('pass')
    expect(completionKey(S({ key: 'Tab', listOpen: true }))).toBe('pass')
    expect(completionKey(S({ key: 'Tab', ghost: false }))).toBe('pass')
  })

  it('Esc 는 빠져나갈 문이다 — 고스트가 있으면 닫고, 없으면 셸로(인터럽트)', () => {
    expect(completionKey(S({ key: 'Escape' }))).toBe('dismiss')
    expect(completionKey(S({ key: 'Escape', ghost: false }))).toBe('pass')
  })

  it('그 밖의 키(글자·←·Home)는 언제나 셸로 간다', () => {
    for (const key of ['a', 'ArrowLeft', 'Home', 'End', 'Backspace', ' ']) {
      expect(completionKey(S({ key }))).toBe('pass')
    }
  })
})
