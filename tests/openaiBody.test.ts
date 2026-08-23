// 2026-08-23 준영님 제보 — OpenAI 키를 넣고 채팅하니 **400 "요청이 거부되었습니다"**.
//
// 원인은 출력 상한 파라미터의 이름이었다. OpenAI 새 모델(gpt-5 계열)은 `max_tokens` 를 거부하고
// `max_completion_tokens` 를 요구한다. 반대로 사내 vLLM·Ollama·구형 게이트웨이는 새 이름을 모른다.
// 그래서 프로바이더로 첫 이름을 고르고, 그 이름 때문에 400 이 나면 반대 이름으로 한 번 더 보낸다.
//
// 이 파일이 지키는 것 둘: **이름을 하나만 보낸다**(둘 다 보내면 그것도 400 이다) ·
// **되돌릴 조건을 좁게 잡는다**(아무 400 에나 재시도하면 같은 요청을 두 번 청구한다).
import { describe, it, expect } from 'vitest'
import { chatBody, isTokenParamComplaint } from '../src/main/ai/providers/openaiCompatible'
import type { AiRequest } from '../src/main/ai/providers/types'

const req = (provider: 'openai' | 'compatible'): AiRequest => ({
  provider,
  apiKey: 'sk-test',
  model: provider === 'openai' ? 'gpt-5.1' : 'qwen2.5',
  system: '너는 아라다',
  messages: [{ role: 'user', content: '안녕' }],
  maxTokens: 4096,
  effort: 'medium',
  droppedTurns: 0,
  ...(provider === 'compatible' ? { baseUrl: 'http://192.168.0.10:8000/v1' } : {})
})

describe('출력 상한 파라미터 이름', () => {
  it('★ openai 는 새 이름(max_completion_tokens)으로 보낸다', () => {
    const body = chatBody(req('openai'), true)
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
  })

  it('★ 호환 엔드포인트는 옛 이름(max_tokens)으로 보낸다', () => {
    const body = chatBody(req('compatible'), false)
    expect(body.max_tokens).toBe(4096)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('★ 두 이름을 함께 싣지 않는다 — 같이 보내면 그것도 400 이다', () => {
    for (const useNew of [true, false]) {
      const keys = Object.keys(chatBody(req('openai'), useNew)).filter((k) => k.startsWith('max'))
      expect(keys).toHaveLength(1)
    }
  })

  it('나머지 몸통은 이름과 무관하게 같다', () => {
    const a = chatBody(req('openai'), true)
    const b = chatBody(req('openai'), false)
    expect(a.model).toBe(b.model)
    expect(a.stream).toBe(true)
    expect(a.messages).toEqual(b.messages)
    // system 은 messages 의 첫 줄로 들어간다(별도 필드가 아니다).
    expect((a.messages as { role: string }[])[0].role).toBe('system')
  })
})

describe('되돌릴 조건', () => {
  it('★ 상한 이름을 탓하는 400 에서만 다시 보낸다', () => {
    expect(
      isTokenParamComplaint("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
    ).toBe(true)
    expect(isTokenParamComplaint('Unrecognized request argument supplied: max_completion_tokens')).toBe(true)
  })

  it('★ 다른 이유의 400 은 그대로 사용자에게 보인다(조용한 재시도 금지)', () => {
    expect(isTokenParamComplaint('The model `gpt-9` does not exist')).toBe(false)
    expect(isTokenParamComplaint('Invalid schema for tools[0]')).toBe(false)
    expect(isTokenParamComplaint('요청이 거부되었습니다 (400)')).toBe(false)
  })
})
