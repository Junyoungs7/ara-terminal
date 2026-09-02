import { useEffect, useState } from 'react'

/**
 * 세션 점이 말하는 것 — **상태 하나**다(#166).
 *
 * 2026-09-02 준영님: *"세션 서버마다 다르게 점을 하지 말고 켜지면 초록색 등으로 동일하게."*
 * 그전에는 같은 6px 원이 자리마다 다른 뜻이었다: 탭·미니 프리뷰는 **서버 이름 해시색**,
 * 칸 머리는 **세션 복원 실패 여부**. 사용자에게는 같은 물건인데 하나는 "어느 서버"를, 하나는
 * "고장 났나"를 말했다 — 그래서 둘 다 안 읽힌다.
 *
 * **어휘는 셋이다.** 트리 연결 노드가 이미 쓰는 셋과 같다(design-system §5.2 `.on`/`.warn`/`.off`):
 *  · `on` 붙어 있다 · `connecting` 붙는 중이다 · `lost` 끊겼다
 * 더 늘리지 않는다 — 색이 넷을 넘으면 아무 뜻도 안 된다. [AI] 목록의 상태 넷(작업 중·대기 중·
 * 끝남·확인 불가)은 **여기 없다**: 그건 연결이 아니라 에이전트가 무엇을 하고 있는가라 다른 축이다.
 *
 * ⚠️ 색만으로 말하지 않는다(§6). 점을 그리는 자리는 전부 `StateDot` 을 쓰고, 그 컴포넌트가
 * 툴팁(`session.st.*`)을 함께 단다.
 */
export type SessionState = 'on' | 'connecting' | 'lost'

/** RdpView 의 접속 단계. 두 벌로 갈리지 않게 **RdpView 가 이 타입을 쓴다.** */
export type RdpPhase = 'creds' | 'connecting' | 'connected' | 'error'

/**
 * RDP 단계 → 점. **#166 의 본체**: 지금까지 칸 머리 점은 phase 를 아예 안 봐서 **끊겨도 초록**이었고,
 * 헤더의 "연결됨" 한 줄을 없앤 뒤로는 그 점이 유일한 상태 표시였다.
 *
 * `creds`(비밀번호 입력 대기)를 `connecting` 으로 묶는다 — 아직 안 붙었다는 점에서 같고,
 * 무엇을 기다리는지는 본문 오버레이가 크게 말한다.
 */
export function rdpSessionState(phase: RdpPhase): SessionState {
  if (phase === 'connected') return 'on'
  if (phase === 'error') return 'lost'
  return 'connecting'
}

// 스스로 상태를 말하는 세션만 여기 들어온다. 나머지는 기본값(`on`)이다.
//
// 모듈 스코프인 이유: 이 값을 읽는 데가 셋이고(탭바·칸 머리·미니 프리뷰) 그중 미니 프리뷰는
// Shell 밑, 나머지는 MainArea 밑이라 공통 조상이 없다. agentStatus.ts 와 같은 모양이다.
const byId = new Map<string, SessionState>()
const listeners = new Set<() => void>()

/** 기본은 `on` — 목록에 있는 세션은 main 이 살아 있다고 말한 것이다. 죽으면 아래가 바꾼다. */
export function sessionState(id: string): SessionState {
  return byId.get(id) ?? 'on'
}

export function setSessionState(id: string, state: SessionState): void {
  if (byId.get(id) === state) return
  byId.set(id, state)
  listeners.forEach((f) => f())
}

/** 세션이 목록에서 빠졌다 — 흔적을 버린다(useSessions.close 한 곳이 부른다). */
export function forgetSessionState(id: string): void {
  if (byId.delete(id)) listeners.forEach((f) => f())
}

/**
 * 상태가 바뀌면 다시 그린다. 값은 `sessionState(id)` 로 각자 읽는다 — 지도를 통째로 내려 주면
 * 세션 하나가 바뀔 때마다 새 객체가 생겨 전부 재렌더된다.
 */
export function useSessionStates(): void {
  const [, bump] = useState(0)
  useEffect(() => {
    const cb = (): void => bump((n) => n + 1)
    listeners.add(cb)
    return () => void listeners.delete(cb)
  }, [])
}
