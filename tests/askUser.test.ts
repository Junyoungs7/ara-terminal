// #125 1단계 — **AI 가 사람에게 되묻는 길**(`ask_user`).
//
// 왜 우리가 만드나: 헤드리스 Claude Code 에는 되묻는 도구가 없다(2026-08-24 실측 — `AskUserQuestion`·
// `ExitPlanMode` 가 도구 목록에 안 들어온다). MCP 도구는 우리가 정의하니 헤드리스에서도 동작한다.
//
// 이 파일이 지키는 것 넷: 답할 때까지 기다린다 · 한없이 기다리지 않는다 · 질문 폭탄을 막는다 ·
// 늦게 온 답과 닫힌 대화를 조용히 흘린다.
import { describe, it, expect, vi } from 'vitest'
import { createAskUser, ASK_MAX_PENDING, type AskRequest } from '../src/main/mcp/askUser'

const rig = (timeoutMs = 1000) => {
  const asked: AskRequest[] = []
  const done: string[] = []
  const m = createAskUser({ ask: (r) => asked.push(r), askDone: (id) => done.push(id) }, timeoutMs)
  return { m, asked, done }
}

describe('되묻기', () => {
  it('★ 사람이 답할 때까지 기다린다 — 그게 되묻기의 정의다', async () => {
    const { m, asked } = rig()
    const p = m.ask({ question: '어느 서버에 배포할까요?', options: ['dev', 'prod'] })
    expect(asked).toHaveLength(1)
    expect(asked[0].question).toBe('어느 서버에 배포할까요?')
    expect(asked[0].options).toEqual(['dev', 'prod'])
    // 아직 안 끝났다.
    let settled = false
    void p.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    m.answer(asked[0].askId, 'dev')
    expect(await p).toBe('dev')
  })

  it('선택지 없이도 묻는다(자유 입력) · 빈 항목은 버린다', async () => {
    const { m, asked } = rig()
    const p = m.ask({ question: '이름을 정해 주세요', options: ['', '  '] })
    expect(asked[0].options).toEqual([])
    m.answer(asked[0].askId, 'vgt-erp')
    expect(await p).toBe('vgt-erp')
  })

  it('★ 한없이 기다리지 않는다 — 시간이 지나면 답 못 받음(null)', async () => {
    vi.useFakeTimers()
    const { m, asked, done } = rig(1000)
    const p = m.ask({ question: '진행할까요?' })
    vi.advanceTimersByTime(1001)
    expect(await p).toBeNull()
    // 화면도 카드를 접을 수 있게 알려 준다.
    expect(done).toEqual([asked[0].askId])
    expect(m.pending()).toEqual([])
    vi.useRealTimers()
  })

  it('★ 질문 폭탄을 막는다 — 동시에 열어 둘 수 있는 수를 넘으면 즉시 거절', async () => {
    const { m } = rig(60_000)
    const open = Array.from({ length: ASK_MAX_PENDING }, (_, i) => m.ask({ question: `q${i}` }))
    expect(m.pending()).toHaveLength(ASK_MAX_PENDING)
    // 한 개 더 — 기다리지 않고 바로 null(도구가 "답 못 받음"으로 돌려준다).
    expect(await m.ask({ question: '하나 더' })).toBeNull()
    m.clear()
    expect(await Promise.all(open)).toEqual(Array(ASK_MAX_PENDING).fill(null))
  })

  it('늦게 온 답·없는 id 는 조용히 버린다(예외 없이)', async () => {
    const { m, asked } = rig()
    const p = m.ask({ question: 'q' })
    m.answer(asked[0].askId, '첫 답')
    expect(await p).toBe('첫 답')
    expect(() => m.answer(asked[0].askId, '두 번째')).not.toThrow()
    expect(() => m.answer('없는-id', 'x')).not.toThrow()
  })

  it('★ 대화를 닫으면 기다리는 것을 모두 닫는다 — 유령 대기 금지', async () => {
    const { m, done } = rig(60_000)
    const a = m.ask({ question: 'a' })
    const b = m.ask({ question: 'b' })
    m.clear()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(done).toHaveLength(2)
    expect(m.pending()).toEqual([])
  })

  it('화면이 다시 그릴 때 쓰는 목록에 만료 시각이 들어 있다', () => {
    const { m } = rig(60_000)
    void m.ask({ question: 'q', options: ['1', '2'], multi: true })
    const [r] = m.pending()
    expect(r.multi).toBe(true)
    expect(r.expiresAt).toBeGreaterThan(Date.now())
  })
})
