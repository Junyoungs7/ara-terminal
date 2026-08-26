// 아라 대화 세션 — **대화의 주인은 main 이다**(설계 §5). 렌더러는 뷰일 뿐이라 패널을 닫거나
// 재마운트해도 대화가 사라지지 않고, F23 의 MCP 툴 호출은 나중에 같은 객체에 붙는 두 번째 호출자가 된다.
//
// 불변식 셋(설계 §0) — W5 멀티 프로바이더에도 그대로 유지:
//   1. API 키는 이 파일 밖으로 나가지 않는다. get 하는 메서드가 없고, getState 는 hasKey 만 준다.
//      프로바이더별로 vault 키를 분리한다(`ai.apiKey.<provider>`) — 전환해도 재입력이 필요 없다.
//   2. 컨텍스트는 buildRequestCore 를 지나며 마스킹된 뒤에만 네트워크로 나간다(프로바이더 무관).
//   3. 아라가 명령을 실행하는 경로가 없다 — 텍스트만 낸다(tool use 미배선).
import { maskSecrets } from '@shared/maskSecrets'
import type { AiEnd, AiEnv, AiProvider, AiState, AiTurn } from '@shared/types'
import { buildRequestCore } from './prompt'
import type { ToolSpec, ToolCall, ToolResultMsg } from './providers'
import { PROVIDERS, ProviderError, type AiRequest, type ProviderAdapter, type StreamChunk } from './providers'

// vault 키 네임스페이스. ProfileStore 는 프로필 UUID 를 vault 키로 쓰므로 충돌하지 않는다(점이 든
// 문자열은 UUID 가 아니다). 프로바이더별로 분리해 전환 시 재입력이 필요 없게 한다(설계 W5 §구조결정 3).
export function aiKeyVaultId(provider: AiProvider): string {
  return `ai.apiKey.${provider}`
}

export type KeyVault = {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
}

export type Usage = { input: number; output: number }

// 현재 선택된 프로바이더·모델·(compatible 전용) baseUrl. main/index.ts 가 UiPrefs 에서 매 호출 시점에
// 다시 읽어 넘긴다 — AraSession 은 이 값을 캐시하지 않는다(설정이 바뀌면 다음 턴부터 즉시 반영).
export type AiPrefs = { provider: AiProvider; model: string; baseUrl?: string }

export const isFakeAi = (): boolean => process.env['ARA_AI_FAKE'] === '1'

// ARA_AI_FAKE=1 캔드 스트림 — 프로바이더 무관(설계 §검증 "seam 이 프로바이더 수와 무관하게 동작").
// 프로덕션 코드에 테스트 seam 을 두는 것은 이 코드베이스의 기존 관행이다(__evConnect·__evAdopt·__evTerm).
const FAKE_ANSWER = `로그 디렉터리부터 확인하시면 됩니다. 아래 명령이 용량 상위 10개를 보여 줍니다.

\`\`\`bash
du -sh /var/log/* | sort -rh | head -10
\`\`\`

정리 대상이 보이면 지우기 전에 logrotate 설정을 먼저 확인하시는 편이 안전합니다.`
const FAKE_CHUNK = 24
const FAKE_INTERVAL_MS = 100
const FAKE_USAGE: Usage = { input: 412, output: 96 }

async function* fakeSource(_req: AiRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
  for (let i = 0; i < FAKE_ANSWER.length; i += FAKE_CHUNK) {
    if (signal.aborted) return
    await new Promise((r) => setTimeout(r, FAKE_INTERVAL_MS))
    if (signal.aborted) return
    yield { text: FAKE_ANSWER.slice(i, i + FAKE_CHUNK) }
  }
  yield { usage: FAKE_USAGE }
}

let turnSeq = 0
const nextTurnId = (): string => `t${Date.now().toString(36)}-${(turnSeq += 1)}`

type Emit = {
  delta: (turnId: string, text: string) => void
  end: (e: AiEnd) => void
  /** 도구를 부르기 직전(2026-08-26). 화면이 "무엇을 하고 있나" 를 보여 준다. */
  tool?: (name: string, args: string) => void
}

/**
 * 도구를 쥐여 주는 자리(2026-08-26 — API 엔진 function calling).
 *
 * **specs 는 프로바이더에 넘길 스키마, run 은 실제 실행이다.** 실행은 MCP 와 같은 게이트를 지나므로
 * 인자 검증·승인 창·감사 로그가 전부 그대로 붙는다 — "어느 엔진으로 했든 같은 규칙" 이 여기서 성립한다.
 */
export type SessionTools = {
  specs: readonly ToolSpec[]
  run(name: string, argsJson: string): Promise<string>
}

export class AraSession {
  private turns: AiTurn[] = []
  // #80: 직전 요청에서 예산 때문에 앞에서 버린 턴 수(표시용). 요청을 보낼 때마다 갱신된다.
  private droppedTurns = 0
  private usage: Usage = { input: 0, output: 0 }
  // 진행 중 턴. 하나뿐이다 — 대화가 하나고 사용자가 답을 기다리는 동안 다음 질문을 보내지 않는다.
  private active: { turnId: string; controller: AbortController } | null = null

  constructor(
    private readonly vault: KeyVault,
    private readonly getPrefs: () => AiPrefs,
    private readonly emit: Emit,
    // 테스트 seam — 제공하면 프로바이더 테이블 조회 없이 이 어댑터를 쓴다(ARA_AI_FAKE 보다 우선).
    private readonly adapterOverride?: ProviderAdapter,
    /** 도구(없으면 예전처럼 도구 없이 돈다 — F16 판·테스트가 그대로 산다). */
    private readonly tools?: SessionTools
  ) {}

  // 패널이 마운트할 때 받아 가는 전량. 키는 hasKey 로만 나간다 — 문자열도, 접두사도 주지 않는다
  // (접두사 몇 글자도 로그·스크린샷으로 새면 의미가 있는 정보다).
  getState(): AiState {
    const { provider, model } = this.getPrefs()
    return {
      hasKey: this.vault.has(aiKeyVaultId(provider)),
      provider,
      model,
      turns: this.turns,
      streaming: this.active !== null,
      usage: this.usage,
      droppedTurns: this.droppedTurns
    }
  }

  // 키 저장(+검증) 또는 삭제. 빈 문자열이 삭제다 — 삭제 전용 채널을 따로 만들지 않는다.
  // 검증은 어댑터의 validate()(과금 0 GET 조회) 한 번이다 — 프로바이더마다 판별 방식이 다르므로
  // 판별 로직 자체는 어댑터가 쥐고, 여기는 결과만 받아 vault 에 반영한다.
  async setKey(key: string): Promise<{ ok: true } | { ok: false; reason: 'auth' | 'network' | 'noEncryption' | 'model'; message: string }> {
    const trimmed = key.trim()
    const { provider, model, baseUrl } = this.getPrefs()
    const vaultKey = aiKeyVaultId(provider)
    if (!trimmed) {
      this.vault.delete(vaultKey)
      return { ok: true }
    }
    if (!isFakeAi()) {
      const adapter = this.adapterOverride ?? PROVIDERS[provider]
      const result = await adapter.validate(trimmed, model, baseUrl)
      if (!result.ok) return result
    }
    try {
      this.vault.set(vaultKey, trimmed)
    } catch {
      // safeStorage.isEncryptionAvailable()===false — 평문 폴백은 하지 않는다(기존 vault 계약).
      return { ok: false, reason: 'noEncryption', message: '이 환경에서는 키를 안전하게 저장할 수 없습니다' }
    }
    return { ok: true }
  }

  // 질문 한 턴. 사용자 턴과 (빈) assistant 턴을 즉시 만들고 turnId 를 돌려준 뒤 배경에서 흘린다.
  // **모든 대화 변경이 이 함수 하나를 통과한다** — F23 의 승인 게이트·행동 로그를 나중에 여기 끼운다.
  send(req: { text: string; context?: string; env?: AiEnv }): { turnId: string } {
    // 첨부 컨텍스트는 턴에 담기는 시점에 이미 마스킹한다. 사용자가 나중에 📎 배지로 되짚는 텍스트가
    // 실제 전송본과 같아야 신뢰가 성립하기 때문이다(buildRequestCore 가 멱등 마스킹을 한 번 더 한다).
    const user: AiTurn = {
      id: nextTurnId(),
      at: Date.now(),
      role: 'user',
      text: req.text,
      ...(req.context ? { context: maskSecrets(req.context) } : {})
    }
    const answer: AiTurn = { id: nextTurnId(), at: Date.now(), role: 'assistant', text: '' }
    this.turns.push(user, answer)
    void this.run(answer, req.env)
    return { turnId: answer.id }
  }

  private finish(turn: AiTurn, end: AiEnd): void {
    this.active = null
    turn.end = end.ok ? 'done' : end.reason === 'canceled' ? 'canceled' : 'error'
    if (!end.ok && end.reason !== 'canceled') turn.error = end.message
    this.emit.end(end)
  }

  /**
   * 도구 왕복 상한(2026-08-26 준영님 확인: **5회**).
   *
   * 왕복 한 번마다 대화 전체가 다시 전송된다 — Claude Code 는 구독이라 상관없지만 API 는 토큰당
   * 과금이다. 상한에 걸리면 **조용히 더 쓰지 않고** 사용자에게 넘긴다.
   */
  private static readonly MAX_TOOL_ROUNDS = 5

  private async run(turn: AiTurn, env?: AiEnv): Promise<void> {
    const { provider, model, baseUrl } = this.getPrefs()
    const apiKey = this.vault.get(aiKeyVaultId(provider))
    if (!apiKey) {
      this.finish(turn, { turnId: turn.id, ok: false, reason: 'noKey', message: 'API 키가 없습니다' })
      return
    }
    const controller = new AbortController()
    this.active = { turnId: turn.id, controller }
    // 답변 턴 자신은 아직 비어 있으므로 요청에 실리지 않는다(buildRequestCore 가 빈 assistant 턴을 거른다).
    const core = buildRequestCore(this.turns, model, env)
    this.droppedTurns = core.droppedTurns
    const stream = isFakeAi() ? fakeSource : (this.adapterOverride ?? PROVIDERS[provider]).stream
    const tools = this.tools?.specs
    try {
      /**
       * **툴 루프**(2026-08-26). 모델이 도구를 부르면 실행하고 결과를 되먹여 다시 묻는다.
       * 도구를 안 쓰면 한 바퀴에 끝나므로 예전 흐름과 같다.
       */
      const rounds: { calls: ToolCall[]; results: ToolResultMsg[] }[] = []
      for (let round = 0; ; round++) {
        const request: AiRequest = {
          ...core,
          provider,
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...(tools?.length ? { tools } : {}),
          ...(rounds.length ? { toolTurns: rounds } : {})
        }
        let calls: ToolCall[] = []
        for await (const chunk of stream(request, controller.signal)) {
          if (controller.signal.aborted) break
          if (chunk.text) {
            turn.text += chunk.text
            this.emit.delta(turn.id, chunk.text)
          }
          if (chunk.toolCalls?.length) calls = chunk.toolCalls
          if (chunk.usage) {
            this.usage = { input: this.usage.input + chunk.usage.input, output: this.usage.output + chunk.usage.output }
          }
        }
        if (controller.signal.aborted) break
        if (!calls.length) break

        // 상한에 걸렸다 — **조용히 더 쓰지 않는다.** 사용자가 이어 갈지 정한다(왕복마다 과금이다).
        if (round + 1 >= AraSession.MAX_TOOL_ROUNDS) {
          const over = `

(도구를 ${AraSession.MAX_TOOL_ROUNDS}번 썼습니다 — 여기서 멈춥니다. 계속하려면 다시 말씀해 주세요.)`
          turn.text += over
          this.emit.delta(turn.id, over)
          break
        }

        const results: ToolResultMsg[] = []
        for (const c of calls) {
          this.emit.tool?.(c.name, c.args)
          const text = await (this.tools?.run(c.name, c.args) ?? Promise.resolve('도구를 쓸 수 없습니다.'))
          results.push({ callId: c.id, name: c.name, content: text })
        }
        rounds.push({ calls, results })
      }
      // 중단은 성공이 아니다 — 지금까지 받은 델타는 화면에 남기고 "중단됨" 표식을 붙인다.
      if (controller.signal.aborted) {
        this.finish(turn, { turnId: turn.id, ok: false, reason: 'canceled', message: '중단됨' })
        return
      }
      this.finish(turn, { turnId: turn.id, ok: true })
    } catch (err) {
      // 사용자가 끊은 것이 어댑터 예외로 올라오는 경로를 오류로 표시하지 않는다.
      if (controller.signal.aborted) {
        this.finish(turn, { turnId: turn.id, ok: false, reason: 'canceled', message: '중단됨' })
        return
      }
      this.finish(turn, { turnId: turn.id, ...classify(err) })
    }
  }

  // 진행 중 스트림 중단. 지금까지 받은 델타는 남는다.
  cancel(): void {
    this.active?.controller.abort()
  }

  /**
   * 지난 대화를 되살린다(2026-08-26 — API 엔진의 "이어서 열기").
   *
   * 기록에서 읽은 턴을 그대로 얹는다. 진행 중이면 먼저 끊는다(clear 와 같은 이유 — 안 끊으면
   * 사라진 턴에 델타가 계속 붙는다). 이 턴들은 **다음 요청의 문맥**이 되고, 예산이 모자라면
   * buildRequestCore 가 앞에서부터 버린다(그 규칙은 그대로다).
   */
  restore(turns: AiTurn[]): void {
    this.cancel()
    this.turns = [...turns]
    this.droppedTurns = 0
  }

  // 새 대화. 진행 중이면 먼저 끊는다 — 안 끊으면 지워진 턴에 델타가 계속 붙는다.
  // 프로바이더 전환 시 렌더러가 호출한다(설계 W5 §보안 — 모델 간 컨텍스트 이월 방지).
  clear(): void {
    this.cancel()
    this.turns = []
    this.droppedTurns = 0
  }
}

// 어댑터가 던진 오류 → 화면 문구(설계 §7 오류 UX 표). 각 프로바이더의 실제 판별(HTTP 상태·SDK 예외
// 클래스)은 그 와이어 포맷을 아는 어댑터 자신의 몫이고(providers/*.ts), 여기는 그 결과를 사용자 문구로
// 굳히는 유일한 지점이다 — "오류 분류는 AraSession 한 곳에 남는다"는 지시를 이 형태로 지킨다.
function classify(err: unknown): { ok: false; reason: 'auth' | 'rateLimit' | 'network' | 'api'; message: string } {
  if (err instanceof ProviderError) return { ok: false, reason: err.reason, message: err.message }
  return { ok: false, reason: 'api', message: '알 수 없는 오류가 발생했습니다' }
}
