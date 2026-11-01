// M11 지난 세션 2차 — 범위·필터·정렬·묶기(순수). Orca right-sidebar ai-vault-view-defaults·ai-vault-sort-options·use-ai-vault-panel-scope
// (orcaRef fdfcfb3551)의 규칙: 범위 = 이 작업 단위 / 프로젝트 / 전체(기본 작업 단위), 정렬 = 마지막 업데이트(기본)·만든 시각,
// 묶기 = 프로젝트(기본)·폴더·에이전트, 빈 세션 숨기기(기본 끔), 에이전트 켜고 끄기(기본 전부).
import { AGENT_IDS, type AgentId } from '@shared/agents'
import { pathKey, type VaultSession } from '@shared/vault'

export const VAULT_SCOPES = ['worktree', 'project', 'all'] as const
export type VaultScope = (typeof VAULT_SCOPES)[number]
export const VAULT_SORTS = ['updated', 'created'] as const
export type VaultSort = (typeof VAULT_SORTS)[number]
export const VAULT_GROUPS = ['project', 'folder', 'agent'] as const
export type VaultGroup = (typeof VAULT_GROUPS)[number]

export type VaultView = { scope: VaultScope; sort: VaultSort; group: VaultGroup; agents: AgentId[]; hideEmpty: boolean }
export const DEFAULT_VAULT_VIEW: VaultView = { scope: 'worktree', sort: 'updated', group: 'project', agents: [...AGENT_IDS], hideEmpty: false }

/** 저장값(localStorage — 손으로 고칠 수 있다) → 확정값. */
export function vaultViewOf(raw: unknown): VaultView {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof VaultView, unknown>>
  const pick = <T extends string>(all: readonly T[], v: unknown, d: T): T => (all.includes(v as T) ? (v as T) : d)
  return {
    scope: pick(VAULT_SCOPES, o.scope, DEFAULT_VAULT_VIEW.scope),
    sort: pick(VAULT_SORTS, o.sort, DEFAULT_VAULT_VIEW.sort),
    group: pick(VAULT_GROUPS, o.group, DEFAULT_VAULT_VIEW.group),
    agents: Array.isArray(o.agents) ? AGENT_IDS.filter((id) => (o.agents as unknown[]).includes(id)) : [...AGENT_IDS],
    hideEmpty: o.hideEmpty === true
  }
}

/** cwd 가 범위 폴더 중 하나와 같거나 그 안이면 참. scopePaths = null 이면 전체. 폴더 모르는 세션은 '전체'에만. */
export function inScope(cwd: string | null, scopePaths: readonly string[] | null): boolean {
  if (scopePaths === null) return true
  if (!cwd) return false
  const k = pathKey(cwd)
  return scopePaths.some((p) => {
    const root = pathKey(p)
    return k === root || k.startsWith(root + '/')
  })
}

/** 빈 세션 = 사람이 보낸 글이 없다(Orca 는 메시지 0개 — 아라 목록은 머리·꼬리만 읽어 첫 지시·제목 유무로 본다). */
export const isEmptySession = (s: VaultSession): boolean => !s.firstPrompt && !s.title

/** 목록에서 query 로 거르기(Orca 검색 칸: 제목·폴더·미리 보기). 전문 검색 결과(snippet 있음)는 그대로 둔다. */
export function matchesQuery(s: VaultSession, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q || s.snippet) return true
  return [s.title, s.firstPrompt, s.cwd, s.id].some((x) => !!x && x.toLowerCase().includes(q))
}

/** 목록 + 전문 검색 결과 합치기(같은 파일이면 검색 쪽 — 맞은 자리 조각이 있다). */
export function mergeSearch(list: readonly VaultSession[], hits: readonly VaultSession[]): VaultSession[] {
  const byFile = new Map(list.map((s) => [s.file, s]))
  for (const h of hits) byFile.set(h.file, h)
  return [...byFile.values()]
}

export function viewSessions(list: readonly VaultSession[], v: VaultView, scopePaths: readonly string[] | null, query: string): VaultSession[] {
  const time = (s: VaultSession): number => (v.sort === 'created' ? (s.createdAt ?? s.at) : s.at)
  return list
    .filter((s) => v.agents.includes(s.agent) && !(v.hideEmpty && isEmptySession(s)) && inScope(s.cwd, scopePaths) && matchesQuery(s, query))
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id))
}

/** 묶기 — 정렬 순서 그대로, 묶음은 처음 나온 순서(가장 최근 세션이 있는 묶음이 위). */
export function groupSessions(list: readonly VaultSession[], labelOf: (s: VaultSession) => { key: string; label: string }): { key: string; label: string; items: VaultSession[] }[] {
  const out = new Map<string, { key: string; label: string; items: VaultSession[] }>()
  for (const s of list) {
    const { key, label } = labelOf(s)
    const g = out.get(key) ?? { key, label, items: [] }
    g.items.push(s)
    out.set(key, g)
  }
  return [...out.values()]
}
