// M10 WS-14 브랜치 자동 이름 — 새 작업의 이름 칸을 비우면 지어 주는 이름. Orca(orcaRef fdfcfb3551) 그대로:
//  · src/shared/worktree-name-suggestion.ts — 바다 생물 풀에서 안 쓴 이름을 무작위로, 다 쓰면 `-2`·`-3` 단계(tier)로
//  · src/shared/worktree/retired-name-registry.ts — creatureNameAtTier·creatureNameTier(지운 이름 다시 안 내주기)
//  · src/renderer/src/components/sidebar/worktree-name-suggestions.ts — 모든 프로젝트의 워크트리 폴더 이름과 겹치지 않게
//  · src/shared/workspace-name.ts slugifyForWorkspaceName + renderer/lib/new-workspace.ts getWorkspaceSeedName — 이름 > 첫 지시 > 생물 이름
// 뺀 것: 지운 이름 압축(exhaustedTiers 워터마크) — 지운 이름은 목록 그대로 쌓는다(ponytail: 수천 개 지우면 목록이 길어진다 — 그때 Orca compactRetiredNames).
// PR/이슈 번호 시드(pr-12·issue-34)는 이슈 연동이 없어 뺐다. 첫 일로 이름을 바꾸는 것(first-work rename)은 묶음 5 3차.
import { MARINE_CREATURES } from './marineCreatures'

const POOL: ReadonlySet<string> = new Set(MARINE_CREATURES.map((n) => n.toLowerCase()))

export function normalizeSuggestedName(name: string): string {
  return name.trim().toLowerCase()
}

/** 폴더 이름(POSIX·Windows·SSH 경로 모두) — 겹침은 표시 이름이 아니라 디스크의 폴더 이름으로 잰다. */
export function suggestionPathBasename(path: string): string {
  const p = path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 단계 1 = 풀 이름 그대로, N = `이름-N`. */
export function creatureNameAtTier(poolName: string, tier: number): string {
  return tier === 1 ? poolName : `${poolName}-${tier}`
}

/** 자동 이름(풀 이름·단계 붙은 이름)이면 그 단계, 아니면 null. `nautilus-1` 은 자동 이름이 아니다(단계 1 은 맨 이름). */
export function creatureNameTier(name: string): number | null {
  const n = normalizeSuggestedName(name)
  if (POOL.has(n)) return 1
  const m = /^(.+)-([1-9]\d{0,5})$/.exec(n)
  if (!m || !POOL.has(m[1])) return null
  const tier = Number(m[2])
  return tier >= 2 ? tier : null
}

/** 안 쓴 이름을 무작위로 — 풀을 다 썼으면 다음 단계. 지운 이름도 쓴 것으로 친다(같은 폴더에 지난 에이전트 대화가 남아 있을 수 있다). */
export function selectSuggestedCreatureName(usedNames: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set([...usedNames].map(normalizeSuggestedName))
  for (let tier = 1; ; tier += 1) {
    const available = MARINE_CREATURES.map((n) => creatureNameAtTier(n.toLowerCase(), tier)).filter((n) => !used.has(n))
    if (available.length > 0) return available[Math.floor(random() * available.length)]
  }
}

/** 사이드바에 함께 보이니 모든 프로젝트의 살아 있는 이름 + 고른 프로젝트의 지운 이름을 피한다. */
export function getSuggestedCreatureName(
  worktreesByRepo: Readonly<Record<string, readonly { path: string }[]>>,
  random: () => number = Math.random,
  retiredNames: readonly string[] = []
): string {
  const used = new Set<string>()
  for (const list of Object.values(worktreesByRepo)) for (const w of list) used.add(normalizeSuggestedName(suggestionPathBasename(w.path)))
  for (const r of retiredNames) used.add(normalizeSuggestedName(r))
  return selectSuggestedCreatureName(used, random)
}

/** 첫 지시 → 브랜치에 쓸 만한 조각. 영문·숫자만 남는다(한글·이모지는 빠짐 — 남는 게 없으면 생물 이름으로). */
export function slugifyForWorkspaceName(input: string): string {
  return input
    .replace(/[‘’]/g, "'")
    .replace(/([\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1')
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 48)
    .replace(/[-._]+$/g, '')
}

/** 만들 이름 — 사람이 친 이름 > 첫 지시 조각 > 생물 이름 > 'workspace'. */
export function getWorkspaceSeedName(args: { explicitName: string; prompt: string; fallbackName?: string }): string {
  if (args.explicitName.trim()) return args.explicitName.trim()
  if (args.prompt.trim()) {
    const slug = slugifyForWorkspaceName(args.prompt)
    if (slug) return slug
  }
  return args.fallbackName?.trim() || 'workspace'
}
