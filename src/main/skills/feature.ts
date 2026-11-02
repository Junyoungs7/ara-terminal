// M14 R1 AU-02 스킬 관리 — Orca src/main/skills/discovery.ts(뿌리 목록·SKILL.md 찾기) + skill-delete(지우기)의 아라 몫.
// 읽기는 화면을 열 때만. **사용자 폴더(~/.claude/skills 등)에 쓰는 것은 사람이 버튼을 눌렀을 때만**:
//  · 추가 = 사람이 OS 대화상자에서 고른 폴더(SKILL.md 가 있어야)를 고른 뿌리 아래로 복사(같은 이름이 있으면 거절).
//  · 지우기 = 목록에 있던 것만, 확인은 렌더러가. 진짜 폴더는 휴지통으로, 링크(junction·symlink)인 스킬 폴더는 링크만 끊는다.
//    링크된 폴더 안(실제 위치가 다른 곳)이면 원본이 휴지통으로 간다 — 화면이 먼저 밝힌다(realPath).
import { createHash } from 'node:crypto'
import { cp, lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'
import { describeMarkdown } from '@shared/agentOptions'
import { PLUGIN_SKILL_FILE_MAX_DEPTH, SKILL_ADD_TARGETS, SKILL_FILE_MAX_DEPTH, skillDeleteBlock, type DiscoveredSkill, type SkillAgent, type SkillRoot, type SkillScan, type SkillSourceKind } from '@shared/skills'
import { handle } from '../ipc/handle'
import { removeAccountTree } from '../usage/accounts'

const MAX_MD_BYTES = 256 * 1024
const pid = (p: string): string => createHash('sha1').update(resolve(p).toLowerCase()).digest('hex').slice(0, 12)

type RootDef = Omit<SkillRoot, 'exists' | 'realPath'>

/** Orca buildSkillDiscoverySources 의 Claude·Codex·Gemini 뿌리 + 프로젝트 뿌리. */
export function skillRoots(home: string, env: Record<string, string | undefined>, projects: readonly string[]): RootDef[] {
  const r = (id: string, label: string, path: string, sourceKind: SkillSourceKind, agents: SkillAgent[]): RootDef => ({ id, label, path, sourceKind, agents })
  const claudeDir = env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
  const codexDir = env['CODEX_HOME'] || join(home, '.codex')
  return [
    r('home-claude', 'Claude', join(claudeDir, 'skills'), 'home', ['claude']),
    // Orca: Codex 는 오늘 .agents/skills 를 읽고 ~/.codex/skills 는 옛 설치가 남은 자리. .agents 는 Claude 밖 에이전트가 함께 읽는다.
    r('home-agents', 'Agent skills (~/.agents)', join(home, '.agents', 'skills'), 'home', ['codex', 'gemini']),
    r('home-codex', 'Codex', join(codexDir, 'skills'), 'home', ['codex']),
    r('home-gemini', 'Gemini', join(home, '.gemini', 'skills'), 'home', ['gemini']),
    r('plugin-claude', 'Claude plugins', join(claudeDir, 'plugins'), 'plugin', ['claude']),
    r('plugin-codex', 'Codex plugin cache', join(codexDir, 'plugins', 'cache'), 'plugin', ['codex']),
    ...projects.flatMap((p) => [
      r(`repo-claude-${pid(p)}`, `${basename(p)} .claude`, join(p, '.claude', 'skills'), 'repo', ['claude']),
      r(`repo-agents-${pid(p)}`, `${basename(p)} .agents`, join(p, '.agents', 'skills'), 'repo', ['codex', 'gemini'])
    ])
  ]
}

/** SKILL.md 찾기(Orca findSkillFiles) — 깊이 상한, 같은 실제 폴더는 한 번만. */
async function findSkillFiles(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = async (dir: string, depth: number): Promise<void> => {
    let real: string
    try {
      real = await realpath(dir)
    } catch {
      return
    }
    if (seen.has(real)) return
    seen.add(real)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.name === 'SKILL.md') {
        if (e.isFile() || (e.isSymbolicLink() && (await stat(p).catch(() => null))?.isFile())) out.push(p)
        continue
      }
      if (depth + 1 >= maxDepth) continue
      if (e.isDirectory() || (e.isSymbolicLink() && (await stat(p).catch(() => null))?.isDirectory())) await visit(p, depth + 1)
    }
  }
  await visit(root, 0)
  return out
}

export async function scanSkills(defs: readonly RootDef[]): Promise<SkillScan> {
  const roots: SkillRoot[] = []
  const skills: DiscoveredSkill[] = []
  const byName = new Set<string>()
  for (const d of defs) {
    const real = await realpath(d.path).catch(() => null)
    roots.push({ ...d, exists: real !== null, realPath: real && resolve(real) !== resolve(d.path) ? real : null })
    if (!real) continue
    for (const f of await findSkillFiles(d.path, d.sourceKind === 'plugin' ? PLUGIN_SKILL_FILE_MAX_DEPTH : SKILL_FILE_MAX_DEPTH)) {
      const dir = resolve(f, '..')
      if (resolve(dir) === resolve(d.path)) continue // 뿌리 자체의 SKILL.md 는 스킬이 아니다
      const md = await readFile(f, 'utf8').then((s) => s.slice(0, MAX_MD_BYTES)).catch(() => '')
      const desc = describeMarkdown(md)
      const lst = await lstat(dir).catch(() => null)
      const linkTarget = lst?.isSymbolicLink() ? await readlink(dir).catch(() => null) : null
      const dirReal = await realpath(dir).catch(() => dir)
      const id = `${d.id}:${pid(dir)}`
      if (byName.has(id)) continue
      byName.add(id)
      skills.push({
        id,
        name: desc.name || basename(dir),
        description: desc.description,
        rootId: d.id,
        sourceKind: d.sourceKind,
        agents: d.agents,
        directoryPath: dir,
        linkTarget,
        realPath: !linkTarget && resolve(dirReal) !== resolve(dir) ? dirReal : null,
        updatedAt: (await stat(f).catch(() => null))?.mtimeMs ?? null
      })
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, roots, scannedAt: Date.now() }
}

export function registerSkillsFeature(deps: {
  home: string
  env: Record<string, string | undefined>
  projects: () => string[]
  mainWindow: () => BrowserWindow | null
  /** e2e 는 사용자 휴지통에 넣지 않는다 — 링크를 따라가지 않는 removeAccountTree 로. */
  trash?: (p: string) => Promise<void>
}): void {
  const trash = deps.trash ?? (process.env['ARA_E2E'] === '1' ? async (p: string) => removeAccountTree(p) : (p: string) => shell.trashItem(p))
  let known = new Map<string, DiscoveredSkill>()
  const scan = async (): Promise<SkillScan> => {
    const s = await scanSkills(skillRoots(deps.home, deps.env, deps.projects()))
    known = new Map(s.skills.map((x) => [x.id, x]))
    return s
  }
  handle('skills:scan', () => scan())
  handle('skills:delete', async ({ id }) => {
    const s = known.get(id)
    if (!s) return { ok: false, error: '목록에 없는 스킬입니다. 새로 고침 하세요.' }
    if (skillDeleteBlock(s)) return { ok: false, error: '플러그인이 설치한 스킬입니다 — 플러그인을 지우세요.' }
    try {
      const st = await lstat(s.directoryPath).catch(() => null)
      if (!st) return { ok: false, error: '이미 없는 스킬입니다.' }
      // 링크인 스킬 폴더는 링크만 끊는다(대상은 그대로) — 따라 들어가 지우지 않는다.
      if (st.isSymbolicLink()) removeAccountTree(s.directoryPath)
      else await trash(s.directoryPath)
      known.delete(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  // 고르기 — 경로는 OS 대화상자에서 사람이 고른 것만(렌더러가 지어내지 않는다).
  handle('skills:pickFolder', async () => {
    const w = deps.mainWindow()
    const r = w ? await dialog.showOpenDialog(w, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  handle('skills:add', async ({ source, target }) => addSkill(skillRoots(deps.home, deps.env, []), source, target))
}

/** 고른 폴더(SKILL.md 필수)를 고른 홈 뿌리 아래 같은 이름으로 복사. 있으면 거절(덮어쓰지 않는다). */
export async function addSkill(defs: readonly RootDef[], source: unknown, target: unknown): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof source !== 'string' || !SKILL_ADD_TARGETS.includes(target as never)) return { ok: false, error: '잘못된 요청' }
  const root = defs.find((d) => d.id === target)
  if (!root) return { ok: false, error: '잘못된 대상' }
  if (!(await stat(join(source, 'SKILL.md')).catch(() => null))?.isFile()) return { ok: false, error: '고른 폴더에 SKILL.md 가 없습니다.' }
  const dest = join(root.path, basename(resolve(source)))
  if (await lstat(dest).catch(() => null)) return { ok: false, error: `같은 이름의 스킬이 이미 있습니다: ${dest}` }
  try {
    await cp(source, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
    return { ok: true, path: dest }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
