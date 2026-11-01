/**
 * M3 S1 데이터 이전 — 옛 터미널 AI **작업대**(workspace.json `aiSessions`, #128)를 읽기만 한다.
 *
 * 작업대 화면·실행은 지웠다(에이전트는 AI 작업 공간에서 띄운다). 남은 일은 한 번뿐이다: 로컬 줄의 폴더를
 * AI 작업 공간 프로젝트로 가져오고, 원격 줄은 옮길 곳이 아직 없어(원격 에이전트 = M8) 개수만 알린다.
 * 대화 내용은 CLI 자기 저장소(`~/.claude/projects` 등)에 있어 옮길 것이 폴더 목록뿐이다(제거 목록 §2).
 * 저장값은 신뢰 경계 밖이라 모양이 안 맞는 줄은 버린다.
 */
export type LegacyAiSessions = { local: string[]; remote: number }

export function legacyAiSessions(raw: unknown): LegacyAiSessions {
  const out: LegacyAiSessions = { local: [], remote: 0 }
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    const o = item as Record<string, unknown> | null
    if (!o || typeof o.cwd !== 'string' || o.cwd === '') continue
    if (o.kind === 'remote') out.remote++
    else if (!out.local.includes(o.cwd)) out.local.push(o.cwd)
  }
  return out
}
