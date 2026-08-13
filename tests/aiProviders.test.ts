// 어댑터 계층 단위 테스트(W5) — SSE 파싱·재시도/타임아웃·base URL 검증·프로바이더별 요청 조립(마스킹
// 포함). AraSession 레벨 테스트(대화 상태·마스킹 강제·키 센티널·오류 분류 전달)는 tests/ai.test.ts.
// ⚠️ 실 네트워크 호출 없음 — global fetch·@anthropic-ai/sdk 를 전부 목킹한다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthenticationError, APIConnectionError } from '@anthropic-ai/sdk'
import { buildRequestCore } from '../src/main/ai/prompt'
import { fetchSse } from '../src/main/ai/providers/sse'
import { anthropicAdapter } from '../src/main/ai/providers/anthropic'
import { openaiAdapter, compatibleAdapter } from '../src/main/ai/providers/openaiCompatible'
import { googleAdapter } from '../src/main/ai/providers/google'
import { PROVIDERS, ProviderError, type AiRequest } from '../src/main/ai/providers'
import { joinUrl, validateBaseUrl } from '../src/shared/aiBaseUrl'
import { AI_PROVIDERS } from '../src/shared/types'

const encoder = new TextEncoder()

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
}

// 진짜 Headers/body 를 쓴다(손으로 만든 {get(){}} 더미는 SDK 가 내부적으로 부르는 .entries() 등에서
// "not a function" 으로 터진다 — Anthropic SDK 재현으로 확인한 실제 함정. Response 도 실제 전역을 쓴다.
function fakeRes(opts: { status?: number; chunks?: string[]; headers?: Record<string, string> }): Response {
  const status = opts.status ?? 200
  return new Response(opts.chunks ? sseBody(opts.chunks) : null, { status, headers: new Headers(opts.headers ?? {}) })
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

async function collectErr(it: AsyncIterable<unknown>): Promise<unknown> {
  try {
    for await (const _ of it) void _
    return null
  } catch (err) {
    return err
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validateBaseUrl — 허용/거부 표 (설계 W5 §보안)', () => {
  const cases: [string, boolean][] = [
    ['https://api.openai.com/v1', true],
    ['https://openrouter.ai/api/v1', true],
    ['http://127.0.0.1:11434/v1', true], // 로컬 LLM(Ollama 등) — loopback 은 http 허용
    ['http://localhost:8080/v1', true],
    ['http://example.com/v1', false], // 비-loopback http 거부
    ['ftp://example.com', false], // 스킴 거부
    ['file:///etc/passwd', false],
    ['https://user:pass@example.com/v1', false], // 자격증명 URL 거부
    ['not a url', false],
    ['', false]
  ]
  for (const [raw, expectOk] of cases) {
    it(`${raw || '(빈 문자열)'} → ${expectOk ? '허용' : '거부'}`, () => {
      expect(validateBaseUrl(raw).ok).toBe(expectOk)
    })
  }
})

describe('joinUrl — 경로 접합(경로 조작 방지)', () => {
  it('base 끝 슬래시·suffix 앞 슬래시를 정규화해 한 번만 남긴다', () => {
    expect(joinUrl('https://api.openai.com/v1/', '/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
    expect(joinUrl('https://api.openai.com/v1', 'chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
  })
})

describe('PROVIDERS 함수 테이블', () => {
  it('AI_PROVIDERS 4개 전부 등록되어 있고 id 가 일치한다', () => {
    for (const p of AI_PROVIDERS) expect(PROVIDERS[p].id).toBe(p)
  })
})

describe('fetchSse — SSE 파싱 (부분 청크·빈 델타·중간 오류)', () => {
  it('프레임이 여러 청크로 쪼개져 와도 온전히 이어붙여 파싱한다(부분 청크)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ chunks: ['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'] })))
    const out = await collect(fetchSse('https://x', {}, new AbortController().signal))
    expect(out).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('빈 델타(data: {}) 도 그대로 한 건으로 낸다 — 델타 유무 판정은 어댑터 몫', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ chunks: ['data: {}\n\ndata: [DONE]\n\n'] })))
    const out = await collect(fetchSse('https://x', {}, new AbortController().signal))
    expect(out).toEqual(['{}']) // [DONE] 은 건너뛴다
  })

  it('중간에 섞인 깨진/빈 줄은 무시하고 유효한 data 줄만 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ chunks: [': keep-alive\n\ndata: {"ok":true}\n\n'] })))
    const out = await collect(fetchSse('https://x', {}, new AbortController().signal))
    expect(out).toEqual(['{"ok":true}'])
  })
})

describe('fetchSse — 429/5xx 재시도·타임아웃', () => {
  it('429 는 Retry-After 를 존중해 재시도하고 다음 응답으로 성공한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeRes({ status: 429, headers: { 'retry-after': '0.001' } }))
      .mockResolvedValueOnce(fakeRes({ chunks: ['data: {"ok":1}\n\n'] }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(fetchSse('https://x', {}, new AbortController().signal))
    expect(out).toEqual(['{"ok":1}'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('재시도를 다 쓰면 5xx 를 ProviderError(api)로 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ status: 503 })))
    const err = await collectErr(fetchSse('https://x', {}, new AbortController().signal, { maxRetries: 0 }))
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).reason).toBe('api')
  })

  it('401 은 재시도 없이 즉시 auth 로 분류된다', async () => {
    const fetchMock = vi.fn(async () => fakeRes({ status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await collectErr(fetchSse('https://x', {}, new AbortController().signal))
    expect((err as ProviderError).reason).toBe('auth')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('응답이 timeoutMs 안에 오지 않으면 network 오류로 끝난다(응답이 영원히 안 옴)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      })
    )
    const err = await collectErr(fetchSse('https://x', {}, new AbortController().signal, { timeoutMs: 20 }))
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).reason).toBe('network')
  })

  it('호출측 signal 이 중단되면 재시도 대기 중에도 즉시 끝난다', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ status: 429 })))
    const p = collectErr(fetchSse('https://x', {}, controller.signal, { maxRetries: 5 }))
    controller.abort()
    const err = await p
    expect(err).toBeInstanceOf(ProviderError)
  })
})

// context(첨부된 터미널 출력)에만 마스킹이 걸린다 — 사용자가 직접 타이핑한 text 는 대상이 아니다
// (설계 §3.3: 마스킹은 "첨부 컨텍스트"의 방어선이지 채팅 입력 검열이 아니다).
const baseReq = (provider: AiRequest['provider'], extra?: Partial<AiRequest>): AiRequest => ({
  ...buildRequestCore([{ id: 'u1', at: 0, role: 'user', text: '이 출력이 뭔가요', context: 'export TOKEN=abc123' }], 'x-model'),
  provider,
  apiKey: 'sk-test',
  ...extra
})

describe('openai/compatible 어댑터 — 요청 조립(마스킹 포함)·SSE 델타·오류', () => {
  it('요청 본문에 Authorization 헤더와 마스킹된 메시지가 실린다(원문 비밀 없음)', async () => {
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedInit = init
        return Promise.resolve(fakeRes({ chunks: ['data: [DONE]\n\n'] }))
      })
    )
    await collect(openaiAdapter.stream(baseReq('openai'), new AbortController().signal))
    const body = String(capturedInit?.body)
    expect(body).not.toContain('abc123')
    expect(body).toContain('****')
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer sk-test')
  })

  it('choices[0].delta.content 델타를 순서대로 내고 usage 를 마지막에 낸다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeRes({
          chunks: [
            'data: {"choices":[{"delta":{"content":"안녕"}}]}\n\n',
            'data: {"choices":[{"delta":{}}]}\n\n', // 빈 델타 — 무시
            'data: {"choices":[{"delta":{"content":"하세요"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
            'data: [DONE]\n\n'
          ]
        })
      )
    )
    const out = await collect(openaiAdapter.stream(baseReq('openai'), new AbortController().signal))
    expect(out.filter((c) => c.text).map((c) => c.text)).toEqual(['안녕', '하세요'])
    expect(out.find((c) => c.usage)?.usage).toEqual({ input: 5, output: 2 })
  })

  it('중간 오류 이벤트(data.error)는 ProviderError 로 던져진다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes({ chunks: ['data: {"choices":[{"delta":{"content":"일부"}}]}\n\n', 'data: {"error":{"message":"컨텍스트 초과"}}\n\n'] }))
    )
    const err = await collectErr(openaiAdapter.stream(baseReq('openai'), new AbortController().signal))
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).toBe('컨텍스트 초과')
  })

  it('compatible 은 저장된 baseUrl 을 그대로 신뢰하지 않고 전송 직전 재검증한다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // 손상된 렌더러가 loopback 아닌 http:// 를 실어 보냈다고 가정 — 어댑터가 실제 방어선이다.
    const err = await collectErr(compatibleAdapter.stream(baseReq('compatible', { baseUrl: 'http://evil.example.com' }), new AbortController().signal))
    expect(err).toBeInstanceOf(ProviderError)
    expect(fetchMock).not.toHaveBeenCalled() // 검증에서 막혀 네트워크로 나가지도 않는다
  })

  it('compatible 은 유효한 loopback http baseUrl 로 실제 요청을 만든다(로컬 LLM)', async () => {
    let capturedUrl: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        capturedUrl = url
        return Promise.resolve(fakeRes({ chunks: ['data: [DONE]\n\n'] }))
      })
    )
    await collect(compatibleAdapter.stream(baseReq('compatible', { baseUrl: 'http://127.0.0.1:11434/v1' }), new AbortController().signal))
    expect(capturedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('validate() — 401 은 auth, 네트워크 예외는 network 로 분류된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ status: 401 })))
    expect(await openaiAdapter.validate('bad-key', 'x-model')).toEqual({ ok: false, reason: 'auth', message: expect.any(String) })

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline')))
    )
    expect(await openaiAdapter.validate('key', 'x-model')).toEqual({ ok: false, reason: 'network', message: expect.any(String) })
  })
})

describe('google 어댑터 — role 매핑·SSE·usageMetadata', () => {
  it('assistant 턴은 role:model, user 턴은 role:user 로 보낸다', async () => {
    let capturedBody: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedBody = String(init?.body)
        return Promise.resolve(fakeRes({ chunks: ['data: [DONE]\n\n'] }))
      })
    )
    const req: AiRequest = {
      ...buildRequestCore(
        [
          { id: 'u1', at: 0, role: 'user', text: '질문' },
          { id: 'a1', at: 0, role: 'assistant', text: '답변' }
        ],
        'gemini-2.5-pro'
      ),
      provider: 'google',
      apiKey: 'key'
    }
    await collect(googleAdapter.stream(req, new AbortController().signal))
    const body = JSON.parse(capturedBody ?? '{}')
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model'])
  })

  it('candidates 텍스트와 usageMetadata 를 낸다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeRes({
          chunks: [
            'data: {"candidates":[{"content":{"parts":[{"text":"안녕"}]}}]}\n\n',
            'data: {"candidates":[{"content":{"parts":[{"text":"하세요"}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n\n'
          ]
        })
      )
    )
    const out = await collect(googleAdapter.stream(baseReq('google', { model: 'gemini-2.5-pro' }), new AbortController().signal))
    expect(out.filter((c) => c.text).map((c) => c.text)).toEqual(['안녕', '하세요'])
    expect(out.find((c) => c.usage)?.usage).toEqual({ input: 7, output: 3 })
  })

  it('키가 유효하지 않으면(400/403) auth 로 분류된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes({ status: 400 })))
    expect(await googleAdapter.validate('bad-key', 'gemini-2.5-pro')).toEqual({ ok: false, reason: 'auth', message: expect.any(String) })
  })
})

describe('anthropic 어댑터 — SDK 예외 → ProviderError', () => {
  it('AuthenticationError 는 setKey 검증에서 auth 로 분류된다', async () => {
    // 실 네트워크를 만들지 않으려고 fetch 를 스텁해 SDK 내부 http 호출이 즉시 실패하게 한다 —
    // Anthropic SDK 는 401 응답에서 AuthenticationError 를 던진다(SDK 자체가 이미 검증된 동작이라
    // 여기서는 "그 예외가 우리 validate() 에서 어떻게 보이는지"만 실증한다).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeRes({ status: 401 })
      )
    )
    const res = await anthropicAdapter.validate('bad-key', 'claude-sonnet-5')
    expect(res).toEqual({ ok: false, reason: 'auth', message: expect.any(String) })
  })

  it('네트워크 오류는 setKey 검증에서 network 로 분류된다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new APIConnectionError({ message: '연결 안 됨' })))
    )
    const res = await anthropicAdapter.validate('key', 'claude-sonnet-5')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('network')
  })

  it('AuthenticationError 인스턴스는 실제로 SDK 가 던지는 타입이다(회귀 방지 — import 경로 확인)', () => {
    expect(new AuthenticationError(401, undefined, 'x', new Headers())).toBeInstanceOf(Error)
  })
})
