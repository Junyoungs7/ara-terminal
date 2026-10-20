// 신고 #26 — 채팅을 열자마자 사용률. `claude -p "/usage"`(모델 호출 없음) 글 파서 + "실응답 값이 먼저면 덮지 않음".
import { describe, it, expect } from 'vitest'
import { parseUsageOutput, type AiEngine, type AiEngineEvent, type AiLimit } from '../src/shared/aiEngine'
import { createAraChat, type AraChatEvent } from '../src/main/ai/AraChat'
import type { McpServerHandle } from '../src/main/mcp/McpServer'

// 2026-10-20 실측 글(2.1.300).
const REAL = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 37% used · resets Oct 20, 6:29pm (Asia/Seoul)',
  'Current week (all models): 24% used · resets Oct 25, 7:59pm (Asia/Seoul)',
  'Current week (Fable): 0% used · resets Oct 25, 8pm (Asia/Seoul)'
].join('\n')

describe('/usage 파서', () => {
  const now = new Date(2026, 9, 20, 15, 0)
  it('실측 글 — 5시간·주간, 재설정은 이 PC 지역 시간', () => {
    expect(parseUsageOutput(REAL, now)).toEqual({
      five: { pct: 37, resetsAt: new Date(2026, 9, 20, 18, 29).getTime() },
      week: { pct: 24, resetsAt: new Date(2026, 9, 25, 19, 59).getTime() }
    })
  })
  it('--output-format json 의 result 를 읽는다(뒤에 딴 줄이 붙어도)', () => {
    const out = JSON.stringify({ type: 'result', result: REAL, total_cost_usd: 0 }) + '\nSessionEnd hook failed'
    expect(parseUsageOutput(out, now)?.five?.pct).toBe(37)
  })
  it('분 없는 꼴 "8pm" · 12am/12pm', () => {
    const t = 'Current session: 5% used · resets Oct 25, 8pm\nCurrent week (all models): 1% used · resets Oct 21, 12am'
    expect(parseUsageOutput(t, now)).toEqual({
      five: { pct: 5, resetsAt: new Date(2026, 9, 25, 20, 0).getTime() },
      week: { pct: 1, resetsAt: new Date(2026, 9, 21, 0, 0).getTime() }
    })
    expect(parseUsageOutput('Current session: 5% used · resets Oct 21, 12pm', now)?.five?.resetsAt).toBe(
      new Date(2026, 9, 21, 12, 0).getTime()
    )
  })
  it('연말 넘김 — 지난 날짜면 다음 해', () => {
    const dec = new Date(2026, 11, 30, 22, 0)
    expect(parseUsageOutput('Current session: 9% used · resets Jan 2, 3:05am', dec)?.five?.resetsAt).toBe(
      new Date(2027, 0, 2, 3, 5).getTime()
    )
  })
  it('시각을 못 읽으면 % 만, 둘 다 못 읽으면 null', () => {
    expect(parseUsageOutput('Current week (all models): 24% used · resets soon', now)).toEqual({
      five: null,
      week: { pct: 24, resetsAt: null }
    })
    expect(parseUsageOutput('Total cost: $0.0000', now)).toBeNull()
    expect(parseUsageOutput('{"result":', now)).toBeNull()
    expect(parseUsageOutput('', now)).toBeNull()
  })
})

describe('열면 한도 조회', () => {
  const setup = () => {
    const seen: AraChatEvent[] = []
    const subs = new Set<(e: AiEngineEvent) => void>()
    const eng = {
      send: () => {},
      respondPermission: () => {},
      setMode: () => {},
      setModel: () => {},
      interrupt: () => {},
      dispose: () => {},
      onEvent: (fn: (e: AiEngineEvent) => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      }
    } as AiEngine
    let resolve: (v: { five: AiLimit | null; week: AiLimit | null } | null) => void = () => {}
    let calls = 0
    const server: McpServerHandle = {
      setEnabled: async () => ({ ok: true as const, port: 39217 }),
      isEnabled: () => true,
      port: () => 39217,
      connectedCount: () => 0,
      disconnectClient: () => {},
      disconnectSelf: () => {},
      stop: async () => {}
    }
    const chat = createAraChat({
      server,
      vault: { get: () => null, set: () => {}, has: () => false, delete: () => {} } as never,
      activeSession: () => null,
      lastLocalCwd: () => null,
      araCwd: () => '/ara',
      emit: (e) => seen.push(e),
      makeEngine: () => eng,
      probeUsage: () => {
        calls++
        return new Promise((r) => (resolve = r))
      }
    })
    return { chat, seen, fire: (e: AiEngineEvent) => [...subs].forEach((f) => f(e)), done: (v: Parameters<typeof resolve>[0]) => resolve(v), calls: () => calls }
  }
  const lim = { five: { pct: 10, resetsAt: null }, week: null }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('결과가 오면 limits 사건으로 보낸다 · 진행 중이면 또 안 돈다', async () => {
    const s = setup()
    await s.chat.open()
    await s.chat.open()
    expect(s.calls()).toBe(1)
    s.done(lim)
    await flush()
    expect(s.seen.filter((e) => e.t === 'limits')).toEqual([{ t: 'limits', ...lim }])
  })

  it('★ 그 사이 실응답 한도가 먼저 왔으면 덮지 않는다', async () => {
    const s = setup()
    await s.chat.open()
    s.fire({ t: 'limits', five: { pct: 50, resetsAt: 1 }, week: null })
    s.done(lim)
    await flush()
    expect(s.seen.filter((e) => e.t === 'limits')).toEqual([{ t: 'limits', five: { pct: 50, resetsAt: 1 }, week: null }])
  })
})
