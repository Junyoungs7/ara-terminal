// Gemini API 어댑터 — SSE 스트리밍(streamGenerateContent?alt=sse)까지는 openai/compatible 과 같지만,
// 키를 헤더가 아니라 쿼리 파라미터로 보내고 대화 role 명이 다르다("model" 이 아니라 "assistant" 아님).
// 이 차이가 별도 어댑터가 필요한 유일한 이유다(설계 지시 §2 — SSE 헬퍼는 그래도 공유한다).
import { AI_MODELS_BY_PROVIDER, type AiKeyResult } from '@shared/types'
import { fetchSse } from './sse'
import { ProviderError, type AiRequest, type ProviderAdapter, type StreamChunk } from './types'

const HOST = 'https://generativelanguage.googleapis.com/v1beta'

function toContents(req: AiRequest): { role: string; parts: { text: string }[] }[] {
  return req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
}

async function validate(key: string, model: string): Promise<AiKeyResult> {
  try {
    const res = await fetch(`${HOST}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(key)}`)
    // Gemini 는 401 관례를 안 쓴다 — 잘못된 키도 400(API_KEY_INVALID)으로 온다.
    if (res.status === 400 || res.status === 403) return { ok: false, reason: 'auth', message: 'API 키가 유효하지 않습니다' }
    if (res.status === 404) return { ok: false, reason: 'model', message: `모델을 찾을 수 없습니다: ${model}` }
    if (!res.ok) return { ok: false, reason: 'network', message: '키를 확인하지 못했습니다' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'network', message: '네트워크에 연결할 수 없습니다' }
  }
}

async function* stream(req: AiRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  const url = `${HOST}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toContents(req),
    generationConfig: { maxOutputTokens: req.maxTokens }
  }
  // ponytail: sse.ts 의 공용 상태 분류는 401/403/429/5xx 만 안다 — Gemini 의 400(API_KEY_INVALID)은
  // 여기서 걸러지지 않고 일반 'api' 로 나온다. 정밀 분류가 필요해지면 이 catch 에서 본문을 한 번 더 본다.
  for await (const data of fetchSse(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal)) {
    let json: Record<string, unknown>
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    if (json.error) {
      const e = json.error as { message?: string }
      throw new ProviderError('api', e.message ?? '일시적인 서버 오류입니다')
    }
    const candidates = json.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined
    const text = candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (text) yield { text }
    const um = json.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined
    if (um) yield { usage: { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0 } }
  }
}

export const googleAdapter: ProviderAdapter = {
  id: 'google',
  defaultModels: AI_MODELS_BY_PROVIDER.google,
  validate,
  stream
}
