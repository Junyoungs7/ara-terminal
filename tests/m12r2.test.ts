// M12 R2 — 에디터 옵션(Orca 기본값·클램프) · 머지 충돌(porcelain v2 `u` 종류 · 진행 중 작업 감지 · 중단 — 진짜 git) · 충돌 블록이 3-way 구역으로.
// 키 정리(Ctrl+Shift+J 공간별)는 tests/keymap.test.ts, 언어 하이라이트는 tests/monacoLanguages/(Orca 시험), 충돌 장식은 tests/conflictMarkers.test.ts(Orca 시험).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EDITOR_PREFS, editorPrefsOf } from '../src/shared/editorPrefs'
import { parseStatusV2 } from '../src/shared/gitDiff'
import { readGitStatus } from '../src/main/git/inspect'
import { abortOperation } from '../src/main/scm/git'
import { buildGitConflictDecorations, findGitConflictBlocks, getNextConflictNavigationIndex } from '../src/renderer/features/aiws/conflictMarkers'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import type { UiState } from '../src/shared/types'

describe('에디터 옵션 — Orca 기본값', () => {
  it('미지정이면 줄바꿈 켬·미니맵 끔·글꼴 빈 값(터미널 글꼴)·미리 보기 탭 켬·변경 보기 한 줄', () => {
    expect(DEFAULT_EDITOR_PREFS).toEqual({ wordWrap: true, minimap: false, fontFamily: '', previewTabs: true, diffView: 'inline', autoSave: false, autoSaveDelayMs: 1000, fontZoom: 0 }) // 3차 R2-B 자동 저장·확대(Orca 기본값)
    expect(editorPrefsOf(undefined)).toEqual(DEFAULT_EDITOR_PREFS)
    expect(prefsFrom({} as UiState).codeEditor).toEqual(DEFAULT_EDITOR_PREFS)
  })
  it('손상 값은 기본으로, 글꼴은 CSS 로 새는 글자를 빼고 자른다', () => {
    const p = editorPrefsOf({ wordWrap: 'yes', minimap: true, fontFamily: ' Consolas; } body { x\n', previewTabs: false, diffView: 'split' })
    expect(p).toEqual({ wordWrap: true, minimap: true, fontFamily: 'Consolas  body  x', previewTabs: false, diffView: 'inline', autoSave: false, autoSaveDelayMs: 1000, fontZoom: 0 })
    expect(editorPrefsOf({ diffView: 'side-by-side' }).diffView).toBe('side-by-side')
    expect(editorPrefsOf({ fontFamily: 'x'.repeat(500) }).fontFamily).toHaveLength(200)
  })
})

describe('머지 충돌 — git status 의 u 레코드', () => {
  const u = (xy: string, path: string, mode = '100644') => `u ${xy} N... ${mode} ${mode} ${mode} ${mode} h1 h2 h3 ${path}`
  it('XY → 충돌 종류(Orca parseConflictKind), 경로의 공백 그대로', () => {
    const kinds = { UU: 'both_modified', AA: 'both_added', DD: 'both_deleted', AU: 'added_by_us', UA: 'added_by_them', DU: 'deleted_by_us', UD: 'deleted_by_them' }
    const out = parseStatusV2(Object.keys(kinds).map((xy, i) => u(xy, `dir/f ${i}.txt`)).join('\0') + '\0')
    expect(out.entries.map((e) => [e.path, e.status, e.conflictKind])).toEqual(Object.values(kinds).map((k, i) => [`dir/f ${i}.txt`, 'conflicted', k]))
  })
  it('서브모듈 충돌(160000)은 종류 없이 남는다 — 커밋은 막히되 편집기로 열지 않는다', () => {
    const out = parseStatusV2(u('UU', 'sub', '160000') + '\0')
    expect(out.entries).toEqual([{ path: 'sub', status: 'conflicted', area: 'unstaged' }])
  })
})

describe('머지 충돌 — 3-way 구역(현재 · 공통 조상 · 들어오는)', () => {
  it('diff3 블록이면 세 구역, 라벨은 넘긴 말로', () => {
    const text = ['a', '<<<<<<< HEAD', 'ours', '||||||| base', 'base', '=======', 'theirs', '>>>>>>> other', 'z'].join('\n')
    expect(findGitConflictBlocks(text)).toEqual([{ startLine: 2, baseLine: 4, separatorLine: 6, endLine: 8 }])
    const d = buildGitConflictDecorations(text, { current: '현재', base: '조상', incoming: '들어옴', end: '끝' })
    expect(d.filter((x) => x.options.className?.includes('section')).map((x) => [x.range.startLineNumber, x.options.className])).toEqual([
      [3, 'orca-conflict-section-line orca-conflict-current-line'],
      [5, 'orca-conflict-section-line orca-conflict-base-line'],
      [7, 'orca-conflict-section-line orca-conflict-incoming-line']
    ])
    expect(d.map((x) => x.options.after?.content).filter(Boolean)).toEqual([' 현재', ' 조상', ' 들어옴', ' 끝'])
  })
  it('위·아래 이동은 돌아간다(처음 = 첫 충돌, 이전이면 끝)', () => {
    expect(getNextConflictNavigationIndex({ currentIndex: null, direction: 'next', total: 3 })).toBe(0)
    expect(getNextConflictNavigationIndex({ currentIndex: null, direction: 'previous', total: 3 })).toBe(2)
    expect(getNextConflictNavigationIndex({ currentIndex: 2, direction: 'next', total: 3 })).toBe(0)
    expect(getNextConflictNavigationIndex({ currentIndex: 0, direction: 'next', total: 0 })).toBeNull()
  })
})

describe('머지 충돌 — 진짜 git(로컬): 감지 → 표시 줄 → 중단', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'merge.conflictStyle=diff3', ...a], { cwd, stdio: 'pipe' }).toString()
  it('merge 충돌 → status 가 both_modified·operation merge, 파일엔 3-way 표시 → merge --abort 로 깨끗', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ara-m12r2-'))
    try {
      git(root, 'init', '-q')
      git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      writeFileSync(join(root, 'f.txt'), 'a\nkeep\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', '1')
      git(root, 'checkout', '-qb', 'other')
      writeFileSync(join(root, 'f.txt'), 'theirs\nkeep\n')
      git(root, 'commit', '-qam', '2')
      git(root, 'checkout', '-q', 'main')
      writeFileSync(join(root, 'f.txt'), 'ours\nkeep\n')
      git(root, 'commit', '-qam', '3')
      expect(() => git(root, 'merge', 'other')).toThrow()

      const st = await readGitStatus(root)
      if (!st.ok) throw new Error(st.message)
      expect(st.entries).toEqual([{ path: 'f.txt', status: 'conflicted', area: 'unstaged', conflictKind: 'both_modified' }])
      expect(st.operation).toBe('merge')
      const blocks = findGitConflictBlocks(readFileSync(join(root, 'f.txt'), 'utf8'))
      expect(blocks).toHaveLength(1)
      expect(blocks[0].baseLine).toBeDefined()

      expect((await abortOperation(root, 'merge')).ok).toBe(true)
      const after = await readGitStatus(root)
      expect(after.ok && after.entries).toEqual([])
      expect(after.ok && after.operation).toBeUndefined()
      expect(readFileSync(join(root, 'f.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('ours\nkeep\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
