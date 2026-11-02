// M14 R1 AU-02 스킬 관리 — Orca src/shared/skills.ts · skill-deletion-eligibility.ts 의 아라 에이전트(Claude·Codex·Gemini) 부분.
export type SkillAgent = 'claude' | 'codex' | 'gemini'
export const SKILL_AGENTS: readonly SkillAgent[] = ['claude', 'codex', 'gemini']
export type SkillSourceKind = 'home' | 'repo' | 'plugin'

export type SkillRoot = {
  id: string
  label: string
  path: string
  sourceKind: SkillSourceKind
  agents: SkillAgent[]
  exists: boolean
  /** 이 뿌리 폴더가 링크(또는 링크 아래)라 실제 위치가 다르면 그 실제 위치. */
  realPath: string | null
}

export type DiscoveredSkill = {
  id: string
  name: string
  description: string | null
  rootId: string
  sourceKind: SkillSourceKind
  agents: SkillAgent[]
  directoryPath: string
  /** 스킬 폴더 자체가 링크(junction·symlink)면 그 대상 — 지우면 링크만 끊는다. */
  linkTarget: string | null
  /** 링크된 폴더 안에 있어 실제 파일이 다른 곳이면 그 실제 위치 — 지우면 원본이 지워진다. */
  realPath: string | null
  updatedAt: number | null
}

export type SkillScan = { skills: DiscoveredSkill[]; roots: SkillRoot[]; scannedAt: number }

/** 홈 뿌리(추가할 수 있는 자리) — Orca SKILL_INSTALL_PROVIDERS·buildSkillDiscoverySources 의 세 에이전트 몫. */
export const SKILL_ADD_TARGETS = ['home-claude', 'home-agents', 'home-codex', 'home-gemini'] as const
export type SkillAddTarget = (typeof SKILL_ADD_TARGETS)[number]

/** Orca SKILL_FILE_MAX_DEPTH / PLUGIN_SKILL_FILE_MAX_DEPTH. */
export const SKILL_FILE_MAX_DEPTH = 5
export const PLUGIN_SKILL_FILE_MAX_DEPTH = 10

export type SkillDeleteBlock = 'plugin' | 'missing'
/** Orca skillSourceKindDeletionEligibility — 플러그인 것은 플러그인을 지워야 한다. */
export function skillDeleteBlock(skill: Pick<DiscoveredSkill, 'sourceKind'>): SkillDeleteBlock | null {
  return skill.sourceKind === 'plugin' ? 'plugin' : null
}
