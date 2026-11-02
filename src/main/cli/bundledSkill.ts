// M14 R2 번들 스킬 `ara-cli` — Orca 번들 스킬 orca-cli(skill-guides/orca-cli.md, `orca skills install --skill orca-cli`)의 아라판.
// 설정 › 스킬에서 [설치]·[업데이트]를 눌렀을 때만 사용자 스킬 폴더에 쓴다(M14 R1 규칙 그대로).
// 원본: 설치본 resources/skills/ara-cli(extraResources), 개발 실행은 저장소 resources/skills/ara-cli — 후보 둘을 existsSync 로 고른다.
import { existsSync } from 'node:fs'
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUNDLED_CLI_SKILL, type BundledSkillStatus } from '@shared/araCli'

/** 번들 스킬을 넣을 홈 뿌리 — Claude 는 ~/.claude/skills, Codex·Gemini 는 함께 읽는 ~/.agents/skills(Orca 기본 대상과 같다). */
export const BUNDLED_SKILL_TARGETS = ['home-claude', 'home-agents'] as const

export function bundledSkillSource(candidates: readonly string[]): string | null {
  return candidates.map((c) => join(c, 'skills', BUNDLED_CLI_SKILL)).find((d) => existsSync(join(d, 'SKILL.md'))) ?? null
}

const readMd = (dir: string): Promise<string | null> => readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null)

export async function bundledSkillStatus(source: string | null, roots: readonly { id: string; path: string }[]): Promise<BundledSkillStatus> {
  const want = source ? await readMd(source) : null
  const targets = await Promise.all(
    roots
      .filter((r) => (BUNDLED_SKILL_TARGETS as readonly string[]).includes(r.id))
      .map(async (r) => {
        const path = join(r.path, BUNDLED_CLI_SKILL)
        const have = await readMd(path)
        return { rootId: r.id, path, state: have === null ? ('missing' as const) : have === want ? ('installed' as const) : ('differs' as const) }
      })
  )
  return { available: want !== null, targets }
}

/** 없으면 폴더째 복사, 있으면(업데이트) 번들 파일만 덮어쓴다 — 사용자가 그 폴더에 더한 파일은 남는다. */
export async function installBundledSkill(source: string | null, roots: readonly { id: string; path: string }[], rootId: unknown): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!source) return { ok: false, error: '이 설치본에 번들 스킬이 없습니다.' }
  const root = roots.find((r) => r.id === rootId && (BUNDLED_SKILL_TARGETS as readonly string[]).includes(r.id))
  if (!root) return { ok: false, error: '잘못된 대상' }
  const dest = join(root.path, BUNDLED_CLI_SKILL)
  try {
    await cp(source, dest, { recursive: true, force: true })
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
