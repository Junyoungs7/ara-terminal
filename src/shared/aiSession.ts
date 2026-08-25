import type { AiCliId } from './aiCli'

/**
 * AI 세션 한 벌(#128) — **작업대**. 설계 §10.5.
 *
 * 아라 대화(관제실)와 다른 물건이다: 관제실은 하나고 우측 레일에 살지만, 작업대는 **여럿**이고
 * 각자 폴더·서버를 갖는다. 터미널 세션과 같은 자리(메인 탭)에 서는 것이 목표다(#130).
 *
 * 이 파일에는 **판단만** 있고 저장·화면은 없다. 껐다 켰을 때 무엇을 되살리고 무엇을 '끊김'으로
 * 둘지가 이 기능의 성격을 정하는데, 그 규칙이 컴포넌트 안에 흩어지면 눈으로만 확인하게 된다.
 */

/** 어디서 도는가. 로컬은 이 PC 의 CLI, 원격은 그 서버의 CLI(터미널 그대로 — 설계 §10.4). */
export type AiSessionKind = 'local' | 'remote'

export type AiSessionState = {
  id: string
  kind: AiSessionKind
  /** remote 일 때만. 프로필이 지워지면 '끊김' 으로 남는다(조용히 다른 서버에 붙이지 않는다). */
  profileId?: string
  cwd: string
  engine: AiCliId
  /**
   * 권한 확인 건너뛰기 — **세션 단위**다(설계 §6 확정 2). 전역 기본값으로 두지 않는 이유:
   * 한 번 켜 두고 잊으면 그다음부터 모든 세션이 그 상태가 된다. 켜져 있으면 화면에 상시 표시한다.
   */
  skipPerms: boolean
  title: string
  lastUsedAt: number
  /** Claude Code 세션 id — `--resume` 으로 대화를 이어 붙인다. 없으면 새 대화다. */
  claudeSessionId?: string
  /** 세션 분리(#133)로 생긴 것. 부모를 지울 때 이 관계를 보고 먼저 알린다. */
  worktree?: { parentId: string; branch: string }
}

/** 복원했을 때의 처지. 화면이 이 값으로 점 색과 안내를 정한다. */
export type AiSessionVerdict =
  /** 쓸 수 있다 — 다만 프로세스는 아직 안 떴다(첫 질문에서 뜬다). */
  | 'idle'
  /** 폴더가 없어졌다 — **조용히 다른 데서 열지 않는다**. */
  | 'noPath'
  /** 그 서버 프로필이 없어졌다. */
  | 'noProfile'

/**
 * 껐다 켰을 때 이 세션을 어떻게 둘 것인가(설계 §10.5 복원 규칙 3).
 *
 * **폴더가 없으면 '끊김'이다.** 홈으로 조용히 떨어뜨리면 사용자는 그 사실을 모르고, 엉뚱한
 * 폴더에서 파일을 고치게 된다. worktree 가 사라진 경우(사용자가 `git worktree remove` 했다)도 같다.
 */
export function restoreVerdict(
  s: Pick<AiSessionState, 'kind' | 'profileId'>,
  facts: { pathExists: boolean; profileExists: boolean }
): AiSessionVerdict {
  // 원격은 프로필이 먼저다 — 서버에 못 붙으면 경로를 볼 방법도 없다.
  if (s.kind === 'remote' && (!s.profileId || !facts.profileExists)) return 'noProfile'
  if (!facts.pathExists) return 'noPath'
  return 'idle'
}

/** 저장값 → 쓸 수 있는 목록. 스냅샷은 신뢰 경계 밖이라 **모양이 안 맞는 항목은 버린다.** */
export function aiSessionsOf(raw: unknown): AiSessionState[] {
  if (!Array.isArray(raw)) return []
  const out: AiSessionState[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const o = item as Record<string, unknown> | null
    if (!o || typeof o.id !== 'string' || o.id === '') continue
    if (typeof o.cwd !== 'string' || o.cwd === '') continue
    if (seen.has(o.id)) continue // 같은 id 가 둘이면 앞의 것만
    seen.add(o.id)
    const kind: AiSessionKind = o.kind === 'remote' ? 'remote' : 'local'
    out.push({
      id: o.id,
      kind,
      ...(kind === 'remote' && typeof o.profileId === 'string' ? { profileId: o.profileId } : {}),
      cwd: o.cwd,
      engine: engineOf(o.engine),
      // 없으면 **끔**. 저장값이 깨졌을 때 권한 확인을 건너뛰는 쪽으로 기울면 안 된다.
      skipPerms: o.skipPerms === true,
      title: typeof o.title === 'string' && o.title !== '' ? o.title : defaultTitle(o.cwd),
      lastUsedAt: typeof o.lastUsedAt === 'number' && Number.isFinite(o.lastUsedAt) ? o.lastUsedAt : 0,
      ...(typeof o.claudeSessionId === 'string' ? { claudeSessionId: o.claudeSessionId } : {}),
      ...worktreeOf(o.worktree)
    })
  }
  return out
}

const ENGINES: readonly AiCliId[] = ['claude', 'codex', 'gemini', 'custom']
function engineOf(v: unknown): AiCliId {
  return ENGINES.includes(v as AiCliId) ? (v as AiCliId) : 'claude'
}

function worktreeOf(v: unknown): { worktree?: { parentId: string; branch: string } } {
  const o = v as Record<string, unknown> | null
  if (!o || typeof o.parentId !== 'string' || typeof o.branch !== 'string') return {}
  return { worktree: { parentId: o.parentId, branch: o.branch } }
}

/** 폴더 이름을 제목으로 — 경로 전체는 길고, 사람이 구분하는 것은 마지막 칸이다. */
export function defaultTitle(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((x) => x !== '')
  return parts[parts.length - 1] ?? cwd
}

/**
 * 목록 순서 — **최근 쓴 것이 위**. 같은 시각이면 제목순(재시작 때마다 순서가 흔들리지 않게).
 * 분리 세션(worktree)은 여기서 부모 밑으로 넣지 않는다 — 그 묶기는 화면의 몫이다(#129).
 */
export function sortAiSessions(list: readonly AiSessionState[]): AiSessionState[] {
  return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.title.localeCompare(b.title, 'ko'))
}

/** 부모를 지울 때 함께 사라질 것들(설계 §10.3 규칙 4 — 먼저 알린다). */
export function childrenOf(list: readonly AiSessionState[], parentId: string): AiSessionState[] {
  return list.filter((s) => s.worktree?.parentId === parentId)
}
