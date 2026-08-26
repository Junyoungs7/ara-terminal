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

/**
 * 출력 길이 상한을 어느 이름으로 보낼 것인가 — **여기가 2026-08-23 400 오류의 자리다.**
 *
 * OpenAI 는 새 모델(gpt-5 계열·o 시리즈)에서 `max_tokens` 를 **거부한다**:
 * "Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead" → HTTP 400.
 * 반대로 사내 vLLM·Ollama·구형 게이트웨이는 `max_completion_tokens` 를 모른다.
 *
 * 그래서 **처음 시도는 프로바이더로 고르고**(openai → 새 이름, compatible → 옛 이름),
 * 그 이름 때문에 400 이 나면 **반대 이름으로 딱 한 번 다시 보낸다**(아래 stream).
 * 서버의 나이를 우리가 알 방법이 없으니, 물어보는 대신 한 번 더 두드린다.
 */
export function chatBody(req: AiRequest, newParamName: boolean): Record<string, unknown> {
  /**
   * 도구 왕복을 대화에 이어 붙인다(2026-08-26). OpenAI 형식은 **assistant 가 tool_calls 를 들고**
   * 그 뒤에 `role:'tool'` 메시지가 **호출 하나당 하나씩** 온다 — 짝이 안 맞으면 400 이다.
   */
  const toolMsgs: Record<string, unknown>[] = []
  for (const t of req.toolTurns ?? []) {
    toolMsgs.push({
      role: 'assistant',
      content: null,
      tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
    })
    for (const r of t.results) toolMsgs.push({ role: 'tool', tool_call_id: r.callId, content: r.content })
  }
  return {
    model: req.model,
    stream: true,
    [newParamName ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    messages: [{ role: 'system', content: req.system }, ...req.messages, ...toolMsgs],
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters }
          }))
        }
      : {})
  }
}

/** 400 의 사유가 "그 이름을 못 쓴다"인가. 이때만 반대 이름으로 다시 보낸다. */
export function isTokenParamComplaint(message: string): boolean {
  return /max_tokens|max_completion_tokens/i.test(message)
}

async function* stream(req: AiRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  const base = resolveBase(req)
  let usage: { input: number; output: number } | null = null
  // openai 는 새 이름부터, 그 밖(사내 게이트웨이 등)은 옛 이름부터.
  const newParam = req.provider === 'openai'
  const open = (useNew: boolean): AsyncGenerator<string> =>
    fetchSse(
      joinUrl(base, 'chat/completions'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(chatBody(req, useNew))
      },
      signal
    )

  /**
   * 첫 프레임까지 당겨 본 스트림을 돌려준다. 400 이 오면 이름을 바꿔 딱 한 번 다시 연다.
   *
   * ⚠️ 앞서 여기서 한 번 자빠졌다: 이어 붙이는 제너레이터 안에서 **바깥 변수**를 `yield*` 했더니
   * 그 변수가 이미 자기 자신을 가리켜 무한 위임으로 멈췄다(테스트 넷이 5초 타임아웃).
   * 원본은 반드시 **따로 잡아 둔 const** 로 넘긴다.
   */
  const openWithFallback = async (): Promise<AsyncGenerator<string>> => {
    const join = (src: AsyncGenerator<string>, head: IteratorResult<string>): AsyncGenerator<string> =>
      (async function* () {
        if (!head.done) yield head.value
        yield* src
      })()
    const first = open(newParam)
    try {
      return join(first, await first.next())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isTokenParamComplaint(msg) || signal.aborted) throw err
      const second = open(!newParam)
      return join(second, await second.next())
    }
  }

  // index → 모으는 중인 호출. 스트림이 끝나야 온전해진다.
  const calls = new Map<number, { id: string; name: string; args: string }>()
  for await (const data of await openWithFallback()) {
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
    const choices = json.choices as
      | { delta?: { content?: string; tool_calls?: OpenAiToolDelta[] } }[]
      | undefined
    const delta = choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) yield { text: delta }
    // 도구 호출은 **조각으로** 온다: index 별로 id·name 이 먼저, arguments 가 여러 프레임에 나뉘어.
    for (const tc of choices?.[0]?.delta?.tool_calls ?? []) {
      const at = tc.index ?? 0
      const cur = calls.get(at) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name = tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(at, cur)
    }
    const u = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    if (u) usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 }
  }
  if (calls.size) yield { toolCalls: [...calls.values()].filter((c) => c.name) }
  if (usage) yield { usage }
}

/** OpenAI 의 tool_calls 델타 한 조각. arguments 는 이어 붙여야 온전한 JSON 이 된다. */
type OpenAiToolDelta = { index?: number; id?: string; function?: { name?: string; arguments?: string } }

function makeAdapter(id: 'openai' | 'compatible'): ProviderAdapter {
  return { id, defaultModels: AI_MODELS_BY_PROVIDER[id], validate, stream }
}

export const openaiAdapter = makeAdapter('openai')
export const compatibleAdapter = makeAdapter('compatible')
