import { describe, it, expect } from 'vitest'
import {
  durationText,
  quietCount,
  QUIET_MS,
  sortViews,
  viewsOf,
  type AiRun
} from '../src/renderer/store/aiSessions'
import type { Session } from '../src/shared/types'

// F30 AI 세션 패널 — 판정 로직. 여기서 틀리면 화면이 조용히 거짓말을 한다
// (안 기다리는 걸 기다린다 하거나, 기다리는 걸 놓치거나).

const NOW = 1_700_000_000_000
const run = (id: string, path = '~/x'): AiRun => ({ sessionId: id, cli: 'claude', path, startedAt: NOW - 600_000 })
const sess = (id: string, serverKey = 'dev'): Session => ({
  id,
  type: 'ssh',
  title: id,
  serverKey,
  profileId: 'p1'
})

describe('조용함 판정', () => {
  it('마지막 출력이 기준보다 오래됐으면 quiet', () => {
    const v = viewsOf([run('a')], [sess('a')], [{ id: 'a', lastDataAt: NOW - QUIET_MS - 1 }], NOW)
    expect(v[0].state).toBe('quiet')
    expect(v[0].quietMs).toBeGreaterThanOrEqual(QUIET_MS)
  })

  it('방금 출력이 있었으면 busy — 기준 경계에서 quiet 로 넘어간다', () => {
    expect(viewsOf([run('a')], [sess('a')], [{ id: 'a', lastDataAt: NOW - 1000 }], NOW)[0].state).toBe('busy')
    // 정확히 기준값이면 quiet(>=). 경계를 열어 두면 59.9초에서 깜빡인다.
    expect(viewsOf([run('a')], [sess('a')], [{ id: 'a', lastDataAt: NOW - QUIET_MS }], NOW)[0].state).toBe('quiet')
  })

  it('활동 기록이 아예 없으면 시작 시각을 기준으로 센다(1970년부터 조용함 금지)', () => {
    const v = viewsOf([run('a')], [sess('a')], [], NOW)
    expect(v[0].quietMs).toBe(600_000) // startedAt 기준
    expect(v[0].state).toBe('quiet')
  })

  it('세션이 사라졌으면 gone — 끝난 것도 알아야 계속 기다리지 않는다', () => {
    const v = viewsOf([run('a')], [], [], NOW)
    expect(v[0].state).toBe('gone')
    expect(v[0].session).toBeNull()
  })

  it('서버 이름은 serverKey 를, 없으면 탭 제목을 쓴다', () => {
    expect(viewsOf([run('a')], [sess('a', 'vgt-erp')], [], NOW)[0].serverName).toBe('vgt-erp')
    expect(viewsOf([run('a')], [{ ...sess('a'), serverKey: '' }], [], NOW)[0].serverName).toBe('a')
  })
})

describe('정렬 — 볼 이유가 있는 것이 위로', () => {
  it('조용한 것 먼저, 그다음 오래 조용한 순, 끝난 것은 맨 아래', () => {
    const views = viewsOf(
      [run('busy'), run('gone'), run('q1'), run('q2')],
      [sess('busy'), sess('q1'), sess('q2')],
      [
        { id: 'busy', lastDataAt: NOW - 1000 },
        { id: 'q1', lastDataAt: NOW - 120_000 },
        { id: 'q2', lastDataAt: NOW - 600_000 }
      ],
      NOW
    )
    expect(sortViews(views).map((v) => v.run.sessionId)).toEqual(['q2', 'q1', 'busy', 'gone'])
  })
})

describe('액티비티 바 점 판정', () => {
  it('조용한 것의 개수를 센다 — 0 이면 점을 안 찍는다', () => {
    const views = viewsOf(
      [run('a'), run('b')],
      [sess('a'), sess('b')],
      [
        { id: 'a', lastDataAt: NOW - 1000 },
        { id: 'b', lastDataAt: NOW - 300_000 }
      ],
      NOW
    )
    expect(quietCount(views)).toBe(1)
    expect(quietCount([])).toBe(0)
  })
})

describe('경과 시간 표기', () => {
  it('분 단위 · 한 시간 넘으면 시간+분', () => {
    expect(durationText(60_000)).toBe('1분')
    expect(durationText(125_000)).toBe('2분')
    expect(durationText(3_600_000)).toBe('1시간 0분')
    expect(durationText(3_900_000)).toBe('1시간 5분')
  })
})
