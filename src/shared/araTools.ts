/**
 * 아라 도구 묶음의 이름표(2026-08-26 준영님 지시).
 *
 * *"우리 도구가 많다보니까 전체 도구를 그냥 주는것보다 그룹화해서 먼저 그룹에서 선택,
 * 그리고 그 그룹에서 도구 선택할 수 있게 비슷한 도구끼리 모아놓자."*
 *
 * **shared 에 두는 이유**: 이 표를 두 곳이 본다 — 실제 등록(`main/mcp/tools.ts`)과 말투 글
 * (`araPersona.ts`, 아라가 열 때 읽는 지도). 한쪽만 고치면 아라가 없는 묶음을 부르거나
 * 있는 묶음을 모른다.
 */
export const GROUPS = {
  session: '터미널 탭 — 서버 접속, 탭 열기·닫기, 명령 입력, 화면 읽기',
  server: '서버 상태 — 프로세스·서비스·디스크·패키지·컨테이너·k8s·tmux (정해진 명령만, 결과는 표로)',
  file: '원격 파일 — 목록·읽기·쓰기·올리기·내려받기·이름 바꾸기·삭제',
  net: '포트와 브라우저 — 원격 포트 끌어오기, 아라 브라우저에 띄우기',
  record: '기록 — 지난 세션 내역, 원격 로그 파일, 명령 히스토리',
  ai: 'AI 작업대 — 사용자가 띄워 둔 AI CLI 자리 목록·지시',
  ask: '사람에게 되묻기'
} as const

export type ToolGroup = keyof typeof GROUPS

/** 묶음 목록을 글로. ara_tools 응답과 말투 글이 **같은 문장**을 쓴다. */
export function groupLines(): string {
  return Object.entries(GROUPS)
    .map(([id, desc]) => `- ${id}: ${desc}`)
    .join('\n')
}
