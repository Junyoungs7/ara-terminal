// fetch 기반 SSE 스트림 — OpenAI/호환·Gemini 어댑터가 공유한다(Anthropic 은 자체 SDK 를 그대로 쓴다).
// Anthropic SDK 가 공짜로 주던 것(설계 §1 "왜 SDK 인가")을 여기서 대신 구현해야 한다: 429/5xx 재시도,
// 타임아웃, 중단. 전역 fetch(Node 20+/Electron main 내장)만 쓴다 — 새 HTTP 클라이언트 의존성 없음.
import { ProviderError } from './types'

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 30_000
const RETRY_BASE_MS = 500

export type FetchSseOptions = { timeoutMs?: number; maxRetries?: number }

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // 이미 중단된 signal 에 뒤늦게 리스너를 달면 'abort' 이벤트가 다시 발화하지 않아 타이머가
    // 그대로 끝까지 간다 — 재시도 대기 중 취소가 씹히는 버그였다. 진입 시점에 먼저 확인한다.
    if (signal.aborted) {
      reject(new ProviderError('network', '중단됨'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ProviderError('network', '중단됨'))
      },
      { once: true }
    )
  })
}

// signal 에 타임아웃을 얹은 합성 신호 — 둘 중 먼저 온 것이 이긴다. AbortSignal.any 대신 수동 합성한다
// (Node 버전 의존을 늘리지 않는다 — 10줄이면 되는 걸 API 가용성 확인으로 늘릴 이유가 없다).
function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (signal.aborted) ctrl.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), ms)
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return RETRY_BASE_MS * 2 ** attempt
}

function classifyStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('auth', 'API 키가 유효하지 않습니다')
  if (status === 429) return new ProviderError('rateLimit', '요청이 많습니다. 잠시 후 다시 시도하세요.')
  if (status >= 500) return new ProviderError('api', '일시적인 서버 오류입니다')
  return new ProviderError('api', `요청이 거부되었습니다 (${status})`)
}

// SSE 이벤트 payload("data: ..." 줄의 값) 을 순서대로 낸다. "[DONE]"(OpenAI 관례)은 건너뛴다.
// 프레임 경계(\n\n)가 청크 중간에서 끊겨도(부분 청크) buf 에 이어붙여 다음 read() 에서 완성한다.
export async function* fetchSse(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  opts?: FetchSseOptions
): AsyncGenerator<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES
  let res: Response
  let attempt = 0
  for (;;) {
    const t = withTimeout(signal, timeoutMs)
    try {
      res = await fetch(url, { ...init, signal: t.signal })
    } catch {
      t.cancel()
      if (signal.aborted) throw new ProviderError('network', '중단됨')
      throw new ProviderError('network', '네트워크에 연결할 수 없습니다')
    }
    t.cancel()
    if (res.ok) break
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      attempt += 1
      void res.body?.cancel().catch(() => {})
      await sleep(retryDelayMs(res, attempt), signal)
      continue
    }
    void res.body?.cancel().catch(() => {})
    throw classifyStatus(res.status)
  }
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data && data !== '[DONE]') yield data
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
