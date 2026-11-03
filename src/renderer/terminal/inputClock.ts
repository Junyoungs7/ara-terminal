// p3-M21 에이전트 잠재우기 — 탭별 마지막 키 입력 시각(Orca lastTerminalInputAtByPaneKey). TerminalPane 이 적고, AI 작업 공간의
// 잠재우기(features/aiws/hibernation.ts)가 읽는다. 끝난 뒤 사람이 친 글(보내지 않은 초안 포함)이 있으면 재우지 않는다.
// ponytail: 터미널이 보내는 응답(포커스·마우스 보고)도 입력으로 센다 — 재우는 쪽으로만 보수적이라 그대로 둔다.
export const lastInputAt = new Map<string, number>()
