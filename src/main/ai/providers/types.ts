// 프로바이더 어댑터 계약 — 함수 테이블 수준(설계 지시 W5). 클래스 계층·팩토리·DI 를 두지 않는다.
// AraSession 은 이 테이블에서 골라 부르기만 한다 — 대화 상태·마스킹·취소는 AraSession 한 곳에 남는다.
import type { AiKeyResult, AiProvider } from '@shared/types'
import type { AiRequestCore } from '../prompt'

export type AiMessage = { role: 'user' | 'assistant'; content: string }

/**
 * function calling(2026-08-26 준영님 요청 — *"도구를 연결할 수는 없을까?"*).
 *
 * **문은 둘뿐이다**(ara_tools·ara_call) — 그래서 프로바이더마다 스키마를 손으로 감쌀 수 있다.
 * 28개를 그대로 노출했다면 매 요청에 28개분 스키마가 토큰으로 나갔을 것이고, 변환기도 필요했다.
 */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> }

/** 모델이 "이 도구를 이 인자로 불러 달라" 고 한 것. id 는 결과를 되돌려줄 때 짝을 맞춘다. */
export type ToolCall = { id: string; name: string; args: string }

/** 도구를 부르고 받은 결과 — 다음 요청에 그대로 실어 보낸다(대화의 일부가 된다). */
export type ToolResultMsg = { callId: string; name: string; content: string }

// AraSession 이 buildRequestCore()(순수·프로바이더 무관) 결과에 apiKey/baseUrl 을 얹어 조립한다.
// apiKey/baseUrl 은 이 요청 객체가 살아 있는 동안만 존재하고 로그·상태에 남지 않는다(불변식 1).
export type AiRequest = AiRequestCore & {
  provider: AiProvider
  apiKey: string
  baseUrl?: string // compatible 전용. 다른 프로바이더는 무시한다.
  /** 넘길 도구. 없으면 예전과 똑같이 동작한다(도구를 모르는 어댑터·판도 그대로 산다). */
  tools?: readonly ToolSpec[]
  /**
   * 지금까지의 도구 왕복. 모델이 부른 것과 우리가 돌려준 것을 **짝으로** 싣는다 —
   * 프로바이더마다 담는 모양이 다르고 그 변환은 각 어댑터의 몫이다.
   */
  toolTurns?: readonly { calls: readonly ToolCall[]; results: readonly ToolResultMsg[] }[]
}

export type StreamChunk = {
  text?: string
  usage?: { input: number; output: number }
  /** 그 턴에서 모델이 부른 도구들. 스트림이 끝날 때 한 번에 온다(조각은 어댑터가 모은다). */
  toolCalls?: ToolCall[]
}

export type ProviderErrorReason = 'auth' | 'rateLimit' | 'network' | 'api'

// 모든 어댑터가 오류를 이 모양으로 던진다 — AraSession.classify() 가 유일하게 보는 타입이다.
// "왜 실패했는가"(HTTP 상태·SDK 예외 클래스)의 판별은 그 와이어 포맷을 아는 각 어댑터의 몫이고,
// 그 결과를 사용자 문구로 굳히는 마지막 결정은 여전히 AraSession 한 곳이다(설계 지시 그대로).
export class ProviderError extends Error {
  constructor(
    public readonly reason: ProviderErrorReason,
    message: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export type ProviderAdapter = {
  id: AiProvider
  defaultModels: readonly string[]
  // 저비용 검증(키 저장 시 1회). 과금 없는 GET 조회로 auth/model/network 를 구분한다.
  validate(key: string, model: string, baseUrl?: string): Promise<AiKeyResult>
  // 스트리밍 응답. 오류는 예외(ProviderError)로 던진다 — AraSession 의 for-await 가 잡는다.
  stream(req: AiRequest, signal: AbortSignal): AsyncIterable<StreamChunk>
}
