// 탐색기 독립 창의 진입 해시와, 본창 ↔ 탐색기 창이 주고받는 모양 (2026-10-28 준영님 제보 —
// "탐색기가 별도의 창으로 떠야하는데 아라 툴 내부에서만 떠").
//
// 포트 모니터 창(portWin.ts)과 같은 구조다: 해시 하나, 매개변수 없음, 창은 하나.
// 다른 점은 **본창 상태를 쓴다**는 것 — 세션 목록·프로필·즐겨찾기의 주인은 본창(Shell)이고
// 탐색기 창은 그 사본을 받아 그린다(ExplorerState). 거꾸로 [연결]·[AI 에 묻기]처럼 본창에서
// 일어나야 하는 일은 ExplorerAct 로 올려 보낸다. 둘 다 main 이 중계만 한다.
import type { ConnectionProfile, SessionType, WorkProfile } from './types'

export const EXPLORER_WIN_HASH = '#explorerwin'

export function isExplorerWinHash(hash: string): boolean {
  return hash === EXPLORER_WIN_HASH
}

/** 탐색기가 보는 세션 — 렌더러 Session 의 부분집합(창을 건너가므로 필요한 것만). */
export type ExplorerSession = { id: string; title: string; serverKey: string; type: SessionType; profileId?: string }

/** 본창 → 탐색기 창. 바뀔 때마다 통째로 보낸다(작다 — 세션·프로필 수십 개). */
export type ExplorerState = {
  sessions: ExplorerSession[]
  profiles: ConnectionProfile[]
  workProfiles: WorkProfile[]
}

/** "이 서버의 이 폴더를 열어라" — at 이 바뀔 때만 한 번 반응한다(WorkbenchView). */
export type ExplorerReveal = { profileId: string; path: string; at: number }

/** 탐색기 창 → 본창. 각 항목은 옛 WorkbenchView 의 콜백 하나와 1:1 이다. */
export type ExplorerAct =
  | { kind: 'connect'; profileId: string }
  | { kind: 'askAi'; text: string }
  | { kind: 'sendInput'; text: string }
  | { kind: 'launch'; id: 'port' | 'sys' | 'term'; profileId: string | null; cwd?: string }
  | { kind: 'aiCli'; profileId: string | null; path: string }
  | { kind: 'saveWork'; profileId: string | null; path: string }
  | { kind: 'workAction'; id: string; workId: string }
