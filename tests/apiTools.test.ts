/**
 * API 엔진 function calling(2026-08-26 준영님 요청 — *"도구를 연결할 수는 없을까?"*).
 *
 * **문이 둘뿐이라 가능했다**(ara_tools·ara_call). 28개를 그대로 노출했다면 프로바이더마다 스키마를
 * 변환해야 했고, 요청마다 28개분이 토큰으로 나갔을 것이다.
 *
 * 여기서 보는 것은 **루프**다: 모델이 도구를 부르면 실행하고 결과를 되먹여 다시 묻는다. 상한(10)에
 * 걸리면 조용히 더 쓰지 않고 사용자에게 넘긴다 — 왕복마다 과금이라 그 결정은 사람 몫이다.
 */
import { describe, it, expect } from 'vitest'
import { AraSession, type SessionTools } from '../src/main/ai/AraSession'
import { chatBody } from '../src/main/ai/providers/openaiCompatible'
import type { AiRequest, ProviderAdapter, StreamChunk, ToolCall } from '../src/main/ai/providers'
import type { AiEnd, AiProvider } from '../src/shared/types'

const vault = { get: () => 'k-test', set: () => {}, delete: () => {}, has: () => true }
const prefs = () => ({ provider: 'openai' as AiProvider, model: 'gpt-5', baseUrl: undefined })

/** 정해진 대본대로 답하는 가짜 프로바이더 — 라운드마다 무엇을 흘릴지 미리 적어 둔다. */
function scripted(script: (StreamChunk[] | 'text')[]): { adapter: ProviderAdapter; seen: AiRequest[] } {
  const seen: AiRequest[] = []
  let round = 0
  const adapter: ProviderAdapter = {
    id: 'openai',
    defaultModels: ['gpt-5'],
    validate: async () => ({ ok: true }),
    async *stream(req) {
      seen.push(req)
      const step = script[Math.min(round++, script.length - 1)]
      if (step === 'text') {
        yield { text: '끝났습니다.' }
        return
      }
      for (const c of step) yield c
    }
  }
  return { adapter, seen }
}

const call = (id: string, name = 'ara_call', args = '{"tool":"session_list"}'): ToolCall => ({ id, name, args })

function makeTools(): { tools: SessionTools; ran: string[] } {
  const ran: string[] = []
  return {
    ran,
    tools: {
      specs: [{ name: 'ara_tools', description: 'd', parameters: {} }, { name: 'ara_call', description: 'd', parameters: {} }],
      run: async (name, argsJson) => {
        ran.push(`${name}:${argsJson}`)
        return '세션 1개'
      }
    }
  }
}

function run(adapter: ProviderAdapter, tools?: SessionTools): Promise<{ text: string; end: AiEnd }> {
  return new Promise((resolve) => {
    let text = ''
    const s = new AraSession(
      vault,
      prefs,
      { delta: (_id, t) => (text += t), end: (e) => resolve({ text, end: e }) },
      adapter,
      tools
    )
    s.send({ text: '세션 목록 봐 줘' })
  })
}

describe('툴 루프', () => {
  it('★ 도구를 부르면 실행하고 결과를 되먹여 다시 묻는다', async () => {
    const { adapter, seen } = scripted([[{ toolCalls: [call('c1')] }], 'text'])
    const { tools, ran } = makeTools()
    const { text, end } = await run(adapter, tools)

    expect(ran).toEqual(['ara_call:{"tool":"session_list"}'])
    expect(text).toBe('끝났습니다.')
    expect(end.ok).toBe(true)
    // 두 번째 요청에 **부른 것과 돌려준 것이 짝으로** 실린다 — 짝이 안 맞으면 API 가 400 을 낸다.
    expect(seen).toHaveLength(2)
    expect(seen[1].toolTurns?.[0].calls[0].id).toBe('c1')
    expect(seen[1].toolTurns?.[0].results[0]).toEqual({ callId: 'c1', name: 'ara_call', content: '세션 1개' })
  })

  it('★ 상한에서 멈추고 사용자에게 넘긴다 — 왕복마다 과금이라 그 결정은 사람 몫이다', async () => {
    // 계속 도구만 부르는 모델(멈추지 않는 판).
    const { adapter, seen } = scripted([[{ toolCalls: [call('c')] }]])
    const { tools, ran } = makeTools()
    const { text, end } = await run(adapter, tools)

    expect(ran).toHaveLength(9) // 10번째 요청에서 멈춘다(그 답의 도구는 실행하지 않는다)
    expect(seen).toHaveLength(10)
    expect(text).toContain('도구를 10번 썼습니다')
    expect(end.ok).toBe(true) // 오류가 아니다 — 사람이 이어 갈 수 있다
  })

  it('도구를 안 주면 예전과 똑같이 한 바퀴에 끝난다', async () => {
    const { adapter, seen } = scripted(['text'])
    const { text } = await run(adapter)
    expect(text).toBe('끝났습니다.')
    expect(seen).toHaveLength(1)
    expect(seen[0].tools).toBeUndefined()
  })

  it('도구를 주면 요청에 스키마가 실린다(모델이 무엇을 부를 수 있는지 안다)', async () => {
    const { adapter, seen } = scripted(['text'])
    const { tools } = makeTools()
    await run(adapter, tools)
    expect(seen[0].tools?.map((t) => t.name)).toEqual(['ara_tools', 'ara_call'])
  })
})

describe('OpenAI 요청 조립', () => {
  const base: AiRequest = {
    provider: 'openai',
    apiKey: 'k',
    model: 'gpt-5',
    maxTokens: 100,
    effort: 'medium' as never,
    system: 'sys',
    messages: [{ role: 'user', content: '안녕' }],
    droppedTurns: 0
  }

  it('★ 도구 왕복이 assistant(tool_calls) + tool 메시지 짝으로 실린다', () => {
    const body = chatBody(
      {
        ...base,
        tools: [{ name: 'ara_call', description: 'd', parameters: { type: 'object' } }],
        toolTurns: [{ calls: [call('c1')], results: [{ callId: 'c1', name: 'ara_call', content: '세션 1개' }] }]
      },
      true
    )
    const msgs = body.messages as { role: string; tool_calls?: unknown[]; tool_call_id?: string }[]
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(msgs[2].tool_calls).toHaveLength(1)
    expect(msgs[3].tool_call_id).toBe('c1')
    expect((body.tools as { function: { name: string } }[])[0].function.name).toBe('ara_call')
  })

  it('도구가 없으면 tools 키 자체가 없다 — 옛 게이트웨이가 모르는 필드로 400 을 내지 않게', () => {
    expect(chatBody(base, true).tools).toBeUndefined()
  })
})
