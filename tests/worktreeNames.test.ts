// M10 WS-14 브랜치 자동 이름 — Orca 시험(orcaRef fdfcfb3551) 옮김:
//  src/shared/worktree-name-suggestion.test.ts · src/renderer/src/components/sidebar/worktree-name-suggestions.test.ts ·
//  src/shared/workspace-name.test.ts(slugify) · retired-name-registry.test.ts(creatureNameTier 일부). 워터마크(exhaustedTiers) 갈래는 뺐다(옮기지 않은 기능).
import { describe, expect, it } from 'vitest'
import { MARINE_CREATURES } from '../src/shared/marineCreatures'
import {
  creatureNameTier,
  getSuggestedCreatureName,
  getWorkspaceSeedName,
  selectSuggestedCreatureName,
  slugifyForWorkspaceName,
  suggestionPathBasename
} from '../src/shared/worktreeNames'
import { sanitizeWorktreeName } from '../src/shared/worktrees'

const pickFirst = () => 0
const lower = (index: number) => MARINE_CREATURES[index].toLowerCase()

describe('suggestionPathBasename', () => {
  it('handles POSIX, Windows, and trailing separators identically', () => {
    expect(suggestionPathBasename('/tmp/worktrees/Nautilus')).toBe('Nautilus')
    expect(suggestionPathBasename('C:\\worktrees\\Nautilus')).toBe('Nautilus')
    expect(suggestionPathBasename('/tmp/worktrees/Nautilus///')).toBe('Nautilus')
    expect(suggestionPathBasename('C:\\worktrees\\Nautilus\\\\')).toBe('Nautilus')
  })
})

describe('selectSuggestedCreatureName', () => {
  it('skips used names when picking the first available', () => {
    expect(selectSuggestedCreatureName([lower(0)], pickFirst)).toBe(lower(1))
  })
  it('degrades to a suffixed tier once every base name is spent', () => {
    expect(selectSuggestedCreatureName(MARINE_CREATURES.map((n) => n.toLowerCase()), pickFirst)).toBe(`${lower(0)}-2`)
  })
  it('does not rewind onto a spent variant within a tier', () => {
    expect(selectSuggestedCreatureName([...MARINE_CREATURES.map((n) => n.toLowerCase()), `${lower(0)}-2`], pickFirst)).toBe(`${lower(1)}-2`)
  })
  it('advances to the next tier when a whole tier is spent', () => {
    const all = [...MARINE_CREATURES.map((n) => n.toLowerCase()), ...MARINE_CREATURES.map((n) => `${n.toLowerCase()}-2`)]
    expect(selectSuggestedCreatureName(all, pickFirst)).toBe(`${lower(0)}-3`)
  })
})

describe('getSuggestedCreatureName', () => {
  it('dedupes against worktrees in EVERY repo, not just one', () => {
    expect(getSuggestedCreatureName({ 'repo-1': [{ path: '/tmp/worktrees/Nautilus' }], 'repo-2': [{ path: '/tmp/worktrees/Seahorse' }] }, pickFirst)).toBe(lower(2))
  })
  it('never reissues a retired name whose workspace is already deleted', () => {
    expect(getSuggestedCreatureName({}, pickFirst, [MARINE_CREATURES[0]])).toBe(lower(1))
  })
  it('treats retired names case-insensitively', () => {
    expect(getSuggestedCreatureName({}, pickFirst, [MARINE_CREATURES[0].toUpperCase()])).toBe(lower(1))
  })
  it('retires names on top of live worktrees rather than replacing that check', () => {
    expect(getSuggestedCreatureName({ 'repo-1': [{ path: `/tmp/worktrees/${MARINE_CREATURES[0]}` }] }, pickFirst, [MARINE_CREATURES[1]])).toBe(lower(2))
  })
  it('skips a retired suffixed variant when falling back past an exhausted pool', () => {
    const allUsed = MARINE_CREATURES.map((name) => ({ path: `/tmp/worktrees/${name}` }))
    expect(getSuggestedCreatureName({ 'repo-1': allUsed }, pickFirst, [`${lower(0)}-2`])).toBe(`${lower(1)}-2`)
  })
  it('handles Windows-style worktree paths when deriving used basenames', () => {
    expect(getSuggestedCreatureName({ 'repo-1': [{ path: 'C:\\worktrees\\Nautilus' }] }, pickFirst)).toBe(lower(1))
  })
})

describe('creatureNameTier', () => {
  it('pool names are tier 1, name-N is tier N, others are not generated', () => {
    expect(creatureNameTier('Nautilus')).toBe(1)
    expect(creatureNameTier('nautilus-3')).toBe(3)
    expect(creatureNameTier('nautilus-1')).toBeNull()
    expect(creatureNameTier('fix-login')).toBeNull()
  })
  it('자동 이름은 main 의 이름 다듬기(sanitize)를 그대로 지난다 — 은퇴 목록과 폴더 이름이 같은 글자', () => {
    for (const n of MARINE_CREATURES) expect(sanitizeWorktreeName(n.toLowerCase())).toBe(n.toLowerCase())
  })
})

describe('slugifyForWorkspaceName', () => {
  it('keeps workspace seed slugs short, ascii-safe, and git-ref-safe', () => {
    expect(slugifyForWorkspaceName('../../Fix mobile Tasks 🚀')).toBe('fix-mobile-tasks')
    expect(slugifyForWorkspaceName('feature/add issue drawer')).toBe('feature-add-issue-drawer')
    expect(slugifyForWorkspaceName('a'.repeat(80))).toBe('a'.repeat(48))
  })
  it('removes apostrophes inside words instead of splitting them', () => {
    expect(slugifyForWorkspaceName("Can't enable browser notifications")).toBe('cant-enable-browser-notifications')
    expect(slugifyForWorkspaceName('Can’t enable browser notifications')).toBe('cant-enable-browser-notifications')
  })
})

describe('getWorkspaceSeedName', () => {
  it('친 이름 > 첫 지시 조각 > 생물 이름 > workspace', () => {
    expect(getWorkspaceSeedName({ explicitName: ' my-fix ', prompt: 'Add login', fallbackName: 'nautilus' })).toBe('my-fix')
    expect(getWorkspaceSeedName({ explicitName: '', prompt: 'Add login page', fallbackName: 'nautilus' })).toBe('add-login-page')
    // 한글만인 지시는 조각이 비어 생물 이름(Orca: CJK 는 sanitize 로 사라질 수 있어 안정된 대체가 필요).
    expect(getWorkspaceSeedName({ explicitName: '', prompt: '로그인 고쳐 줘', fallbackName: 'nautilus' })).toBe('nautilus')
    expect(getWorkspaceSeedName({ explicitName: '', prompt: '' })).toBe('workspace')
  })
})
