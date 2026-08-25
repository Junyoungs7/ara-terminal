// #139b 켤 때 뜨는 한 줄 — 매번 다르게. 규칙을 화면 없이 시험하려고 무작위·시각을 주입받는다
// (안 그러면 눈으로 스무 번 켜 보는 수밖에 없다).
import { describe, it, expect } from 'vitest'
import { greetText, pickGreeting } from '../src/shared/bootGreeting'

/** 정해진 값을 순서대로 내주는 가짜 무작위. */
const seq = (...vals: number[]) => {
  let i = 0
  return () => vals[i++ % vals.length]!
}

describe('시각을 탄다', () => {
  const at = (hour: number) => greetText(pickGreeting({ name: '준영', hour, rand: seq(0.1, 0) }), '준영님')

  it('★ 새벽 세 시에 "좋은 아침"이라고 하지 않는다 — 화면이 사람을 안 보고 있는 것이다', () => {
    expect(at(3)).toContain('아직 안 주무셨군요')
    expect(at(8)).toContain('좋은 아침')
    expect(at(15)).toContain('오후')
    expect(at(20)).toContain('수고')
    expect(at(23)).toContain('늦게까지')
  })

  it('호칭이 자리에 들어간다', () => {
    expect(at(8)).toContain('준영님')
    expect(at(8)).not.toContain('{n}')
  })

  it('★ 시간대마다 여러 개 — 하나뿐이면 아침마다 같은 줄이라 랜덤이 무색해진다', () => {
    const morning = new Set([0, 0.4, 0.8].map((r) => greetText(pickGreeting({ name: '준영', hour: 8, rand: seq(0.1, r) }), '준영님')))
    expect(morning.size).toBeGreaterThan(1)
  })
})

describe('세 갈래를 섞는다', () => {
  it('낮은 값 = 인사 · 가운데 = 반가움 · 높은 값 = 명언', () => {
    expect(pickGreeting({ name: '준영', hour: 8, rand: seq(0.1, 0) }).by).toBeUndefined()
    expect(pickGreeting({ name: '준영', hour: 8, rand: seq(0.5, 0) }).text).toContain('{n}')
    const q = pickGreeting({ name: '준영', hour: 8, rand: seq(0.9, 0) })
    expect(q.by).toBeTruthy() // 명언에는 출처가 있다
  })

  it('★ 이름이 없으면 명언만 — "Welcome, " 처럼 꼬리가 남는 줄을 안 낸다', () => {
    for (const r of [0.1, 0.5, 0.9]) {
      const g = pickGreeting({ name: '', hour: 8, rand: seq(r, 0.3) })
      expect(g.text).not.toContain('{n}')
      expect(g.by).toBeTruthy()
    }
  })

  it('★ 직전과 같은 줄이면 한 번 다시 뽑는다 — 두 번 연속 같으면 랜덤으로 안 느껴진다', () => {
    const first = pickGreeting({ name: '준영', hour: 8, rand: seq(0.1, 0) })
    // 인사 갈래도 rand 를 두 번 쓴다(갈래 고르기 + 그 시간대 안에서 고르기).
    const second = pickGreeting({ name: '준영', hour: 8, rand: seq(0.1, 0, 0.5, 0), avoid: first.text })
    expect(second.text).not.toBe(first.text)
  })

  it('그래도 같으면 그냥 낸다 — 무한 루프를 만들지 않는다', () => {
    const g = pickGreeting({ name: '준영', hour: 8, rand: () => 0, avoid: '좋은 아침입니다, {n}' })
    expect(g.text).toBe('좋은 아침입니다, {n}')
  })
})

describe('★ 출처를 지어내지 않는다', () => {
  it('명언에는 전부 출처가 붙어 있다(없으면 속담으로 적었다)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const g = pickGreeting({ name: '', hour: 8, rand: () => i / 200 })
      expect(g.by, g.text).toBeTruthy()
      seen.add(g.text)
    }
    expect(seen.size).toBeGreaterThan(3) // 한 줄만 계속 나오지 않는다
  })
})
