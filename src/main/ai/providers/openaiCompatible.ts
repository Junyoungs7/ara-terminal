// OpenAI Chat Completions 호환 포맷 — openai·compatible 두 프로바이더가 같은 와이어 포맷을 쓴다
// (compatible 이 커버하는 Azure OpenAI·OpenRouter·사내 게이트웨이·Ollama/vLLM 도 이 포맷이다). 어댑터를
// 하나 더 늘리는 대신 함수를 공유하고 얇은 래퍼 두 개만 내보낸다(설계 지시 — SDK 추가 없이 fetch+SSE 공유).
import { AI_MODELS_BY_PROVIDER, type AiKeyResult } from '@shared/types'
import { joinUrl, validateBaseUrl } from '@shared/aiBaseUrl'
import { fetchSse } from './sse'
import { ProviderError, type AiRequest, type ProviderAdapter, type StreamChunk } from './types'

const OPENAI_HOST = 'https://api.openai.com/v1'

// compatible 은 req.baseUrl(사용자 입력, 이미 저장 시점에 검증됐다)을 쓴다. 여기가 **실제 방어선**이다
// (설계 §보안 — 저장 시점 검증은 UX 편의고, 전송 직전 재검증이 렌더러 손상 시나리오를 막는다).
function resolveBase(req: AiRequest): string {
  if (req.provider !== 'compatible') return OPENAI_HOST
  const v = validateBaseUrl(req.baseUrl ?? '')
  if (!v.ok) throw new ProviderError('network', v.message)
  return v.url.toString().replace(/\/+$/, '')
}

async function validate(key: string, model: string, baseUrl?: string): Promise<AiKeyResult> {
  let base = OPENAI_HOST
  if (baseUrl !== undefined) {
    const v = validateBaseUrl(baseUrl)
    if (!v.ok) return { ok: false, reason: 'network', message: v.message }
    base = v.url.toString().replace(/\/+$/, '')
  }
  try {
    const res = await fetch(joinUrl(base, `models/${encodeURIComponent(model)}`), {
      headers: { Authorization: `Bearer ${key}` }
    })
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', message: 'API 키가 유효하지 않습니다' }
    // 호환 엔드포인트(vLLM·구형 게이트웨이 등)는 /models/{id} 단건 조회를 흔히 구현하지 않는다 —
    // 404 만으로 키가 틀렸다 단정하지 않는다(모델명 오타는 첫 전송에서 자연히 드러난다).
    if (res.status === 404) return { ok: true }
    if (!res.ok) return { ok: false, reason: 'network', message: '키를 확인하지 못했습니다' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'network', message: '네트워크에 연결할 수 없습니다' }
  }
}

function chatBody(req: AiRequest): Record<string, unknown> {
  return {
    model: req.model,
    stream: true,
    max_tokens: req.maxTokens,
    messages: [{ role: 'system', content: req.system }, ...req.messages]
  }
}

async function* stream(req: AiRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  const base = resolveBase(req)
  let usage: { input: number; output: number } | null = null
  for await (const data of fetchSse(
    joinUrl(base, 'chat/completions'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(chatBody(req))
    },
    signal
  )) {
    let json: Record<string, unknown>
    try {
      json = JSON.parse(data)
    } catch {
      continue // 깨진 프레임은 빈 델타와 동치로 건너뛴다
    }
    if (json.error) {
      const e = json.error as { message?: string } | string
      throw new ProviderError('api', typeof e === 'string' ? e : e.message ?? '일시적인 서버 오류입니다')
    }
    const choices = json.choices as { delta?: { content?: string } }[] | undefined
    const delta = choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) yield { text: delta }
    const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    if (u) usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 }
  }
  if (usage) yield { usage }
}

function makeAdapter(id: 'openai' | 'compatible'): ProviderAdapter {
  return { id, defaultModels: AI_MODELS_BY_PROVIDER[id], validate, stream }
}

export const openaiAdapter = makeAdapter('openai')
export const compatibleAdapter = makeAdapter('compatible')
