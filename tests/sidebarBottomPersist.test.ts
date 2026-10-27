import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SIDEBAR, hydrateSidebar, sidebarPersist } from '../src/renderer/store/sidebar'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { CONN_COLLAPSED_MAX, type SidebarState } from '../src/shared/types'

// #13(2026-10-08): 왼쪽 사이드바의 접힘이 재시작 후에도 남는다.
// 2.0(2026-10-27): **하단 패널은 빠졌다** — 늘 닫힌 채 시작하고 열림 상태를 복원하지 않는다.
// 저장은 ui.sidebar 하나(ui:setSidebar) — JSON 왕복을 거쳐 같은 값으로 돌아와야 한다.
const roundTrip = (s: SidebarState): SidebarState => hydrateSidebar(JSON.parse(JSON.stringify(s)))

describe('#13 접힘 상태 영속', () => {
  it('사이드바 접힘이 저장 → 복원 왕복으로 남는다', () => {
    const saved: SidebarState = { collapsed: true, activeTab: 'file', width: 300 }
    expect(roundTrip(saved)).toEqual(saved)
  })

  it('★ 2.0: 하단 패널 상태는 복원하지 않는다 — 옛 파일에 열린 탭·접힘이 남아 있어도 버린다', () => {
    expect('bottom' in roundTrip({ ...DEFAULT_SIDEBAR, bottom: 'sys' })).toBe(false)
    expect('bottom' in roundTrip({ ...DEFAULT_SIDEBAR, bottom: null })).toBe(false)
  })

  it('2.0 [지난 세션] 탭은 세션 수명 동안만 — 재시작하면 [연결]로', () => {
    expect(roundTrip({ ...DEFAULT_SIDEBAR, activeTab: 'past' }).activeTab).toBe('conn')
  })

  it('값이 없으면(옛 파일) 기본값 그대로 — 하단은 "저장된 적 없음"', () => {
    const h = hydrateSidebar({})
    expect(h).toEqual(DEFAULT_SIDEBAR)
    expect('bottom' in h).toBe(false)
  })

  it('위반 — 모르는 하단 탭·문자열 접힘·이상한 폭은 기본으로 눌러 담는다', () => {
    const h = hydrateSidebar({ bottom: 'nope', collapsed: 'yes', width: 'x' } as never)
    expect('bottom' in h).toBe(false)
    expect(h.collapsed).toBe(false)
    expect(h.width).toBe(DEFAULT_SIDEBAR.width)
  })
})

describe('#13 연결 트리 접힘(connCollapsed) 영속', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('접힌 그룹·즐겨찾기·로컬·서버 노드가 왕복으로 남는다', () => {
    const connCollapsed = { AI: true, __fav: true, __local: true, 'node:p1': true } as const
    expect(roundTrip({ ...DEFAULT_SIDEBAR, connCollapsed }).connCollapsed).toEqual(connCollapsed)
  })

  it('위반 — true 아닌 값·배열·긴 키는 버리고, 상한을 넘으면 최근 것만 남긴다', () => {
    const h = hydrateSidebar({ connCollapsed: { a: false, b: 'yes', c: true, ['x'.repeat(301)]: true } } as never)
    expect(h.connCollapsed).toEqual({ c: true })
    expect(hydrateSidebar({ connCollapsed: ['a'] } as never).connCollapsed).toEqual({})
    const many: Record<string, true> = {}
    for (let i = 0; i < CONN_COLLAPSED_MAX + 50; i++) many['g' + i] = true
    const kept = Object.keys(hydrateSidebar({ connCollapsed: many }).connCollapsed!)
    expect(kept.length).toBe(CONN_COLLAPSED_MAX)
    expect(kept[kept.length - 1]).toBe('g' + (CONN_COLLAPSED_MAX + 49))
  })

  it('main WorkspaceStore.setSidebar 도 같은 검증을 하고 디스크에 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ara-sb-'))
    dirs.push(dir)
    const file = join(dir, 'workspace.json')
    const ws = new WorkspaceStore(file, '0.1.0')
    ws.setSidebar({ ...DEFAULT_SIDEBAR, connCollapsed: { AI: true, bad: 1 } as never })
    expect(JSON.parse(readFileSync(file, 'utf8')).ui.sidebar.connCollapsed).toEqual({ AI: true })
    expect(new WorkspaceStore(file, '0.1.0').get().ui.sidebar.connCollapsed).toEqual({ AI: true })
  })
})

describe('#13 하이드레이트 경합 — load() 가 늦게 끝나도 저장된 접힘을 덮지 않는다', () => {
  // useSidebar 와 같은 순서를 밟는 가짜 window.ev: load 는 손으로 풀 때까지 안 끝나고 setSidebar 는 기록만.
  function fakeEv(saved: SidebarState) {
    const writes: SidebarState[] = []
    let finish!: () => void
    const load = new Promise<{ ui: { sidebar: SidebarState } }>((r) => (finish = () => r({ ui: { sidebar: saved } })))
    return { writes, finish, ev: { workspace: { load: () => load }, ui: { setSidebar: (s: SidebarState) => void writes.push(s) } } }
  }
  /** useSidebar.update 와 같은 계산(prev 위에 delta). */
  const apply = (p: ReturnType<typeof sidebarPersist>, prev: SidebarState, delta: Partial<SidebarState>): SidebarState => {
    const next = { ...prev, ...delta }
    p.changed(next, delta)
    return next
  }

  it('로드 전 update 는 저장하지 않고, 로드 후 하이드레이트 값 위에 다시 얹어 한 번 저장한다', async () => {
    const saved: SidebarState = { collapsed: true, activeTab: 'conn', width: 300, bottom: null, connCollapsed: { AI: true } }
    const { ev, writes, finish } = fakeEv(saved)
    const p = sidebarPersist((s) => ev.ui.setSidebar(s))
    const loading = ev.workspace.load()
    // 로드 전: 기본값 위에서 하단 탭을 바꿨다(예: 이른 이펙트).
    apply(p, DEFAULT_SIDEBAR, { activeTab: 'file' })
    // 🔴 위반 심기 — 옛 코드는 여기서 { collapsed:false, ... } 를 디스크에 썼다.
    expect(writes).toEqual([])
    finish()
    const shown = p.hydrated(hydrateSidebar((await loading).ui.sidebar))
    expect(shown.collapsed).toBe(true)
    expect(shown.connCollapsed).toEqual({ AI: true })
    expect(shown.activeTab).toBe('file')
    expect(writes).toEqual([shown])
    // 로드 뒤 update 는 바로 저장된다.
    apply(p, shown, { collapsed: false })
    expect(writes).toHaveLength(2)
  })

  it('로드 전 update 가 없으면 로드 때 아무것도 쓰지 않는다(StrictMode 이중 hydrated 도 안전)', () => {
    const writes: SidebarState[] = []
    const p = sidebarPersist((s) => void writes.push(s))
    const saved: SidebarState = { ...DEFAULT_SIDEBAR, collapsed: true }
    expect(p.hydrated(saved)).toBe(saved)
    expect(p.hydrated(saved)).toBe(saved)
    expect(writes).toEqual([])
  })
})
