// F6 복원 플래너(순수 로직 — 단위 테스트 대상). 저장된 스냅샷을 "어떤 세션을 어떻게 되살릴지"로 변환한다.
// 실제 IPC(session.create / ssh.connect)와 상태 갱신은 MainArea 가 이 플랜을 순서대로 실행한다.
import type { WorkspaceSnapshot, Session } from '@shared/types'
import { fromLayoutNode, type PairAxis } from './layout'

// 복원 항목: 패널 배치 순서를 보존하기 위해 layout 트리 순서를 기준으로 만든다.
export type RestoreItem =
  | { kind: 'local'; oldId: string; session: Session }
  // ssh 는 프로필로 재접속. profile 이 없으면(고아) 곧바로 오류 패널로 처리.
  | { kind: 'ssh'; oldId: string; session: Session; profileId: string | null }

export type RestorePlan = {
  items: RestoreItem[] // 복원할 모든 세션 — 저장된 탭 순서 그대로(R2.3 드래그 재정렬 결과 보존)
  panedIds: string[] // 이 중 layout 패널에 배치할 세션의 oldId(순서 = 패널 순서, 최대 4)
  colRatio: number
  rowRatio: number
  pairAxis: PairAxis
}

function toItem(session: Session): RestoreItem {
  return session.type === 'ssh'
    ? { kind: 'ssh', oldId: session.id, session, profileId: session.profileId ?? null }
    : { kind: 'local', oldId: session.id, session }
}

// 스냅샷 → 복원 플랜. sessions[] 전체를 되살리고(탭), layout 패널에 붙은 세션은 그리드에 배치한다.
// 생성 순서 = 저장된 sessions 배열 순서다: 렌더러 세션 배열이 곧 탭 순서라, 패널 붙은 것부터 만들면
// 사용자가 드래그로 잡아 둔 탭 순서가 복원 때 뒤섞인다(R2.3).
export function planRestore(snap: WorkspaceSnapshot): RestorePlan {
  const { sessionIds, colRatio, rowRatio, pairAxis } = fromLayoutNode(snap.layout)
  const known = new Set(snap.sessions.map((s) => s.id))
  const items = snap.sessions.map(toItem)
  const panedIds = [...new Set(sessionIds)].filter((id) => known.has(id))
  return { items, panedIds, colRatio, rowRatio, pairAxis }
}

// 복원할 세션이 하나라도 있는지 — 없으면 빈 시작(placeholder) 유지.
export function hasRestorable(snap: WorkspaceSnapshot): boolean {
  return planRestore(snap).items.length > 0
}
