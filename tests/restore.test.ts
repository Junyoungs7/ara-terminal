import { describe, it, expect } from 'vitest'
import { toLayoutNode, fromLayoutNode, type LayoutState, type Pane } from '../src/renderer/store/layout'
import { planRestore, hasRestorable } from '../src/renderer/store/restore'
import type { WorkspaceSnapshot, Session, LayoutNode } from '../src/shared/types'

const mkPanes = (ids: string[]): Pane[] => ids.map((sid, i) => ({ id: `p${i + 1}`, sessionId: sid }))

const stateOf = (ids: string[], over: Partial<LayoutState> = {}): LayoutState => ({
  panes: mkPanes(ids),
  focusedId: null,
  colRatio: 0.5,
  rowRatio: 0.5,
  maximizedId: null,
  pairAxis: 'lr',
  ...over
})

// F6: 직렬화(toLayoutNode) → 역직렬화(fromLayoutNode) 왕복이 패널 순서·비율을 보존해야 한다.
describe('fromLayoutNode (F6 layout 역직렬화 · toLayoutNode 왕복)', () => {
  it('단일 패널 왕복', () => {
    const node = toLayoutNode(stateOf(['s1']))
    const r = fromLayoutNode(node)
    expect(r.sessionIds).toEqual(['s1'])
  })

  it('2패널(좌/우) 왕복 — colRatio 보존', () => {
    const node = toLayoutNode(stateOf(['s1', 's2'], { colRatio: 0.4 }))
    const r = fromLayoutNode(node)
    expect(r.sessionIds).toEqual(['s1', 's2'])
    expect(r.colRatio).toBeCloseTo(0.4)
  })

  it('3패널 왕복 — 빈 우하 패널(sessionId=null)은 제외', () => {
    const node = toLayoutNode(stateOf(['s1', 's2', 's3'], { rowRatio: 0.6 }))
    const r = fromLayoutNode(node)
    expect(r.sessionIds).toEqual(['s1', 's2', 's3'])
    expect(r.rowRatio).toBeCloseTo(0.6)
  })

  it('4패널 왕복 — 순서·col/row 비율 보존', () => {
    const node = toLayoutNode(stateOf(['s1', 's2', 's3', 's4'], { colRatio: 0.35, rowRatio: 0.7 }))
    const r = fromLayoutNode(node)
    expect(r.sessionIds).toEqual(['s1', 's2', 's3', 's4'])
    expect(r.colRatio).toBeCloseTo(0.35)
    expect(r.rowRatio).toBeCloseTo(0.7)
  })

  it('빈 pane(sessionId=null)은 빈 목록', () => {
    const r = fromLayoutNode({ type: 'pane', sessionId: null })
    expect(r.sessionIds).toEqual([])
  })

  it('모든 패널 수(1~4)에서 왕복 후 sessionId 개수가 보존된다', () => {
    for (let n = 1; n <= 4; n++) {
      const ids = Array.from({ length: n }, (_, i) => `s${i + 1}`)
      const r = fromLayoutNode(toLayoutNode(stateOf(ids)))
      expect(r.sessionIds).toEqual(ids)
    }
  })

  // R2.0: 분할 방향도 복원 대상이다(가로 분할로 만든 상하 배치가 재시작 후 좌우가 되면 안 된다).
  it('가로 분할(상·하) 2패널 왕복 — pairAxis=tb + rowRatio 보존', () => {
    const node = toLayoutNode(stateOf(['s1', 's2'], { pairAxis: 'tb', rowRatio: 0.3 }))
    const r = fromLayoutNode(node)
    expect(r.sessionIds).toEqual(['s1', 's2'])
    expect(r.pairAxis).toBe('tb')
    expect(r.rowRatio).toBeCloseTo(0.3)
  })

  it('세로 분할(좌·우) 2패널과 3~4패널은 pairAxis=lr', () => {
    expect(fromLayoutNode(toLayoutNode(stateOf(['s1', 's2']))).pairAxis).toBe('lr')
    expect(fromLayoutNode(toLayoutNode(stateOf(['s1', 's2', 's3']))).pairAxis).toBe('lr')
    expect(fromLayoutNode(toLayoutNode(stateOf(['s1', 's2', 's3', 's4']))).pairAxis).toBe('lr')
  })
})

// F6 복원 플래너 — 스냅샷의 layout 순서를 기준으로 local/ssh 재생성 항목을 만든다.
const sess = (id: string, type: Session['type'], over: Partial<Session> = {}): Session => ({
  id,
  type,
  title: id,
  serverKey: type === 'ssh' ? 'dev' : 'localhost',
  ...over
})

const snapshotWith = (layout: LayoutNode, sessions: Session[]): WorkspaceSnapshot => ({
  schemaVersion: 1,
  savedAt: '',
  app: { version: '0.1.0' },
  profiles: [],
  knownHosts: {},
  layout,
  sessions,
  tabGroups: [],
  ui: {
    sidebar: { collapsed: false, activeTab: 'conn', width: 264 },
    ctxMenuStyle: 'radial',
    font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 },
    locale: 'ko'
  }
})

describe('planRestore (F6 부트 복원 플랜)', () => {
  it('local + ssh 혼합을 layout 순서대로 항목화한다', () => {
    const layout = toLayoutNode(stateOf(['l1', 'x1']))
    const snap = snapshotWith(layout, [
      sess('l1', 'local', { cwd: 'D:/work' }),
      sess('x1', 'ssh', { profileId: 'prof-1' })
    ])
    const plan = planRestore(snap)
    expect(plan.items.map((i) => i.kind)).toEqual(['local', 'ssh'])
    expect(plan.items[0]).toMatchObject({ kind: 'local' })
    if (plan.items[0].kind === 'local') expect(plan.items[0].session.cwd).toBe('D:/work')
    if (plan.items[1].kind === 'ssh') expect(plan.items[1].profileId).toBe('prof-1')
  })

  it('패널에 붙은 세션은 panedIds, 나머지 세션은 배경 탭으로 모두 복원한다', () => {
    const layout = toLayoutNode(stateOf(['l1']))
    // l1 은 패널, bg 는 패널 없는 배경 탭.
    const snap = snapshotWith(layout, [sess('l1', 'local'), sess('bg', 'local')])
    const plan = planRestore(snap)
    expect(plan.items.map((i) => i.oldId).sort()).toEqual(['bg', 'l1'])
    expect(plan.panedIds).toEqual(['l1']) // 패널엔 l1 만
  })

  it('profileId 없는 ssh 세션은 profileId=null(고아 → 오류 패널 처리 대상)', () => {
    const layout = toLayoutNode(stateOf(['x1']))
    const snap = snapshotWith(layout, [sess('x1', 'ssh', { profileId: null })])
    const plan = planRestore(snap)
    expect(plan.items[0]).toMatchObject({ kind: 'ssh', profileId: null })
  })

  // R2.3: 탭 순서는 저장된 sessions 배열 순서다. 패널 붙은 세션부터 만들면 드래그로 잡아 둔 순서가 깨진다.
  it('복원 항목 순서 = 저장된 탭 순서(패널 배치와 무관)', () => {
    // 탭 순서는 [bg, l1] 인데 패널에 붙은 것은 l1 하나.
    const layout = toLayoutNode(stateOf(['l1']))
    const snap = snapshotWith(layout, [sess('bg', 'local'), sess('l1', 'local')])
    const plan = planRestore(snap)
    expect(plan.items.map((i) => i.oldId)).toEqual(['bg', 'l1'])
    expect(plan.panedIds).toEqual(['l1'])
  })

  it('layout 에만 있고 sessions 에 없는 id 는 panedIds 에서 빠진다', () => {
    const layout = toLayoutNode(stateOf(['ghost', 'l1']))
    const snap = snapshotWith(layout, [sess('l1', 'local')])
    expect(planRestore(snap).panedIds).toEqual(['l1'])
  })

  it('hasRestorable: 세션 없으면 false(빈 시작), 있으면 true', () => {
    const empty = snapshotWith({ type: 'pane', sessionId: null }, [])
    expect(hasRestorable(empty)).toBe(false)
    const withSess = snapshotWith(toLayoutNode(stateOf(['l1'])), [sess('l1', 'local')])
    expect(hasRestorable(withSess)).toBe(true)
  })
})
