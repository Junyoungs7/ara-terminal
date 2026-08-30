// #129 작업대 목록 — **점 하나가 무엇을 말하는가**, 그리고 같은 조합을 두 번 만들지 않는가.
// 화면(AiBenchTree)은 이 결과를 그리기만 한다.
import { describe, it, expect } from 'vitest'
import {
  agoText,
  benchRows,
  groupOf,
  groupRows,
  hookRows,
  sameBench,
  upsertBench,
  type WorkbenchRow
} from '../src/renderer/store/aiWorkbench'
import type { AiSessionView } from '../src/renderer/store/aiSessions'
import type { AiSessionState } from '../src/shared/aiSession'
import type { Session } from '../src/shared/types'

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

/** 훅이 말해 준 처지 한 벌. `aiSessions.viewsOf` 가 만드는 것과 같은 모양이다. */
const view = (
  sessionId: string,
  state: AiSessionView['state'],
  over: { since?: number; session?: Session | null; serverName?: string; path?: string } = {}
): AiSessionView => ({
  run: { sessionId, cli: 'claude', path: over.path ?? 'D:/work/app', startedAt: 0 },
  session:
    over.session === undefined
      ? { id: sessionId, type: 'local', title: sessionId, serverKey: 'localhost' }
      : over.session,
  state,
  stateStartedAt: over.since ?? 100,
  unconfirmed: false,
  serverName: over.serverName ?? 'localhost'
})

const facts = (over: Partial<Parameters<typeof benchRows>[1]> = {}) => ({
  sessionOf: () => null,
  seen: () => null,
  serverOf: () => '로컬',
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
  it('살아 있는 줄의 상태는 **훅이 말해 준 것**이다 — 침묵을 해석하지 않는다', () => {
    const list = [mk()]
    const on = (state: AiSessionView['state']) =>
      benchRows(list, facts({ sessionOf: () => 's1', seen: () => view('s1', state) }))[0]!
    expect(on('working').status).toBe('live')
    expect(on('waiting').status).toBe('quiet')
    expect(on('working').state).toBe('working')
    expect(on('done').state).toBe('done')
    // 상태가 시작된 시각을 그대로 들고 간다 — 경과 열과 `작업 중` 정렬이 이 값을 쓴다.
    expect(on('working').since).toBe(100)
  })

  it('★ 한 마디도 못 들은 살아 있는 세션은 unverifiable — 도는 척하지 않는다', () => {
    // 훅 없는 CLI(codex·gemini)가 늘 여기 온다. 이 줄이 `working` 이 되면 화면이 거짓말을 한다.
    const r = benchRows([mk()], facts({ sessionOf: () => 's1' }))[0]!
    expect(r.state).toBe('unverifiable')
    expect(r.since).toBe(10) // 물어볼 데가 없으니 마지막으로 쓴 때
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

describe('🔴 목록에 있고 없고를 정하는 것은 훅이다', () => {
  it('★ 우리가 안 띄운 세션도 목록에 뜬다 — 터미널에 직접 친 AI 가 여기서 잘려 나갔다', () => {
    // 적립도(bench.list 가 비었다) 실행 기록도 없다. 훅이 말을 걸어 온 것이 전부다.
    const rows = hookRows([view('직접친것', 'waiting')], new Set(), '로컬')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('직접친것')
    expect(rows[0]!.state).toBe('waiting')
    // 저장된 작업대가 아니다 — 지울 것도 분리할 것도 없다(화면이 그 버튼을 안 그린다).
    expect(rows[0]!.saved).toBe(false)
    // 무엇으로 띄웠는지 모른다. 권한 건너뛰기가 **켜졌다고 주장하지 않는다.**
    expect(rows[0]!.s.skipPerms).toBe(false)
  })

  it('작업대 줄이 이미 있는 세션은 두 줄이 되지 않는다', () => {
    expect(hookRows([view('s1', 'working')], new Set(['s1']), '로컬')).toEqual([])
  })

  it('탭이 사라진 것은 그리지 않는다 — 갈 곳이 없는 줄이다', () => {
    expect(hookRows([view('s1', 'gone', { session: null })], new Set(), '로컬')).toEqual([])
  })

  it('로컬 세션의 서버 칸은 serverKey 가 아니라 화면 어휘를 쓴다', () => {
    expect(hookRows([view('s1', 'working')], new Set(), '로컬')[0]!.serverName).toBe('로컬')
    const remote = view('s2', 'working', {
      session: { id: 's2', type: 'ssh', title: 's2', serverKey: 'kvt-dev' },
      serverName: 'kvt-dev'
    })
    expect(hookRows([remote], new Set(), '로컬')[0]!.serverName).toBe('kvt-dev')
  })
})

describe('묶음은 상태다', () => {
  const row = (id: string, over: Partial<WorkbenchRow> = {}): WorkbenchRow => ({
    s: mk({ id }),
    status: 'live',
    sessionId: 's-' + id,
    depth: 0,
    state: 'working',
    since: 0,
    serverName: '로컬',
    saved: true,
    ...over
  })

  it('★ `확인 불가` 는 `끝남` 과 다른 묶음이다 — 모르는 것과 끝난 것은 다르다', () => {
    const gs = groupRows([row('a', { state: 'done' }), row('b', { state: 'unverifiable' })])
    expect(gs.map((g) => g.id)).toEqual(['done', 'unverifiable'])
  })

  it('★ 안 떠 있는 작업대는 `확인 불가` 가 아니라 `쉬는 중`', () => {
    // 껐다 켠 직후 저장된 작업대 전부가 `확인 불가` 로 뜨면 그 라벨이 고장 신호로 읽힌다.
    // 물어볼 프로세스가 없는 것과, 물어봤는데 대답이 없는 것은 다른 사실이다.
    const gs = groupRows([row('a', { sessionId: null, status: 'idle', state: 'unverifiable' })])
    expect(gs.map((g) => g.id)).toEqual(['idle'])
    expect(groupOf(row('b', { sessionId: null, status: 'noPath', state: 'unverifiable' }))).toBe('idle')
  })

  it('나를 기다리는 것이 맨 위 · 빈 묶음은 만들지 않는다', () => {
    const gs = groupRows([row('a', { state: 'done' }), row('b', { state: 'waiting' }), row('c', { state: 'working' })])
    expect(gs.map((g) => g.id)).toEqual(['waiting', 'working', 'done'])
  })

  it('★ `작업 중` 안에서는 오래 멈춘 순 — 위 두세 줄이 "뭐가 막혔나"에 답해야 한다', () => {
    const gs = groupRows([row('방금', { since: 900 }), row('오래', { since: 100 }), row('중간', { since: 500 })])
    expect(gs[0]!.rows.map((r) => r.s.id)).toEqual(['오래', '중간', '방금'])
  })

  it('다른 묶음은 들어온 차례를 그대로 둔다 — 상태가 바뀔 때마다 줄이 점프하면 못 읽는다', () => {
    const gs = groupRows([row('a', { state: 'done', since: 900 }), row('b', { state: 'done', since: 100 })])
    expect(gs[0]!.rows.map((r) => r.s.id)).toEqual(['a', 'b'])
  })

  it('부모가 다른 묶음에 갔으면 들여쓰기를 푼다 — 세로선이 허공에서 시작하지 않게', () => {
    const child = (over: Partial<WorkbenchRow>) =>
      row('c', { depth: 1, s: mk({ id: 'c', worktree: { parentId: 'p', branch: 'ara/x' } }), ...over })
    // 같은 묶음이면 한 칸 들어간 채로 남는다.
    expect(groupRows([row('p'), child({})])[0]!.rows[1]!.depth).toBe(1)
    // 부모가 `대기 중` 으로 빠지면 자식은 평평해진다.
    expect(groupRows([row('p', { state: 'waiting' }), child({})])[1]!.rows[0]!.depth).toBe(0)
  })
})

describe('경과 열은 라틴/숫자만 쓴다', () => {
  it('가장 큰 단위 하나 — 한글이면 --fs-nano 를 못 써 명도 층이 한 단 줄어든다', () => {
    expect(agoText(0)).toBe('0s')
    expect(agoText(-5_000)).toBe('0s') // 시계가 뒤로 가도 음수를 찍지 않는다
    expect(agoText(59_000)).toBe('59s')
    expect(agoText(60_000)).toBe('1m')
    expect(agoText(41 * 60_000)).toBe('41m')
    expect(agoText(2 * 3_600_000)).toBe('2h')
    expect(agoText(3 * 86_400_000)).toBe('3d')
  })
})
