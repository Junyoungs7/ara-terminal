import type { AiEngine, AiEngineEvent } from '@shared/aiEngine'
import type { AiEnd } from '@shared/types'
import { AraSession, type AiPrefs, type KeyVault } from '../AraSession'

/**
 * **B 엔진** — API 키로 직접 부르는 대화(#126 폴백).
 *
 * 이 PC 에 `claude` 가 없을 때 가는 길이다(설계 §5). 새로 쓴 것은 거의 없다 — F16 의
 * `AraSession` 이 프로바이더·스트리밍·마스킹·예산을 이미 갖고 있고, 여기는 그 사건 모양을
 * `AiEngine` 로 옮겨 담는 얇은 층이다. #123 에서 사건 모양을 하나로 맞춰 둔 이유가 이것이다.
 *
 * **A 엔진과 같지 않다. 그 차이를 숨기지 않는다:**
 *  · 도구가 **없다** — 파일을 읽지도, 명령을 돌리지도, 아라 도구(MCP)를 쓰지도 못한다.
 *    `ready.tools` 를 빈 배열로 올리므로 화면 첫 줄이 "도구 0개"라고 말한다.
 *  · **돈이 다르다** — 구독이 아니라 API 키(콘솔 결제)다.
 *  · 비용을 원화·달러로 못 준다(`turn.costUsd = null`) — 어댑터가 주는 것은 토큰 수뿐이다.
 *    거짓 숫자를 지어내느니 비우는 편이 낫다.
 */
export function createApiEngine(opts: { vault: KeyVault; getPrefs: () => AiPrefs }): AiEngine {
  const listeners = new Set<(e: AiEngineEvent) => void>()
  let alive = true
  const emit = (e: AiEngineEvent): void => {
    if (!alive) return
    for (const fn of [...listeners]) fn(e)
  }

  const started = new Map<string, number>()
  const session = new AraSession(opts.vault, opts.getPrefs, {
    delta: (_turnId, text) => emit({ t: 'text', text }),
    end: (e: AiEnd) => {
      const at = started.get(e.turnId)
      started.delete(e.turnId)
      // 실패는 오류로, 정상 종료·중단은 턴 끝으로. 중단은 사람이 누른 것이라 오류가 아니다.
      if (!e.ok && e.reason !== 'canceled') emit({ t: 'error', message: e.message })
      emit({ t: 'turn', costUsd: null, ms: at ? Date.now() - at : 0, turns: 1, text: '' })
    }
  })

  const { provider, model } = opts.getPrefs()
  // 다음 tick 에 올린다 — 화면이 onEvent 를 걸기 전에 쏘면 첫 줄을 놓친다(CLI 엔진도 같다).
  setTimeout(() => emit({ t: 'ready', sessionId: null, model: `${provider}/${model}`, cwd: null, tools: [] }), 0)

  return {
    send(text) {
      const { turnId } = session.send({ text })
      started.set(turnId, Date.now())
    },
    // 권한 왕복이 없는 판이다 — 도구가 없으니 승인할 것도 없고 모드도 없다.
    respondPermission: () => {},
    setMode: () => {},
    interrupt: () => session.cancel(),
    dispose() {
      alive = false
      session.cancel()
      listeners.clear()
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
