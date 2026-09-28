import { describe, it, expect } from 'vitest'
import { MENUBAR, menuBarItems, type MenuEntry } from '../src/renderer/interactions/actions'
import { KEYMAP } from '../src/shared/keymap'
import { readFileSync } from 'node:fs'
import {
  AI_REVEAL_GRACE_MS,
  clampSidebarWidth,
  DEFAULT_SIDEBAR,
  nextSidebar,
  revealAiTab,
  shownTab,
  SIDEBAR_MAX,
  SIDEBAR_MIN
} from '../src/renderer/store/sidebar'
import { gaugesOf, statusModel } from '../src/renderer/components/StatusBar'
import type { ConnectionProfile } from '../src/shared/types'
import type { Session } from '../src/renderer/store/sessions'

// R4 창/셸 크롬의 순수 로직: 메뉴바가 keymap 에서 파생되는지(이중 정의 금지), 사이드바 폭 클램프,
// 상태바 표시 모델. 실기동 동작(드롭다운 열림·드래그·영속)은 tests/smoke-boot.cjs 가 어서션한다.

const allEntries: MenuEntry[] = MENUBAR.flatMap((m) => [...m.items])
const actionsOf = (e: MenuEntry[]) => e.flatMap((x) => ('action' in x ? [x.action] : []))

describe('R4.1 메뉴바 = keymap 파생', () => {
  it('최상위 메뉴 6종이 모두 항목을 갖는다(빈 메뉴 = 눌러도 반응 없음)', () => {
    // 2026-08-21: 최상위 이름을 한글로 바꿨다(앱의 다른 라벨과 결을 맞춘다).
    expect(MENUBAR.map((m) => m.title)).toEqual(['파일', '편집', '세션', '분할', '보기', '도움말'])
    for (const m of MENUBAR) expect(m.items.length).toBeGreaterThan(0)
  })

  it('메뉴가 참조하는 keymap 액션은 전부 실배선(implemented)된 것뿐이다', () => {
    for (const action of actionsOf(allEntries)) {
      const b = KEYMAP.find((k) => k.action === action)
      expect(b, `${action} 이 KEYMAP 에 없다`).toBeTruthy()
      expect(b!.implemented, `${action} 은 미배선 — 메뉴에 실으면 눌러도 반응이 없다`).toBe(true)
    }
  })

  it('라벨·단축키 힌트를 KEYMAP 에서 그대로 가져온다(메뉴 전용 문구 없음)', () => {
    const split = menuBarItems(MENUBAR.findIndex((m) => m.title === '분할'))
    const byId = Object.fromEntries(split.map((i) => [i.id, i]))
    expect(byId['split.horizontal'].label).toBe('가로 분할')
    expect(byId['split.horizontal'].hint).toBe('Ctrl+Shift+-')
    expect(byId['pane.close'].hint).toBe('Ctrl+Shift+W')
    // 되돌리기 어려운 항목만 위험 톤.
    expect(byId['pane.close'].danger).toBe(true)
    expect(byId['split.vertical'].danger).toBeUndefined()
  })

  it('단축키 없는 명령 항목은 i18n 라벨을 쓰고 힌트가 없다', () => {
    const help = menuBarItems(MENUBAR.findIndex((m) => m.title === '도움말'))
    // W3sat F18: commandBook.toggle 은 action 항목(단축키 있음, KEYMAP 파생 라벨) — 나머지는
    // 단축키 없는 command 항목(i18n 라벨, 힌트 없음)이라는 이 테스트의 취지는 그대로 유지한다.
    // #206: report.open 도 action 항목이다(Ctrl+Shift+F1).
    expect(help.map((i) => i.id)).toEqual(['help.cheatsheet', 'commandBook.toggle', 'report.open', 'help.about'])
    expect(help.find((i) => i.id === 'report.open')?.hint).toBe('Ctrl+Shift+F1')
    for (const i of help.filter((x) => x.id !== 'commandBook.toggle' && x.id !== 'report.open')) {
      expect(i.label).not.toContain('menu.')
      expect(i.hint).toBeUndefined()
    }
    const cmdBook = help.find((i) => i.id === 'commandBook.toggle')
    expect(cmdBook?.hint).toBe('Ctrl+Shift+K')
  })

  it('모든 메뉴 항목이 라벨을 갖고 i18n 키가 그대로 새지 않는다', () => {
    for (let i = 0; i < MENUBAR.length; i++) {
      for (const item of menuBarItems(i)) {
        expect(item.label.length).toBeGreaterThan(0)
        expect(item.label).not.toContain('menu.')
      }
    }
  })

  it('Session 첫 항목은 연결 관리자(R3 까지의 Session 클릭 동작을 지킨다)', () => {
    expect(menuBarItems(MENUBAR.findIndex((m) => m.title === '세션'))[0].id).toBe('connection.manager')
  })

  it('방향·번호 범위 키는 메뉴에 싣지 않는다(단일 항목으로 뜻이 없다)', () => {
    const actions = actionsOf(allEntries)
    expect(actions).not.toContain('focus.move')
    expect(actions).not.toContain('tab.byNumber')
  })

  it('범위를 벗어난 인덱스는 빈 배열(렌더가 깨지지 않는다)', () => {
    expect(menuBarItems(MENUBAR.length)).toEqual([])
  })
})

describe('R4.3 사이드바 폭 클램프', () => {
  it('180 미만은 180, 480 초과는 480', () => {
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN)
    expect(clampSidebarWidth(120)).toBe(180)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX)
  })

  it('범위 안 값은 정수로 그대로', () => {
    expect(clampSidebarWidth(300)).toBe(300)
    expect(clampSidebarWidth(300.6)).toBe(301)
  })

  it('기본 폭은 범위 안이다', () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR.width)).toBe(DEFAULT_SIDEBAR.width)
  })
})

// 2026-08-19 준영님 확정: 좌측 사이드바도 우측 액티비티 바처럼 아이콘을 눌러 여닫는다
// (IntelliJ 툴윈도우). 경계에 붙어 있던 `‹`/`›` 손잡이는 하단바에 가려 잘 안 보였고 닫는
// 자리도 애매했다 — 여는 자리와 닫는 자리를 하나로 합친 것이 이 함수다.
describe('좌측 레일 여닫이 규칙(nextSidebar)', () => {
  const open = (activeTab: 'conn' | 'file') => ({ collapsed: false, activeTab, width: 264 })
  const shut = (activeTab: 'conn' | 'file') => ({ collapsed: true, activeTab, width: 264 })

  it('★ 열려 있는 것을 다시 누르면 닫는다 — 여는 자리가 닫는 자리다', () => {
    expect(nextSidebar(open('conn'), 'conn')).toEqual({ collapsed: true })
  })

  it('다른 것을 누르면 갈아탄다(닫지 않는다)', () => {
    expect(nextSidebar(open('conn'), 'file')).toEqual({ collapsed: false, activeTab: 'file' })
  })

  it('접혀 있으면 무엇을 눌러도 펴면서 그것을 연다', () => {
    // 접힌 채 activeTab 만 바꾸면 "눌렀는데 아무 일도 안 남"이 된다.
    expect(nextSidebar(shut('conn'), 'conn')).toEqual({ collapsed: false, activeTab: 'conn' })
    expect(nextSidebar(shut('file'), 'conn')).toEqual({ collapsed: false, activeTab: 'conn' })
  })

  it('닫을 때 activeTab 을 건드리지 않는다 — 다시 열면 보던 것이 나온다', () => {
    expect(nextSidebar(open('file'), 'file')).not.toHaveProperty('activeTab')
  })

  // 2026-08-19 스모크가 잡은 어긋남: 세션이 없으면 패널은 [연결] 을 그리는데 레일은 [파일] 이
  // 눌린 채였다. 규칙이 Sidebar.tsx 안에만 있어서다 — 이제 둘이 이 함수를 함께 본다.
  it('★ 세션이 없으면 표시는 [연결] 로 떨어진다 — 레일과 패널이 같은 말을 한다', () => {
    expect(shownTab('file', false)).toBe('conn')
    expect(shownTab('file', true)).toBe('file')
    expect(shownTab('conn', false)).toBe('conn')
  })
})

// 2026-09-01 준영님: "세션에서 claude 또는 다른 ai 를 키면 자동으로 AI 세션 탭 이동 필요."
// 화면을 뺏는 기능이라 **안 뺏을 조건**이 곧 이 기능의 전부다 — 넷이 그대로 케이스다.
describe('★ AI 자동 전환(revealAiTab)', () => {
  const NOW = 1_700_000_000_000
  const OLD = NOW - AI_REVEAL_GRACE_MS - 1
  const call = (o: Partial<Parameters<typeof revealAiTab>[0]> = {}) =>
    revealAiTab({ live: ['s1'], known: new Set(), activeTab: 'conn', switchedAt: OLD, now: NOW, ...o })

  it('훅이 처음 말을 걸어 온 세션이 생기면 [AI] 로 간다', () => {
    expect(call().patch).toEqual({ activeTab: 'ai' })
  })

  it('① 이미 [AI] 를 보고 있으면 아무 일도 하지 않는다', () => {
    expect(call({ activeTab: 'ai' }).patch).toBeNull()
  })

  it('★ ② 방금 손으로 [파일] 을 골랐으면 뺏지 않는다 — 파일을 뒤지는 중에 바뀌는 것이 제일 나쁘다', () => {
    expect(call({ activeTab: 'file', switchedAt: NOW - 1_000 }).patch).toBeNull()
    // 유예가 지나면 다시 따라온다(영영 안 가면 그건 기능이 없는 것이다).
    expect(call({ activeTab: 'file', switchedAt: OLD }).patch).toEqual({ activeTab: 'ai' })
  })

  it('★ ③ 접힘을 건드리지 않는다 — 접은 것은 의도다', () => {
    expect(call().patch).not.toHaveProperty('collapsed')
  })

  it('★ ④ 같은 세션이 상태를 여러 번 보내도 처음 한 번만 — claude 는 도구를 부를 때마다 보낸다', () => {
    const first = call()
    expect(revealAiTab({ live: ['s1'], known: first.known, activeTab: 'conn', switchedAt: OLD, now: NOW }).patch).toBeNull()
  })

  it('둘째 AI 가 새로 뜨면 그때는 간다', () => {
    const first = call()
    expect(
      revealAiTab({ live: ['s1', 's2'], known: first.known, activeTab: 'conn', switchedAt: OLD, now: NOW }).patch
    ).toEqual({ activeTab: 'ai' })
  })

  it('사라진 세션은 잊는다 — 집합이 앱 수명 동안 자라지 않게', () => {
    expect([...call({ live: ['s2'], known: new Set(['s1']) }).known]).toEqual(['s2'])
  })

  it('AI 가 하나도 없으면 아무 일도 하지 않는다', () => {
    expect(call({ live: [] }).patch).toBeNull()
  })
})

// 2026-09-01 준영님: "세션 탭을 휠로 클릭 시 세션 종료." 닫는 경로는 이미 있다(탭의 ✕) —
// **그 함수를 그대로** 불러야 확인 창·정리 절차가 갈리지 않는다(MainArea.destroySessions 가
// 항상 물어본다). 렌더 테스트 도구가 없어 소스로 확인한다(forward.test.ts 와 같은 방식).
describe('★ 세션 탭 휠 클릭 = ✕ 와 같은 종료', () => {
  const src = readFileSync(new URL('../src/renderer/components/TermTabbar.tsx', import.meta.url), 'utf8')

  it('auxclick 이 ✕ 와 같은 onClose(s.id) 를 부른다 — 새 종료 경로를 만들지 않았다', () => {
    const aux = /onAuxClick=\{\(e\) => \{([\s\S]*?)\n      \}\}/.exec(src)?.[1] ?? ''
    expect(aux).toContain('e.button !== 1')
    expect(aux).toContain('onClose(s.id)')
    // 이 파일에서 세션을 닫는 길은 ✕ 와 휠 클릭 둘뿐이고, 둘 다 같은 콜백이다.
    expect(src.match(/onClose\(s\.id\)/g)).toHaveLength(2)
  })

  it('가운데 버튼 자동스크롤을 막는다 — 안 막으면 탭바에서 스크롤 모드가 켜진다', () => {
    expect(src).toMatch(/onMouseDown=\{\(e\) => \{\s*if \(e\.button === 1\) e\.preventDefault\(\)/)
  })
})

describe('R4.2 상태바 표시 모델', () => {
  const local: Session = { id: 's1', title: '셸 1', serverKey: 'localhost', type: 'local' }
  const ssh: Session = { id: 's2', title: 'web-01', serverKey: '결제서버', type: 'ssh' }
  const profile: ConnectionProfile = {
    id: 'p1',
    name: '결제서버',
    host: '10.9.9.9',
    port: 2222,
    username: 'deploy',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }

  it('세션이 없으면 유휴 표기(하드코딩 localhost 없음)', () => {
    const m = statusModel(null, undefined, {}, null)
    expect(m.idle).toBe(true)
    expect(m.primary).toContain('유휴')
    expect(m.dot).toBeNull()
  })

  it('SSH 세션은 user@host:port + 연결 상태 dot', () => {
    const m = statusModel(ssh, profile, { p1: 'connected' }, '/srv/서비스')
    expect(m.primary).toBe('deploy@10.9.9.9:2222')
    expect(m.dot).toBe('connected')
    expect(m.cwd).toBe('/srv/서비스')
  })

  it('연결 상태를 모르면 연결됨으로 본다(세션이 살아 있으므로)', () => {
    expect(statusModel(ssh, profile, {}, null).dot).toBe('connected')
    expect(statusModel(ssh, profile, { p1: 'error' }, null).dot).toBe('error')
  })

  it('프로필이 지워진 SSH 세션은 서버 그룹 키로 폴백(빈칸 금지)', () => {
    expect(statusModel(ssh, undefined, {}, null).primary).toBe('결제서버')
  })

  it('로컬 세션은 셸 이름 + cwd, dot 없음', () => {
    const m = statusModel(local, undefined, {}, 'D:/AI/OFA')
    expect(m.primary).toBe('셸 1')
    expect(m.dot).toBeNull()
    expect(m.cwd).toBe('D:/AI/OFA')
    expect(m.idle).toBe(false)
  })

  it('cwd 를 아직 못 받았으면 경로 칸을 비운다', () => {
    expect(statusModel(local, undefined, {}, null).cwd).toBeNull()
  })
})

// 2026-08-18 제보 ③: 상태바 게이지가 **그래프**가 됐다.
// 막대 하나로는 "지금 40%"만 알고 올라가는 중인지 내려가는 중인지를 모른다 — 서버를 보는
// 사람이 실제로 알고 싶은 건 그 방향이다. 값은 하단 [시스템 모니터]와 같은 이력을 나눠 쓴다.
describe('상태바 리소스 그래프', () => {
  const stats = { cpuPct: 40, memUsedKb: 4 * 1024 * 1024, memTotalKb: 8 * 1024 * 1024 }
  const hist = [
    { cpuPct: 10, memPct: 20 },
    { cpuPct: 30, memPct: 40 },
    { cpuPct: 40, memPct: 50 }
  ]

  it('이력이 있으면 그 시계열을 싣는다', () => {
    const g = gaugesOf(stats as never, hist)
    expect(g.find((x) => x.key === 'cpu')?.series).toEqual([10, 30, 40])
    expect(g.find((x) => x.key === 'mem')?.series).toEqual([20, 40, 50])
  })

  it('★ 이력이 아직 없으면 현재 값 하나로 채운다 — 선이 비면 자리가 흔들린다', () => {
    const g = gaugesOf(stats as never, [])
    expect(g.find((x) => x.key === 'cpu')?.series).toEqual([40])
  })

  it('GPU 는 값이 오는 서버에서만 칸이 생긴다(빈 칸을 "—" 로 남기지 않는다)', () => {
    expect(gaugesOf(stats as never, hist).some((x) => x.key === 'gpu')).toBe(false)
    const withGpu = gaugesOf({ ...stats, gpuPct: 7 } as never, hist)
    expect(withGpu.find((x) => x.key === 'gpu')?.series).toEqual([7]) // 이력에 gpuPct 가 없다
  })

  it('세션이 없으면 게이지도 없다', () => {
    expect(gaugesOf(null, hist)).toEqual([])
  })
})
