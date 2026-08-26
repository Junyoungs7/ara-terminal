import type { AiEngine, AiEngineEvent } from '@shared/aiEngine'
import type { AiEnd } from '@shared/types'
import { randomUUID } from 'node:crypto'
import { AraSession, type AiPrefs, type KeyVault, type SessionTools } from '../AraSession'
import { appendTurn, readTurns } from '../apiChatLog'

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
export function createApiEngine(opts: {
  vault: KeyVault
  getPrefs: () => AiPrefs
  /**
   * 대화 기록을 둘 폴더(2026-08-26). CLI 엔진은 Claude Code 가 남겨 주지만 이쪽은 남겨 줄 사람이
   * 없다 — 없으면 앱을 끌 때 대화가 통째로 사라지고, 같은 화면에서 엔진에 따라 "지난 대화"가
   * 있다 없다 한다.
   */
  dir?: string
  /** 이어서 열 대화. 그 기록을 읽어 문맥으로 얹는다. */
  resumeId?: string
  /**
   * 도구(2026-08-26 준영님 요청). 주면 이 엔진도 아라 도구를 쓴다 — **MCP 와 같은 게이트**라
   * 인자 검증·승인 창·감사 로그가 그대로 붙는다. 없으면 예전처럼 대화만 한다.
   */
  tools?: SessionTools
}): AiEngine {
  const listeners = new Set<(e: AiEngineEvent) => void>()
  let alive = true
  // 이 대화의 id. 이어서 여는 것이면 그 id 를 그대로 쓴다(기록이 한 파일에 이어 붙는다).
  const chatId = opts.resumeId ?? randomUUID()
  // 답을 모은다 — end 이벤트에는 최종 텍스트가 없다(델타로만 온다).
  const answer = new Map<string, string>()
  const emit = (e: AiEngineEvent): void => {
    if (!alive) return
    for (const fn of [...listeners]) fn(e)
  }

  const started = new Map<string, number>()
  const session = new AraSession(
    opts.vault,
    opts.getPrefs,
    {
    delta: (turnId, text) => {
      answer.set(turnId, (answer.get(turnId) ?? '') + text)
      emit({ t: 'text', text })
    },
    end: (e: AiEnd) => {
      const at = started.get(e.turnId)
      started.delete(e.turnId)
      // 답을 기록에 남긴다. 실패·중단이어도 **거기까지 온 말**은 남긴다 — 사람이 본 것이 곧 대화다.
      const text = answer.get(e.turnId) ?? ''
      answer.delete(e.turnId)
      if (opts.dir) appendTurn(opts.dir, chatId, 'assistant', text)
      // 실패는 오류로, 정상 종료·중단은 턴 끝으로. 중단은 사람이 누른 것이라 오류가 아니다.
      if (!e.ok && e.reason !== 'canceled') emit({ t: 'error', message: e.message })
      emit({ t: 'turn', costUsd: null, ms: at ? Date.now() - at : 0, turns: 1, text: '' })
    },
      // 화면이 "무엇을 하고 있나" 를 보여 준다 — CLI 엔진의 도구 묶음과 같은 사건이다.
      tool: (name, args) => emit({ t: 'tool', id: `${name}-${Date.now()}`, name, brief: brief(name, args) })
    },
    undefined,
    opts.tools
  )

  // 이어서 여는 것이면 지난 턴을 문맥으로 얹는다(그래야 "아까 그거" 가 통한다).
  if (opts.dir && opts.resumeId) session.restore(readTurns(opts.dir, opts.resumeId))

  const { provider, model } = opts.getPrefs()
  const toolNames = opts.tools?.specs.map((t) => t.name) ?? []
  // 다음 tick 에 올린다 — 화면이 onEvent 를 걸기 전에 쏘면 첫 줄을 놓친다(CLI 엔진도 같다).
  // sessionId 를 준다(2026-08-26): 화면이 "지금 어느 대화인가" 를 알아야 목록에서 그 줄을 표시한다.
  setTimeout(() => emit({ t: 'ready', sessionId: chatId, model: `${provider}/${model}`, cwd: null, tools: toolNames }), 0)

  return {
    send(text) {
      if (opts.dir) appendTurn(opts.dir, chatId, 'user', text)
      const { turnId } = session.send({ text })
      started.set(turnId, Date.now())
    },
    // 권한 왕복이 없는 판이다 — 도구가 없으니 승인할 것도 없고 모드도 없다.
    respondPermission: () => {},
    setMode: () => {},
    setModel: () => {},
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

/** 도구 한 줄 요약 — 화면 묶음에 뜨는 글. 인자 전문은 승인 창과 감사 로그가 갖는다. */
function brief(name: string, argsJson: string): string {
  try {
    const a = JSON.parse(argsJson) as { tool?: string; group?: string }
    if (name === 'ara_call' && a.tool) return a.tool
    if (name === 'ara_tools') return a.group ?? '묶음 목록'
  } catch {
    /* 조각난 JSON — 이름만으로 충분하다 */
  }
  return ''
}
