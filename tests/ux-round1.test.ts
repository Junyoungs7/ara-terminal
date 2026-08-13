import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clampMenu } from '../src/renderer/interactions/ContextMenu'
import { treeMenu, terminalMenu, CONTEXT_ACTIONS } from '../src/renderer/interactions/actions'
import { migrate } from '../src/main/workspace/migrations'
import { SCHEMA_VERSION } from '../src/shared/types'
import { defaultSnapshot } from '../src/main/workspace/defaults'
import { connectErrorTitle, connectErrorMessage, type ConnectFailure } from '../src/renderer/store/profiles'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'

// 실사용 UX 라운드 1(2026-08-03) 순수 로직: 컨텍스트 메뉴 배치·항목, 구조화 실패 메시지,
// 호스트키 재설정(knownHosts 삭제).

describe('컨텍스트 메뉴 뷰포트 보정', () => {
  it('여유가 있으면 커서 위치 그대로', () => {
    expect(clampMenu(100, 100, 6, 1440, 900)).toEqual({ left: 100, top: 100 })
  })

  it('오른쪽 경계를 넘으면 안쪽으로 당긴다(224 + 8 여백)', () => {
    expect(clampMenu(1400, 100, 6, 1440, 900).left).toBe(1440 - 224 - 8)
  })

  it('아래 경계를 넘으면 항목 수만큼의 높이를 빼고 올린다', () => {
    // 6항목 = 6*29 + 10 = 184 → top = 900 - 184 - 8
    expect(clampMenu(100, 880, 6, 1440, 900).top).toBe(900 - 184 - 8)
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
  it('서버 노드는 연결·새 세션·AI CLI·정보 수정·복제·호스트키 재설정·삭제 7종', () => {
    const ids = treeMenu('server').map((m) => m.id)
    expect(ids).toEqual([
      'server.connect',
      'server.newSession',
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
    expect(treeMenu('session').map((m) => m.id)).toEqual([
      'session.focus',
      'session.rename',
      'session.close'
    ])
    // R6: 그룹 헤더에 이름 변경·삭제가 붙었다. "기타"(그룹 미지정 자리)는 바꿀 대상이 없어 새 연결만.
    expect(treeMenu('group').map((m) => m.id)).toEqual(['group.newConn', 'group.rename', 'group.delete'])
    expect(treeMenu('groupNone').map((m) => m.id)).toEqual(['group.newConn'])
    expect(treeMenu('group').filter((m) => m.danger).map((m) => m.id)).toEqual(['group.delete'])
  })

  it('탭 우클릭은 이름 변경·복제·닫기·다른 탭 모두 닫기 (R2.2)', () => {
    const items = treeMenu('tab')
    expect(items.map((m) => m.id)).toEqual([
      'session.rename',
      'session.duplicate',
      'session.close',
      'session.closeOthers'
    ])
    // 되돌리기 어려운 "다른 탭 모두 닫기"만 위험 톤.
    expect(items.filter((m) => m.danger).map((m) => m.id)).toEqual(['session.closeOthers'])
  })

  it('탭바 ＋ 메뉴는 로컬 셸 / SSH 연결 / AI CLI 시작 3종(F27 진입점 ①)', () => {
    expect(treeMenu('add').map((m) => m.id)).toEqual(['local.new', 'ssh.open', 'aicli.start'])
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
  it('라디얼·팔레트와 같은 CONTEXT_ACTIONS 를 그대로 쓴다(이중 정의 없음)', () => {
    expect(terminalMenu().map((m) => m.id)).toEqual(CONTEXT_ACTIONS.map((a) => a.id))
  })

  it('모든 항목이 아이콘 + 라벨을 갖는다', () => {
    for (const m of terminalMenu()) {
      expect(m.icon).toBeTruthy()
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  it('keymap 에 있는 액션은 단축키 힌트를 단다', () => {
    const byId = Object.fromEntries(terminalMenu().map((m) => [m.id, m]))
    // R3.8 충돌 정책으로 전부 Ctrl+Shift 계열로 옮겼다 — 힌트도 keymap 단일 소스에서 따라온다.
    expect(byId['split.horizontal'].hint).toBe('Ctrl+Shift+-')
    expect(byId['split.vertical'].hint).toBe('Ctrl+Shift+\\')
    expect(byId['pane.close'].hint).toBe('Ctrl+Shift+W')
    expect(byId['session.duplicate'].hint).toBe('Ctrl+Shift+D')
    // R3.1: 복사/붙여넣기도 이제 keymap 항목(clipboard.*)이 있어 힌트가 붙는다.
    expect(byId['copy'].hint).toBe('Ctrl+Shift+C')
    expect(byId['paste'].hint).toBe('Ctrl+Shift+V')
  })

  it('패널 닫기는 위험 톤, 남은 미래 기능(로그 저장)만 흐린 톤', () => {
    const byId = Object.fromEntries(terminalMenu().map((m) => [m.id, m]))
    expect(byId['pane.close'].danger).toBe(true)
    expect(byId['log.save'].dim).toBe(true)
    expect(byId['copy'].dim).toBeUndefined()
    // W3: 아라가 실배선돼 [AI에게 질문] 은 더 이상 흐리지 않다(누르면 실제로 패널이 열린다).
    expect(byId['ai.ask'].dim).toBeUndefined()
  })
})

describe('우클릭 스타일 기본값·마이그레이션', () => {
  it('새 워크스페이스 기본값은 list', () => {
    expect(defaultSnapshot('0.1.0').ui.ctxMenuStyle).toBe('list')
  })

  it('토글을 제거한 뒤에도 v2 저장값 radial/palette 는 list 로 내려온다(R1.4)', () => {
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
    expect(out!.ui.ctxMenuStyle).toBe('list')
    expect(out!.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('v1 스냅샷의 radial/palette 는 최신 버전으로 올리며 list 가 된다', () => {
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
      expect(out!.ui.ctxMenuStyle).toBe('list')
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
