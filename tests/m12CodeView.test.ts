// M12 R1 코드 보기 2차 — 탐색기 트리 펴기(CV-01)·git 색·폴더 감시 거르기·뷰어 종류(CV-02)·워크트리 점프 목록(CV-03). 순수 함수만.
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@shared/ipc'
import type { Worktree } from '@shared/worktrees'
import { DEFAULT_SORT, closeOpen, gitDecorations, treeRows, viewEntries } from '../src/renderer/store/fileView'
import { mediaOf } from '@shared/media'
import { jumpList } from '../src/renderer/features/aiws/jumpList'
import { treeEventCounts } from '../src/main/work/backend'

const f = (name: string, type: 'dir' | 'file' = 'file'): FileEntry => ({ name, type, size: 0, mtime: 0 })
const opts = { showHidden: true, sort: DEFAULT_SORT, filter: '' }

describe('treeRows — 펼친 폴더를 줄로(Orca row projection)', () => {
  it('하위 줄은 상대 경로 이름·깊이·보이는 이름을 갖고, 폴더 바로 뒤에 온다', () => {
    const rows = treeRows([f('b.txt'), f('src', 'dir')], { src: [f('a.ts'), f('lib', 'dir')], 'src/lib': [f('x.ts')] }, opts, '/')
    expect(rows.map((r) => [r.name, r.label, r.depth])).toEqual([
      ['src', 'src', 0],
      ['src/lib', 'lib', 1],
      ['src/lib/x.ts', 'x.ts', 2],
      ['src/a.ts', 'a.ts', 1],
      ['b.txt', 'b.txt', 0]
    ])
  })
  it('Windows 구분자로 잇는다(조작이 joinPath(path, name) 으로 그대로 돈다)', () => {
    const rows = treeRows([f('src', 'dir')], { src: [f('a.ts')] }, opts, '\\')
    expect(rows[1].name).toBe('src\\a.ts')
  })
  it('이름 검색은 맨 위 층만 거른다', () => {
    const rows = treeRows([f('src', 'dir'), f('readme.md')], { src: [f('zzz.ts')] }, { ...opts, filter: 'src' }, '/')
    expect(rows.map((r) => r.name)).toEqual(['src', 'src/zzz.ts'])
  })
  it('접으면 그 아래 펼침도 지운다(형제는 그대로)', () => {
    expect(Object.keys(closeOpen({ a: 1, 'a/b': 2, ab: 3 }, 'a', '/'))).toEqual(['ab'])
  })
})

describe('이름 순서 — 숫자는 수로(Orca natural order)', () => {
  it('9 · 99 · 100', () => {
    expect(viewEntries([f('100'), f('9'), f('99')], opts).map((e) => e.name)).toEqual(['9', '99', '100'])
  })
})

describe('gitDecorations — 탐색기 git 색', () => {
  it('파일 상태 + 바뀐 것이 든 폴더, 작업 트리 쪽이 스테이징을 이긴다', () => {
    const d = gitDecorations([
      { path: 'src/a.ts', status: 'added', area: 'staged' },
      { path: 'src/a.ts', status: 'modified', area: 'unstaged' },
      { path: 'docs/x/y.md', status: 'untracked', area: 'untracked' }
    ])
    expect(d.files.get('src/a.ts')).toBe('modified')
    expect([...d.dirs].sort()).toEqual(['docs', 'docs/x', 'src'])
  })
})

describe('treeEventCounts — 폴더 감시가 세는 변경', () => {
  it('.git 안에서는 index·HEAD 만', () => {
    expect(treeEventCounts('src\\a.ts')).toBe(true)
    expect(treeEventCounts('.git/index')).toBe(true)
    expect(treeEventCounts('.git\\HEAD')).toBe(true)
    expect(treeEventCounts('.git/objects/ab/cd')).toBe(false)
    expect(treeEventCounts('.gitignore')).toBe(true)
    expect(treeEventCounts(null)).toBe(true)
  })
})

describe('mediaOf — 뷰어로 여는 종류', () => {
  it('확장자(대소문자 무시)로 종류·MIME, 글 파일은 null', () => {
    expect(mediaOf('C:\\a\\Shot.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
    expect(mediaOf('/srv/doc.pdf')?.kind).toBe('pdf')
    expect(mediaOf('a.mp3')?.kind).toBe('audio')
    expect(mediaOf('a.webm')?.kind).toBe('video')
    expect(mediaOf('a.ts')).toBeNull()
    expect(mediaOf('.png')).toBeNull()
  })
})

describe('jumpList — 워크트리 점프(Orca 빈 검색 순서·검색)', () => {
  const wt = (id: string, name: string, branch = 'refs/heads/' + name): Worktree =>
    ({ id, repoId: 'r1', displayName: name, branch, path: '/x/' + name, head: '', isBare: false, isMainWorktree: false }) as unknown as Worktree
  const list = [wt('a', 'alpha'), wt('b', 'beta'), wt('c', 'gamma'), wt('d', 'delta')]
  const repos = [{ id: 'r1', displayName: 'shop-api' }]
  it('빈 검색 — 지금 것을 빼고, 다녀간 것 최근 순 → 나머지 이름 순', () => {
    const v = new Map([
      ['c', 10],
      ['d', 20],
      ['a', 30]
    ])
    expect(jumpList(list, repos, 'a', '', v).map((w) => w.id)).toEqual(['d', 'c', 'b'])
  })
  it('검색 — 브랜치·저장소로도 맞는다', () => {
    expect(jumpList(list, repos, null, 'gam', new Map()).map((w) => w.id)).toEqual(['c'])
    expect(jumpList(list, repos, null, 'shop', new Map())).toHaveLength(4)
    expect(jumpList(list, repos, null, 'zzz', new Map())).toHaveLength(0)
  })
})
