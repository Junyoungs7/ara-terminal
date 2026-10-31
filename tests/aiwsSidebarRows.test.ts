// M2 라운드 2 WS-05 — 사이드바 줄(필터·핀·정렬·묶기). 순수 함수라 화면 없이 돈다.
import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '@shared/worktrees'
import { buildSidebarRows, type SidebarInput, type SidebarRow } from '../src/renderer/features/aiws/sidebarRows'
import type { PendingWorktreeCreation } from '../src/renderer/features/aiws/store'

const api: Project = { id: 'api', path: 'C:/api', displayName: 'api', kind: 'git', addedAt: 0 }
const web: Project = { id: 'web', path: 'C:/web', displayName: 'web', kind: 'git', addedAt: 1 }
const notes: Project = { id: 'notes', path: 'C:/notes', displayName: 'notes', kind: 'folder', addedAt: 2 }

const wt = (repo: Project, name: string, main = false): Worktree => ({
  id: `${repo.id}::${main ? repo.path : `C:/ws/${repo.id}/${name}`}`,
  repoId: repo.id,
  path: main ? repo.path : `C:/ws/${repo.id}/${name}`,
  head: 'h',
  branch: repo.kind === 'folder' ? '' : `refs/heads/${name}`,
  isBare: false,
  isMainWorktree: main,
  displayName: name
})

const apiMain = wt(api, 'main', true)
const apiZeta = wt(api, 'zeta')
const apiAlpha = wt(api, 'alpha')
const webMain = wt(web, 'main', true)
const webFix = wt(web, 'fix-login')
const notesRow = { ...wt(notes, 'notes', true) }

const pend: PendingWorktreeCreation = { creationId: 'c1', repoId: 'web', name: 'new-thing', startedAt: 5, phase: 'creating', output: '' }

const base: SidebarInput = {
  repos: [api, web, notes],
  worktreesByRepo: { api: [apiZeta, apiMain, apiAlpha], web: [webFix, webMain], notes: [notesRow] },
  pending: [],
  pinnedIds: [],
  query: '',
  groupBy: 'repo'
}

const keys = (rows: SidebarRow[]): string[] =>
  rows.map((r) => (r.kind === 'header' ? `# ${r.key} (${r.count})` : r.kind === 'pending' ? `… ${r.creation.name}` : `${r.worktree.displayName}${r.showProject ? ` @${r.repo.displayName}` : ''}`))

describe('buildSidebarRows', () => {
  it('프로젝트별 묶음 — 본 폴더 먼저, 나머지는 이름순. 워크트리 없는 폴더 프로젝트도 한 줄', () => {
    expect(keys(buildSidebarRows(base))).toEqual([
      '# repo:api (3)', 'main', 'alpha', 'zeta',
      '# repo:web (2)', 'main', 'fix-login',
      '# repo:notes (1)', 'notes'
    ])
  })

  it('고정 — 맨 위 묶음으로 옮기고 제 묶음에서 뺀다(프로젝트 이름을 붙인다)', () => {
    const rows = buildSidebarRows({ ...base, pinnedIds: [webFix.id, apiZeta.id] })
    expect(keys(rows)).toEqual([
      '# pinned (2)', 'fix-login @web', 'zeta @api',
      '# repo:api (2)', 'main', 'alpha',
      '# repo:web (1)', 'main',
      '# repo:notes (1)', 'notes'
    ])
    expect(rows.filter((r) => r.kind === 'item' && r.pinned)).toHaveLength(2)
  })

  it('없어진 워크트리의 핀은 무시한다', () => {
    expect(keys(buildSidebarRows({ ...base, pinnedIds: ['gone::x'] }))[0]).toBe('# repo:api (3)')
  })

  it('이름 검색 — 이름·브랜치·경로·프로젝트 부분 일치, 대소문자 무시. 맞는 게 없는 프로젝트는 숨김', () => {
    expect(keys(buildSidebarRows({ ...base, query: '  LOGIN ' }))).toEqual(['# repo:web (1)', 'fix-login'])
    // 프로젝트 이름이 맞으면 그 프로젝트의 줄 전부.
    expect(keys(buildSidebarRows({ ...base, query: 'notes' }))).toEqual(['# repo:notes (1)', 'notes'])
    expect(buildSidebarRows({ ...base, query: 'nothing-matches' })).toEqual([])
  })

  it('검색은 고정 묶음에도 걸린다', () => {
    expect(keys(buildSidebarRows({ ...base, pinnedIds: [webFix.id, apiZeta.id], query: 'zeta' }))).toEqual(['# pinned (1)', 'zeta @api'])
  })

  it('만드는 중인 줄은 그 프로젝트 머리줄 바로 아래(검색어가 이름에 맞을 때만)', () => {
    const rows = buildSidebarRows({ ...base, pending: [pend] })
    expect(keys(rows).slice(4, 8)).toEqual(['# repo:web (2)', '… new-thing', 'main', 'fix-login'])
    expect(keys(buildSidebarRows({ ...base, pending: [pend], query: 'alpha' }))).toEqual(['# repo:api (1)', 'alpha'])
  })

  it('검색이 아니면 빈 프로젝트도 머리줄은 보인다(+ 를 누를 자리)', () => {
    expect(keys(buildSidebarRows({ ...base, worktreesByRepo: {} }))).toEqual(['# repo:api (0)', '# repo:web (0)', '# repo:notes (0)'])
  })

  it('묶기 none — 전체 한 묶음, 프로젝트 이름을 붙이고 본 폴더들이 먼저', () => {
    expect(keys(buildSidebarRows({ ...base, groupBy: 'none', pending: [pend], pinnedIds: [apiAlpha.id] }))).toEqual([
      '# pinned (1)', 'alpha @api',
      '# all (5)', '… new-thing', 'main @api', 'main @web', 'notes @notes', 'fix-login @web', 'zeta @api'
    ])
  })
})
