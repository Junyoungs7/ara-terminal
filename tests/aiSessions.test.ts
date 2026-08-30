import { describe, it, expect } from 'vitest'
import { sortViews, viewsOf, waitingCount, type AiRun } from '../src/renderer/store/aiSessions'
import type { AgentStatus } from '../src/shared/agentStatus'
import type { Session } from '../src/shared/types'

// F30 AI 세션 목록 — 판정 로직. 여기서 틀리면 화면이 조용히 거짓말을 한다
// (안 기다리는 걸 기다린다 하거나, 기다리는 걸 놓치거나).
//
// **F1a 에서 근거가 바뀌었다**: "출력이 몇 초 멎었나"가 아니라 **훅이 말해 준 상태**다.
// 그래서 이 파일 어디에도 시각을 재는 자리가 없다 — 침묵이 입력이 아니게 된 것이 그 모습이다.

const NOW = 1_700_000_000_000
const run = (id: string, path = '~/x'): AiRun => ({ sessionId: id, cli: 'claude', path, startedAt: NOW - 600_000 })
const sess = (id: string, serverKey = 'dev'): Session => ({
  id,
  type: 'ssh',
  title: id,
  serverKey,
  profileId: 'p1'
})
const st = (id: string, state: AgentStatus['state'], startedAt = NOW - 1000, extra: Partial<AgentStatus> = {}): AgentStatus => ({
  sessionId: id,
  cli: 'claude',
  state,
  updatedAt: startedAt,
  stateStartedAt: startedAt,
  ...extra
})

describe('상태는 훅이 말해 준 것이다', () => {
  it('들은 그대로 그린다', () => {
    for (const s of ['working', 'waiting', 'done'] as const) {
      expect(viewsOf([run('a')], [sess('a')], [st('a', s)])[0]!.state).toBe(s)
    }
  })

  it('한 마디도 못 들었으면 unverifiable — 조용하다고 해석하지 않는다', () => {
    // 옛 규칙이라면 여기서 "10분째 조용함 = 기다리는 중"이 됐다(run.startedAt 이 10분 전이다).
    const v = viewsOf([run('a')], [sess('a')], [])[0]!
    expect(v.state).toBe('unverifiable')
    expect(v.stateStartedAt).toBe(NOW - 600_000)
  })

  it('상태가 시작된 시각을 그대로 들고 간다(알림 id 가 이 값으로 만들어진다)', () => {
    expect(viewsOf([run('a')], [sess('a')], [st('a', 'waiting', NOW - 4000)])[0]!.stateStartedAt).toBe(NOW - 4000)
  })

  it('우리가 주장한 상태에는 표시가 남는다 — 나이와 무관하게 신선하지 않다', () => {
    const old = viewsOf([run('a')], [sess('a')], [st('a', 'waiting', NOW - 3_600_000, { restoredUnconfirmed: true })])[0]!
    const fresh = viewsOf([run('a')], [sess('a')], [st('a', 'waiting', NOW, { restoredUnconfirmed: true })])[0]!
    expect(old.unconfirmed).toBe(true)
    expect(fresh.unconfirmed).toBe(true) // 방금 것이어도 마찬가지다
    expect(viewsOf([run('a')], [sess('a')], [st('a', 'waiting')])[0]!.unconfirmed).toBe(false)
  })

  it('세션이 사라졌으면 gone — 끝난 것도 알아야 계속 기다리지 않는다', () => {
    const v = viewsOf([run('a')], [], [st('a', 'working')])[0]!
    expect(v.state).toBe('gone')
    expect(v.session).toBeNull()
    expect(v.stateStartedAt).toBe(NOW - 600_000) // 실행 시작 시각 — 목록에서 걷어낼 때를 이걸로 잰다
  })

  it('남의 세션 상태를 끌어다 쓰지 않는다', () => {
    expect(viewsOf([run('a')], [sess('a')], [st('b', 'waiting')])[0]!.state).toBe('unverifiable')
  })

  it('서버 이름은 serverKey 를, 없으면 탭 제목을 쓴다', () => {
    expect(viewsOf([run('a')], [sess('a', 'vgt-erp')], [])[0]!.serverName).toBe('vgt-erp')
    expect(viewsOf([run('a')], [{ ...sess('a'), serverKey: '' }], [])[0]!.serverName).toBe('a')
  })
})

describe('정렬 — 나를 부르는 것이 위로', () => {
  it('기다림 → 끝남 → 도는 중 → 모름 → 사라짐', () => {
    const runs = [run('work'), run('gone'), run('unk'), run('wait'), run('done')]
    const sessions = [sess('work'), sess('unk'), sess('wait'), sess('done')]
    const statuses = [st('work', 'working'), st('wait', 'waiting'), st('done', 'done')]
    expect(sortViews(viewsOf(runs, sessions, statuses)).map((v) => v.run.sessionId)).toEqual([
      'wait',
      'done',
      'work',
      'unk',
      'gone'
    ])
  })

  it('같은 상태면 오래 기다린 것이 위로', () => {
    const runs = [run('new'), run('old')]
    const sessions = [sess('new'), sess('old')]
    const statuses = [st('new', 'waiting', NOW - 1000), st('old', 'waiting', NOW - 300_000)]
    expect(sortViews(viewsOf(runs, sessions, statuses)).map((v) => v.run.sessionId)).toEqual(['old', 'new'])
  })
})

describe('액티비티 바 점 판정', () => {
  it('나를 기다리는 것의 개수를 센다 — 도는 중인 것은 세지 않는다', () => {
    const views = viewsOf(
      [run('a'), run('b'), run('c')],
      [sess('a'), sess('b'), sess('c')],
      [st('a', 'working'), st('b', 'waiting')]
    )
    expect(waitingCount(views)).toBe(1) // c 는 unverifiable — 모르는 것은 부르지 않는다
    expect(waitingCount([])).toBe(0)
  })
})
