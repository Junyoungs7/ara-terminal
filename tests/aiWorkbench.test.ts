// #129 작업대 목록 — **점 하나가 무엇을 말하는가**, 그리고 같은 조합을 두 번 만들지 않는가.
// 화면(AiBenchTree)은 이 결과를 그리기만 한다.
import { describe, it, expect } from 'vitest'
import { benchRows, sameBench, upsertBench } from '../src/renderer/store/aiWorkbench'
import type { AiSessionState } from '../src/shared/aiSession'

const mk = (over: Partial<AiSessionState> = {}): AiSessionState => ({
  id: 'b1',
  kind: 'local',
  cwd: 'D:/work/app',
  engine: 'claude',
  skipPerms: false,
  title: 'app',
  lastUsedAt: 10,
  ...over
})

const facts = (over: Partial<Parameters<typeof benchRows>[1]> = {}) => ({
  sessionOf: () => null,
  isQuiet: () => false,
  pathExists: () => true,
  profileExists: () => true,
  ...over
})

describe('작업대 적립', () => {
  it('★ 같은 조합은 하나다 — 같은 폴더에서 두 번 띄워도 목록이 늘지 않는다', () => {
    const one = upsertBench([], { kind: 'local', cwd: 'D:/a', engine: 'claude', skipPerms: false }, 100, () => 'x1')
    const two = upsertBench(one, { kind: 'local', cwd: 'D:/a', engine: 'claude', skipPerms: false }, 200, () => 'x2')
    expect(two).toHaveLength(1)
    expect(two[0]!.lastUsedAt).toBe(200) // 시각만 갱신
  })

  it('제목·분리 관계는 덮지 않는다 — 사람이 붙인 이름을 재실행이 지우면 안 된다', () => {
    const base = [mk({ id: 'b1', title: '내가 붙인 이름', worktree: { parentId: 'p', branch: 'ara/x' } })]
    const after = upsertBench(base, { kind: 'local', cwd: 'D:/work/app', engine: 'claude', skipPerms: true }, 50, () => 'new')
    expect(after[0]!.title).toBe('내가 붙인 이름')
    expect(after[0]!.worktree?.branch).toBe('ara/x')
    expect(after[0]!.skipPerms).toBe(true) // 플래그는 이번 실행 값을 따른다
  })

  it('서버·폴더·엔진 중 하나만 달라도 다른 작업대다', () => {
    const b = mk({ kind: 'remote', profileId: 'p1' })
    expect(sameBench({ kind: 'remote', profileId: 'p1', cwd: b.cwd, engine: 'claude' }, b)).toBe(true)
    expect(sameBench({ kind: 'remote', profileId: 'p2', cwd: b.cwd, engine: 'claude' }, b)).toBe(false)
    expect(sameBench({ kind: 'local', cwd: b.cwd, engine: 'claude' }, b)).toBe(false)
    expect(sameBench({ kind: 'remote', profileId: 'p1', cwd: b.cwd, engine: 'codex' }, b)).toBe(false)
  })
})

describe('점이 말하는 것', () => {
  it('살아 있으면 돌거나 조용하다 — 조용함 판정은 F30 값을 그대로 쓴다', () => {
    const list = [mk()]
    expect(benchRows(list, facts({ sessionOf: () => 's1' }))[0]!.status).toBe('live')
    expect(benchRows(list, facts({ sessionOf: () => 's1', isQuiet: () => true }))[0]!.status).toBe('quiet')
  })

  it('안 떠 있으면 쉬는 중 · 폴더가 없으면 끊김', () => {
    expect(benchRows([mk()], facts())[0]!.status).toBe('idle')
    expect(benchRows([mk()], facts({ pathExists: () => false }))[0]!.status).toBe('noPath')
  })

  it('★ 아직 안 본 폴더는 끊김이 아니다 — 모른다고 빨간 점을 켜지 않는다', () => {
    expect(benchRows([mk()], facts({ pathExists: () => undefined }))[0]!.status).toBe('idle')
  })

  it('원격은 프로필이 없으면 끊김', () => {
    const r = [mk({ kind: 'remote', profileId: 'p1' })]
    expect(benchRows(r, facts({ profileExists: () => false }))[0]!.status).toBe('noProfile')
  })
})

describe('줄 세우기', () => {
  it('★ 분리 세션은 부모 바로 밑에 한 칸 들어간다 — 지울 때 뭐가 딸려 가는지 보여야 한다', () => {
    const list = [
      mk({ id: 'p1', title: 'app', lastUsedAt: 1 }),
      mk({ id: 'c1', title: 'refactor', lastUsedAt: 9, worktree: { parentId: 'p1', branch: 'ara/refactor' } }),
      mk({ id: 'p2', title: 'other', lastUsedAt: 5 })
    ]
    const rows = benchRows(list, facts())
    expect(rows.map((r) => [r.s.id, r.depth])).toEqual([
      ['p2', 0], // 최근 쓴 부모가 위
      ['p1', 0],
      ['c1', 1]
    ])
  })

  it('부모를 잃은 분리 세션도 보여 준다 — 안 보이면 지울 방법이 없다', () => {
    const orphan = [mk({ id: 'o', worktree: { parentId: '없음', branch: 'ara/x' } })]
    expect(benchRows(orphan, facts()).map((r) => r.s.id)).toEqual(['o'])
  })
})
