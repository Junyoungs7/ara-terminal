// Anthropic 어댑터 — F16 원안 그대로(§1 "왜 SDK 인가": raw fetch 대신 검증된 SDK 를 쓴다). 여기 외에
// SDK 를 import 하는 곳은 없다(렌더러는 물론 main 다른 모듈에도 없다 — grep 으로 확인 가능해야 한다).
// 요청/응답 바디를 로깅하지 않고 ANTHROPIC_LOG 도 설정하지 않는다(보안 체크리스트 §9).
import Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk'
import { AI_MODELS_BY_PROVIDER, type AiKeyResult } from '@shared/types'
import { ProviderError, type AiRequest, type ProviderAdapter, type StreamChunk } from './types'

async function validate(key: string, model: string): Promise<AiKeyResult> {
  try {
    await new Anthropic({ apiKey: key }).models.retrieve(model)
    return { ok: true }
  } catch (err) {
    if (err instanceof AuthenticationError) return { ok: false, reason: 'auth', message: 'API 키가 유효하지 않습니다' }
    if (err instanceof APIConnectionError) return { ok: false, reason: 'network', message: '네트워크에 연결할 수 없습니다' }
    if (err instanceof APIError && err.status === 404) return { ok: false, reason: 'model', message: `모델을 찾을 수 없습니다: ${model}` }
    return { ok: false, reason: 'network', message: '키를 확인하지 못했습니다' }
  }
}

async function* stream(req: AiRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  const client = new Anthropic({ apiKey: req.apiKey })
  try {
    const s = client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        output_config: { effort: req.effort },
        messages: req.messages
      },
      { signal }
    )
    for await (const event of s) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { text: event.delta.text }
    }
    const final = await s.finalMessage()
    yield { usage: { input: final.usage.input_tokens, output: final.usage.output_tokens } }
  } catch (err) {
    // 분기 순서가 중요하다: APIConnectionError 는 APIError 의 하위 클래스라 뒤에 두면 잡히지 않는다.
    if (err instanceof AuthenticationError) throw new ProviderError('auth', 'API 키가 유효하지 않습니다')
    if (err instanceof RateLimitError) throw new ProviderError('rateLimit', '요청이 많습니다. 잠시 후 다시 시도하세요.')
    if (err instanceof APIConnectionError) throw new ProviderError('network', '네트워크에 연결할 수 없습니다')
    if (err instanceof APIError) throw new ProviderError('api', '일시적인 서버 오류입니다')
    throw err // 사용자 중단(abort) 등 — AraSession.run() 이 signal.aborted 를 먼저 검사한다.
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  defaultModels: AI_MODELS_BY_PROVIDER.anthropic,
  validate,
  stream
}
