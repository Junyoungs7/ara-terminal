// 지난 세션 로그 독립 창의 진입 해시와, 그 창이 보여 줄 대상 (2026-10-29 준영님 요청 —
// "지난 세션 로그를 클릭하면 … 내용은 창으로 띄워서 거기에 보여주게 해줘").
//
// 포트·탐색기 창(portWin.ts·explorerWin.ts)과 같은 구조다: 해시 하나, 매개변수 없음, 창은 하나.
// 어느 로그를 볼지는 main 이 들고 있다가 창이 뜨면 건네고(pastlog:hello), 떠 있으면 바로 민다(pastlog:show).
import type { PastLog } from '../main/log/SessionLog'

export const PASTLOG_WIN_HASH = '#pastlogwin'

export function isPastLogWinHash(hash: string): boolean {
  return hash === PASTLOG_WIN_HASH
}

/** file 은 로그 폴더 안 파일 **이름**이다(경로 아님 — 렌더러는 경로를 모른다). */
export type PastLogTarget = Pick<PastLog, 'file' | 'serverKey' | 'startedAt'>
