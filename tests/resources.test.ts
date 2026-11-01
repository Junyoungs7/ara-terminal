// M0 0-7 FD-01 자원 관리자 — 집계·트리 구성 순수 로직(src/shared/resources.ts).
import { describe, expect, it } from 'vitest'
import {
  aggregatePtys,
  appKind,
  applyWinCpu,
  childrenIndex,
  collectSubtree,
  parsePs,
  parseWinCim,
  overMemory,
  priorityTargets,
  snapshotOf,
  type ProcRow
} from '@shared/resources'

const MB = 1024 * 1024
const rows: ProcRow[] = [
  { pid: 1, ppid: 0, cpu: 1, memory: 100 * MB }, // main
  { pid: 10, ppid: 1, cpu: 2, memory: 10 * MB }, // 셸 A
  { pid: 11, ppid: 10, cpu: 3, memory: 20 * MB }, // A 안의 ssh
  { pid: 12, ppid: 11, cpu: 4, memory: 30 * MB }, // 손자
  { pid: 20, ppid: 1, cpu: 5, memory: 40 * MB } // 셸 B
]

describe('트리', () => {
  it('자손을 모두 모은다', () => {
    const byPid = new Map(rows.map((r) => [r.pid, r]))
    expect(collectSubtree(byPid, childrenIndex(rows), 10).sort()).toEqual([10, 11, 12])
  })
  it('claimed 는 건너뛰고 순환에도 끝난다', () => {
    const loop: ProcRow[] = [
      { pid: 1, ppid: 2, cpu: 0, memory: 0 },
      { pid: 2, ppid: 1, cpu: 0, memory: 0 }
    ]
    const byPid = new Map(loop.map((r) => [r.pid, r]))
    expect(collectSubtree(byPid, childrenIndex(loop), 1).sort()).toEqual([1, 2])
    expect(collectSubtree(byPid, childrenIndex(loop), 1, new Set([2]))).toEqual([1])
  })
})

describe('PTY 집계', () => {
  it('셸 트리를 합산하고 pid 없는 SSH 세션은 0', () => {
    const out = aggregatePtys(rows, [
      { id: 'a', title: 'A', type: 'local', pid: 10 },
      { id: 'b', title: 'B', type: 'local', pid: 20 },
      { id: 's', title: 'S', type: 'ssh' }
    ])
    expect(out[0]).toMatchObject({ id: 'a', cpu: 9, memory: 60 * MB, procCount: 3 })
    expect(out[1]).toMatchObject({ id: 'b', cpu: 5, memory: 40 * MB, procCount: 1 })
    expect(out[2]).toMatchObject({ id: 's', cpu: 0, memory: 0, procCount: 0 })
  })
  it('겹치는 트리는 먼저 등록된 쪽이 한 번만 센다', () => {
    const out = aggregatePtys(rows, [
      { id: 'a', title: 'A', type: 'local', pid: 10 },
      { id: 'inner', title: 'I', type: 'local', pid: 11 }
    ])
    expect(out[1].procCount).toBe(0)
  })
  it('합계 = 앱 + PTY', () => {
    const s = snapshotOf([{ pid: 1, kind: 'main', cpu: 1, memory: 5 }], [{ id: 'a', title: 'A', type: 'local', cpu: 2, memory: 7, procCount: 1 }], 0)
    expect(s.total).toEqual({ cpu: 3, memory: 12 })
  })
})

describe('파싱', () => {
  it('appKind', () => {
    expect(appKind('Browser')).toBe('main')
    expect(appKind('Tab')).toBe('renderer')
    expect(appKind('GPU')).toBe('gpu')
    expect(appKind('Utility')).toBe('utility')
    expect(appKind('Zygote')).toBe('other')
  })
  it('ps 출력(rss KB → 바이트, 깨진 줄 무시)', () => {
    expect(parsePs('  10   1  2.5  1024\nbad\n 11 10 0.0 0\n')).toEqual([
      { pid: 10, ppid: 1, cpu: 2.5, memory: MB },
      { pid: 11, ppid: 10, cpu: 0, memory: 0 }
    ])
  })
  it('Windows CIM + CPU 차분', () => {
    const prev = parseWinCim('10\t1\t1048576\t0\r\n11\t10\t0\t500000\r\n')
    const cur = parseWinCim('10\t1\t2097152\t10000000\r\n11\t10\t0\t100\r\n')
    // 10,000,000 tick = 1000ms CPU / 1000ms 경과 = 100%. pid 11 은 카운터가 줄었다(재사용) → 0.
    const out = applyWinCpu(cur, prev, 1000, 4)
    expect(out).toEqual([
      { pid: 10, ppid: 1, cpu: 100, memory: 2 * MB },
      { pid: 11, ppid: 10, cpu: 0, memory: 0 }
    ])
    // 첫 표본은 cpu 0
    expect(applyWinCpu(parseWinCim('10\t1\t1\t5'), null, 0, 4)[0].cpu).toBe(0)
  })
})

describe('M4 R3 에이전트 상한', () => {
  it('우선순위 적용 대상 = 에이전트 셸 트리 전부(자손 포함) − 이미 낮춘 것, 다른 트리는 안 건드린다', () => {
    expect(priorityTargets(rows, [10], new Set()).sort()).toEqual([10, 11, 12])
    expect(priorityTargets(rows, [10], new Set([10, 11]))).toEqual([12])
    // 셸 B·main 은 대상이 아니다. 목록에 없는 루트(이미 끝난 셸)는 아무것도 안 낸다.
    expect(priorityTargets(rows, [10, 999], new Set())).not.toContain(20)
    expect(priorityTargets(rows, [999], new Set())).toEqual([])
    // 두 루트가 겹쳐도 한 번씩
    expect(priorityTargets(rows, [10, 11], new Set()).sort()).toEqual([10, 11, 12])
  })

  it('메모리 판정: 넘어설 때 한 번만 · 내려왔다 다시 넘으면 또 · 세션이 없어지면 잊는다 · 상한 0 은 끔', () => {
    const over = new Set<string>()
    const cap = 100 * MB
    expect(overMemory([{ id: 'a', memory: 150 * MB }, { id: 'b', memory: 50 * MB }], cap, over)).toEqual([{ id: 'a', memory: 150 * MB }])
    expect(overMemory([{ id: 'a', memory: 160 * MB }, { id: 'b', memory: 50 * MB }], cap, over)).toEqual([]) // 또 안 알림
    expect(overMemory([{ id: 'a', memory: 90 * MB }], cap, over)).toEqual([]) // 내려옴 → 다시 무장
    expect(overMemory([{ id: 'a', memory: 120 * MB }], cap, over)).toEqual([{ id: 'a', memory: 120 * MB }])
    expect(overMemory([], cap, over)).toEqual([])
    expect(over.size).toBe(0) // 끝난 세션은 잊는다(같은 id 가 다시 와도 새로 알린다)
    expect(overMemory([{ id: 'a', memory: 10 ** 12 }], 0, over)).toEqual([])
    expect(over.size).toBe(0)
    // 상한과 같으면 넘은 것이 아니다
    expect(overMemory([{ id: 'a', memory: cap }], cap, over)).toEqual([])
  })

  it('PTY 줄은 에이전트 표시를 그대로 싣고, 스냅샷은 상한을 싣는다', () => {
    const [p] = aggregatePtys(rows, [{ id: 'x', title: 'X', type: 'local', pid: 10, agent: true }])
    expect(p.agent).toBe(true)
    expect(snapshotOf([], [p], 0, { lowPriority: true, memoryBytes: 5 }).agentLimits).toEqual({ lowPriority: true, memoryBytes: 5 })
    expect(snapshotOf([], [], 0).agentLimits).toEqual({ lowPriority: false, memoryBytes: 0 })
  })
})
