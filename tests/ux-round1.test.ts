import { AI_CHAT } from '../src/shared/features'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampMenu, MENU_EDGE } from '../src/renderer/interactions/ContextMenu'
import { treeMenu, terminalMenu, CONTEXT_ACTIONS } from '../src/renderer/interactions/actions'
import { migrate } from '../src/main/workspace/migrations'
import { SCHEMA_VERSION } from '../src/shared/types'
import { connectErrorTitle, connectErrorMessage, type ConnectFailure } from '../src/renderer/store/profiles'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { t } from '../src/renderer/i18n'

// 실사용 UX 라운드 1(2026-08-03) 순수 로직: 컨텍스트 메뉴 배치·항목, 구조화 실패 메시지,
// 호스트키 재설정(knownHosts 삭제).

describe('컨텍스트 메뉴 뷰포트 보정', () => {
  it('여유가 있으면 커서 위치 그대로', () => {
    expect(clampMenu(100, 100, 6, 1440, 900)).toEqual({ left: 100, top: 100 })
  })

  // 여백은 MENU_EDGE 를 그대로 쓴다 — 값을 베껴 두면 가장자리 여백을 조정할 때마다 여기가 깨진다
  // (2026-08-22 제보 24번으로 8 → 14 로 키우며 실제로 깨졌다).
  it('오른쪽 경계를 넘으면 안쪽으로 당긴다(메뉴 폭 224 + 가장자리 여백)', () => {
    expect(clampMenu(1400, 100, 6, 1440, 900).left).toBe(1440 - 224 - MENU_EDGE)
  })

  it('아래 경계를 넘으면 항목 수만큼의 높이를 빼고 올린다', () => {
    // 6항목 = 6*29 + 10 = 184 → top = 900 - 184 - 여백
    expect(clampMenu(100, 880, 6, 1440, 900).top).toBe(900 - 184 - MENU_EDGE)
  })

  it('항목이 많을수록 더 위로 올라간다', () => {
    const few = clampMenu(100, 880, 2, 1440, 900).top
    const many = clampMenu(100, 880, 6, 1440, 900).top
    expect(many).toBeLessThan(few)
  })
})

describe('트리 컨텍스트 메뉴 레지스트리', () => {
  // F27 에서 'aicli.start'(AI CLI 시작) 가 새 세션 바로 아래로 들어왔다 — 접속 계열끼리 모으고
  // 프로필 편집·삭제는 그대로 뒤에 남긴다(위험 항목은 여전히 맨 마지막).
  it('서버 노드는 연결·새 세션·AI 세션·정보 수정·복제·호스트키 재설정·삭제 7종', () => {
    const ids = treeMenu('server').map((m) => m.id)
    expect(ids).toEqual([
      'server.connect',
      'server.newSession',
      // 2026-08-18 에 뺐다가 #131(2026-08-25)에서 되돌렸다. 그때 뺀 이유는 "폴더를 물을 창이
      // 없다"였는데, 이제 물을 필요가 없다 — **그 서버의 홈**에서 시작한다(설계 §10.6).
      'aicli.start',
      'server.edit',
      'server.duplicate',
      'server.forgetHostKey',
      'server.delete'
    ])
  })

  it('삭제만 위험(danger) 톤', () => {
    const danger = treeMenu('server').filter((m) => m.danger).map((m) => m.id)
    expect(danger).toEqual(['server.delete'])
  })

  it('세션 행은 전환·이름 변경·종료, 그룹 헤더는 새 연결', () => {
    // R2.1: 트리 세션에도 이름 변경을 붙였다(탭 더블클릭과 같은 편집을 연다).
    // 2026-08-17 제보 ①: 셋뿐이라 "여기서 할 게 없다"였다 — 세션에만 있는 것(지금 그 세션이
    // 서 있는 폴더)을 쓰는 셋을 더 넣었다. 복제·AI CLI·즐겨찾기 저장 전부 그 폴더를 쓴다.
    expect(treeMenu('session').map((m) => m.id)).toEqual([
      'session.focus',
      'session.duplicate',
      'aicli.start',
      'work.save',
      'session.rename',
      'session.close'
    ])
    // 즐겨찾기 행(제보 ①) — 지울 길이 없던 자리. 사이드바와 작업대가 같은 메뉴를 쓴다.
    expect(treeMenu('fav').map((m) => m.id)).toEqual(['work.goto', 'work.rename', 'work.delete'])
    expect(treeMenu('fav').filter((m) => m.danger).map((m) => m.id)).toEqual(['work.delete'])
    // R6: 그룹 헤더에 이름 변경·삭제가 붙었다. "기타"(그룹 미지정 자리)는 바꿀 대상이 없어 새 연결만.
    expect(treeMenu('group').map((m) => m.id)).toEqual(['group.newConn', 'group.rename', 'group.delete'])
    expect(treeMenu('groupNone').map((m) => m.id)).toEqual(['group.newConn'])
    expect(treeMenu('group').filter((m) => m.danger).map((m) => m.id)).toEqual(['group.delete'])
  })

  it('탭 우클릭은 이름 변경·복제·새 창으로·닫기·다른 탭 모두 닫기 (R2.2 + F32)', () => {
    const items = treeMenu('tab')
    expect(items.map((m) => m.id)).toEqual([
      'session.rename',
      'session.duplicate',
      // F32: 탭을 별도 OS 창으로 떼어낸다(다른 모니터에 놓으려고). 창을 떼는 조작은 탭을 잡고
      // 하는 것이 자연스러워 트리 세션 행이 아니라 여기에만 붙였다.
      'session.detach',
      'session.close',
      'session.closeOthers'
    ])
    // 되돌리기 어려운 "다른 탭 모두 닫기"만 위험 톤.
    expect(items.filter((m) => m.danger).map((m) => m.id)).toEqual(['session.closeOthers'])
  })

  it('탭바 ＋ 메뉴는 로컬 셸 / SSH 연결 2종 — 세션을 **만드는** 자리다(2026-08-18)', () => {
    expect(treeMenu('add').map((m) => m.id)).toEqual(['local.new', 'ssh.open'])
  })

  it('사이드바 빈 영역은 로컬 셸·새 연결·새 그룹·작업 프로필 4종', () => {
    const items = treeMenu('sidebar')
    // work.open = 작업 프로필 팝업(서버+폴더 즐겨찾기). 트리에 행을 만들지 않는 대신 여기가 진입점이다.
    expect(items.map((m) => m.id)).toEqual(['local.new', 'ssh.open', 'group.new', 'work.open'])
    // R6: "준비 중" 흐린 톤을 걷어냈다 — 이제 실제로 빈 그룹을 만든다.
    expect(items.every((m) => m.dim === undefined)).toBe(true)
    expect(treeMenu('sidebar').find((m) => m.id === 'group.new')!.label).not.toContain('준비 중')
  })

  it('모든 항목의 라벨이 번역된다(키가 그대로 노출되지 않음)', () => {
    for (const kind of ['server', 'session', 'group', 'groupNone', 'local', 'sidebar', 'add'] as const) {
      for (const item of treeMenu(kind)) {
        expect(item.label).not.toContain('conn.menu.')
        expect(item.label.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('터미널 우클릭 리스트 메뉴 (기본값)', () => {
  // 2026-08-18(준영님 제보): 평면 여덟 줄이던 것을 묶었다 — 분할 둘은 [분할 ▸], CLI 셋은
  // [AI 실행 ▸] 서브메뉴로. 그래서 메뉴 목록은 CONTEXT_ACTIONS 와 **더 이상 1:1 이 아니다.**
  // 대신 지켜야 할 것은 "레지스트리에 있는 항목이 하나도 빠지지 않는가"다.
  it('CONTEXT_ACTIONS 가 하나도 빠짐없이 메뉴에 오른다(이중 정의 없음)', () => {
    const flat = terminalMenu().flatMap((m) => [m.id, ...(m.submenu?.map((x) => x.id) ?? [])])
    for (const a of CONTEXT_ACTIONS) expect(flat).toContain(a.id)
  })

  it('★ 묶음 둘이 서브메뉴로 있다 — 같은 일의 변형은 펼치지 않는다', () => {
    const menu = terminalMenu()
    const split = menu.find((m) => m.id === 'split')
    expect(split?.submenu?.map((m) => m.id)).toEqual(['split.horizontal', 'split.vertical'])
    const ai = menu.find((m) => m.id === 'aicli.run')
    expect(ai?.submenu?.map((m) => m.id)).toEqual([
      'aicli.run.claude',
      'aicli.run.codex',
      'aicli.run.gemini'
    ])
  })

  it('★ 이름이 짧다 — 이 메뉴는 터미널 위에서 열리므로 대상을 설명할 필요가 없다', () => {
    const labels = terminalMenu().map((m) => m.label)
    expect(labels).toContain('닫기') // 예전엔 "이 칸 닫기(세션 종료)"
    expect(labels).toContain('복제') // 예전엔 "세션 복제"
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(8)
  })

  // 아이콘은 **첫 단계 줄에만** 필요하다(서브메뉴 안은 글자만 — 부모 아이콘이 이미 맥락을 준다).
  // 묶음 부모의 아이콘을 참조로 끌어오면 그 항목이 목록에서 빠지는 순간 조용히 빈칸이 된다 —
  // 2026-08-18 에 실제로 그랬다(분할을 서브메뉴로 옮기자 부모 아이콘이 undefined 가 됐다).
  it('모든 항목이 아이콘 + 라벨을 갖는다', () => {
    for (const m of terminalMenu()) {
      expect(m.icon, `아이콘 없음: ${m.id}`).toBeTruthy()
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  it('단축키 힌트는 **실제로 손이 가는 조합**을 적는다', () => {
    const menu = terminalMenu()
    const byId = Object.fromEntries(menu.map((m) => [m.id, m]))
    const sub = Object.fromEntries((byId['split'].submenu ?? []).map((m) => [m.id, m]))
    expect(sub['split.horizontal'].hint).toBe('Ctrl Shift -')
    expect(sub['split.vertical'].hint).toBe('Ctrl Shift \\')
    expect(byId['pane.close'].hint).toBe('Ctrl Shift W')
    expect(byId['session.duplicate'].hint).toBe('Ctrl Shift D')
    // 2026-08-18(준영님 지적): 클립보드는 KEYMAP 상 Ctrl+Shift+C/V 지만 터미널에서 사람이
    // 누르는 건 Ctrl+C/V 다(선택이 있으면 복사, 없으면 SIGINT — R3.1). 메뉴가 **안 쓰는
    // 조합을 가르치고 있었다.** 대신 그 키가 먹으면 토스트로 알린다(TerminalPane).
    expect(byId['copy'].hint).toBe('Ctrl C')
    expect(byId['paste'].hint).toBe('Ctrl V')
  })

  it('패널 닫기는 위험 톤, 흐린(추후) 항목은 하나도 없다', () => {
    const byId = Object.fromEntries(terminalMenu().map((m) => [m.id, m]))
    expect(byId['pane.close'].danger).toBe(true)
    // 2026-08-14: log.save 가 실배선돼 흐린 항목이 사라졌다.
    expect(terminalMenu().filter((m) => m.dim).map((m) => m.id)).toEqual([])
    expect(byId['copy'].dim).toBeUndefined()
    // W3: 아라가 실배선돼 [AI에게 질문] 은 더 이상 흐리지 않다(누르면 실제로 패널이 열린다).
    // 아라 대화를 숨긴 판에는 이 항목 자체가 없다(features.AI_CHAT).
    if (AI_CHAT) expect(byId['ai.ask'].dim).toBeUndefined()
  })
})

// #67(2026-08-14): 이 describe 는 원래 ui.ctxMenuStyle 기본값·강등을 봤다. 라디얼·팔레트를 지우며
// 그 필드가 없어졌으므로, 남은 관심사는 **그 필드를 담고 있던 옛 스냅샷이 그대로 열리는가**다 —
// v1/v2 파일은 지금도 현장에 있고, 마이그레이션이 끊기면 사용자 프로필이 통째로 날아간다.
describe('옛 스냅샷 마이그레이션(우클릭 스타일 제거 후)', () => {
  it('v2 저장값(ctxMenuStyle 포함)이 최신 버전으로 올라온다', () => {
    const v2 = {
      schemaVersion: 2,
      savedAt: '2026-08-03T00:00:00Z',
      app: { version: '0.1.0' },
      profiles: [],
      knownHosts: {},
      layout: { type: 'pane', sessionId: null },
      sessions: [],
      tabGroups: [],
      ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: {}, locale: 'ko' }
    }
    const out = migrate(v2 as unknown as Record<string, unknown>)
    expect(out!.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out!.ui.sidebar.width).toBe(264)
  })

  it('v1 스냅샷도 데이터를 잃지 않고 최신 버전이 된다', () => {
    for (const old of ['radial', 'palette']) {
      const v1 = {
        schemaVersion: 1,
        savedAt: '2026-08-02T00:00:00Z',
        app: { version: '0.1.0' },
        profiles: [{ id: 'p1', name: 'KVT' }],
        knownHosts: {},
        layout: { type: 'pane', sessionId: null },
        sessions: [],
        tabGroups: [],
        ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: old, font: {}, locale: 'ko' }
      }
      const out = migrate(v1 as unknown as Record<string, unknown>)
      expect(out).not.toBeNull()
      expect(out!.schemaVersion).toBe(SCHEMA_VERSION)
      // 마이그레이션이 사용자 데이터를 날리지 않는다.
      expect(out!.profiles).toHaveLength(1)
      expect(out!.ui.sidebar.width).toBe(264)
    }
  })
})

describe('연결 실패 구조화 메시지', () => {
  const cases: ConnectFailure[] = [
    { ok: false, reason: 'auth', message: 'All configured authentication methods failed' },
    { ok: false, reason: 'network', message: 'ECONNREFUSED' },
    { ok: false, reason: 'orphanSecret' },
    { ok: false, reason: 'hostKeyNew', hostId: 'h:22', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x' },
    {
      ok: false,
      reason: 'hostKeyMismatch',
      hostId: 'h:22',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:x',
      knownFingerprint: 'SHA256:y'
    }
  ]

  it('모든 실패 사유가 한국어 제목·설명으로 해석된다(i18n 키 노출 금지)', () => {
    for (const c of cases) {
      const title = connectErrorTitle(c)
      const msg = connectErrorMessage(c)
      expect(title).not.toContain('conn.fail.')
      expect(msg).not.toContain('conn.fail.')
      expect(msg.length).toBeGreaterThan(title.length)
    }
  })

  it('사유마다 제목이 서로 다르다("연결 실패" 한 덩어리로 뭉치지 않음)', () => {
    const titles = cases.map(connectErrorTitle)
    expect(new Set(titles).size).toBe(cases.length)
  })

  it('인증 실패 안내는 비밀번호 재입력을 지시한다', () => {
    expect(connectErrorMessage(cases[0])).toContain('비밀번호')
  })
})

describe('호스트키 재설정 (knownHosts 삭제)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ev-hk-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('저장된 항목을 지우고 true, 없으면 false', () => {
    const store = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    store.addKnownHost('192.168.100.56:22', {
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      firstSeen: new Date().toISOString()
    })
    expect(store.removeKnownHost('192.168.100.56:22')).toBe(true)
    expect(store.getKnownHosts()['192.168.100.56:22']).toBeUndefined()
    expect(store.removeKnownHost('192.168.100.56:22')).toBe(false)
  })

  it('삭제가 디스크에 즉시 반영된다(재시작 후에도 지워진 상태)', () => {
    const path = join(dir, 'workspace.json')
    const a = new WorkspaceStore(path, '0.1.0')
    a.addKnownHost('h:22', { algorithm: 'ssh-rsa', fingerprint: 'SHA256:q', firstSeen: '2026-08-03T00:00:00.000Z' })
    a.removeKnownHost('h:22')
    expect(new WorkspaceStore(path, '0.1.0').getKnownHosts()).toEqual({})
  })

  it('다른 호스트 항목은 건드리지 않는다', () => {
    const store = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    const hk = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:a', firstSeen: '2026-08-03T00:00:00.000Z' }
    store.addKnownHost('a:22', hk)
    store.addKnownHost('b:22', hk)
    store.removeKnownHost('a:22')
    expect(Object.keys(store.getKnownHosts())).toEqual(['b:22'])
  })
})

// 2026-08-28 감사 ①·② 회귀 가드.
//
// `t()` 는 없는 키를 **키 문자열 그대로** 돌려준다(i18n/index.ts:24) — 개발 중에 누락을 눈에
// 띄게 하려는 설계인데, 그대로 배포되면 사용자가 화면에서 `dlg.close` 같은 글자를 읽는다.
// 실제로 세 자리가 그렇게 새 있었다(그중 하나는 새 PC 첫 실행 경로였다).
//
// 여기 적힌 것은 그때 새어 나갔거나 그 수리로 새로 생긴 키들이다. 소비하는 자리를 함께 적어 둔다
// — 키를 지우거나 이름을 바꿀 때 어디가 깨지는지 이 표만 보면 안다.
// (모든 `t()` 호출을 훑는 일반 검사는 별건이다 — scan:i18n.)
describe('화면에 새면 안 되는 i18n 키', () => {
  const USED_AT: readonly [key: string, where: string][] = [
    ['dlg.close', 'WorkProfileModal 푸터 버튼 · 닫기 아이콘 툴팁'],
    ['ai.noKey.desc.suffix', 'AiPanel·AiBootstrapModal 노키 안내(프로바이더 이름 뒤에 붙는다)'],
    ['sidebar.tab.conn', 'ConnTree 트리의 접근성 이름'],
    ['console.ctr.loading', 'ContainerTable 첫 바퀴 전'],
    ['console.k8s.loading', 'K8sPanel 첫 바퀴 전'],
    ['mon.loading', 'PortMonitor 첫 바퀴 전'],
    ['console.err.noSession', 'ctrShared 가 remoteError 로 옮기는 세션 끊김 사유']
  ]

  for (const [key, where] of USED_AT) {
    it(`${key} — ${where}`, () => {
      const text = t(key)
      expect(text, `${key} 가 ko.json 에 없다 — 이 자리에 키 문자열이 그대로 찍힌다`).not.toBe(key)
      expect(text.trim().length).toBeGreaterThan(0)
    })
  }

  // 로딩 문구가 빈 문구와 같으면 고쳐 봐야 화면은 그대로다(둘을 갈라 놓은 것이 수리의 전부다).
  it('로딩 문구와 빈 문구는 서로 다른 말이다', () => {
    expect(t('console.ctr.loading')).not.toBe(t('console.ctr.none'))
    expect(t('console.k8s.loading')).not.toBe(t('console.k8s.none'))
    expect(t('mon.loading')).not.toBe(t('mon.empty'))
  })
})
