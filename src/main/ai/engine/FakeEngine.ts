import type { AiEngine, AiEngineEvent } from '@shared/aiEngine'

/**
 * 캔드 엔진(#125) — `ARA_AI_FAKE=1` 일 때 진짜 `claude` 대신 붙는다.
 *
 * **왜 있나**: 대화 화면의 배선(IPC → 접기 규칙 → 그리기)을 창까지 띄워 확인하고 싶은데,
 * 그 확인마다 준영님의 Claude 한도를 쓸 수는 없다. F16 이 `ARA_AI_FAKE` 로 같은 문제를 이미
 * 풀어 뒀다(AraSession.isFakeAi) — 그 관행을 그대로 따른다.
 *
 * **왜 진짜처럼 만들지 않나**: 이 파일이 답할 질문은 "화면이 사건을 제대로 그리는가" 하나다.
 * 파싱·수명·중지는 tests/aiEngine.test.ts 가 가짜 **프로세스**로 본다(그쪽이 더 낮은 층이다).
 */
export function createFakeEngine(): AiEngine {
  const listeners = new Set<(e: AiEngineEvent) => void>()
  const timers = new Set<NodeJS.Timeout>()
  let alive = true

  const emit = (e: AiEngineEvent): void => {
    if (!alive) return
    for (const fn of [...listeners]) fn(e)
  }
  const later = (ms: number, fn: () => void): void => {
    const id = setTimeout(() => {
      timers.delete(id)
      fn()
    }, ms)
    timers.add(id)
  }

  later(10, () =>
    emit({ t: 'ready', sessionId: 'fake-session', model: 'fake', cwd: process.cwd(), tools: ['Read', 'Bash', 'mcp__ara__session_list'] })
  )

  return {
    send(text) {
      // 도구 둘 → 글 → 턴 끝. 접기 규칙(잇따른 도구는 한 묶음)이 화면에서 실제로 도는지 본다.
      later(10, () => emit({ t: 'tool', id: 'f1', name: 'mcp__ara__session_list', brief: '' }))
      later(20, () => emit({ t: 'toolResult', id: 'f1', ok: true, brief: '세션 1개' }))
      later(30, () => emit({ t: 'tool', id: 'f2', name: 'Read', brief: 'package.json' }))
      later(40, () => emit({ t: 'toolResult', id: 'f2', ok: true, brief: '' }))
      later(60, () => emit({ t: 'text', text: `가짜 엔진입니다. 받은 말: ${text}` }))
      later(80, () => emit({ t: 'turn', costUsd: 0.012, ms: 80, turns: 1, text: '' }))
    },
    respondPermission: () => {},
    // 캔드 엔진에는 권한 모드가 없다 — 화면이 부르는 것만 받아 준다.
    setMode: () => {},
    setModel: () => {},
    interrupt: () => later(10, () => emit({ t: 'turn', costUsd: 0, ms: 0, turns: 0, text: '' })),
    dispose() {
      alive = false
      for (const id of timers) clearTimeout(id)
      timers.clear()
      listeners.clear()
    },
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
