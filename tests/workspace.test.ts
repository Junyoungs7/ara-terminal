import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import { SCHEMA_VERSION, type WorkspaceSaveInput } from '../src/shared/types'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ev-ws-'))
  path = join(dir, 'workspace.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('WorkspaceStore', () => {
  it('첫 실행 시 기본 스냅샷(schemaVersion=1)을 반환한다', () => {
    const store = new WorkspaceStore(path, '0.1.0')
    const snap = store.get()
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION)
    expect(snap.profiles).toEqual([])
    expect(snap.ui.font.sizePx).toBe(14)
  })

  it('저장 후 로드하면 라운드트립된다', () => {
    const a = new WorkspaceStore(path, '0.1.0')
    a.setSidebar({ collapsed: true, activeTab: 'conn', width: 300 })
    a.update({ sessions: [], layout: { type: 'pane', sessionId: null }, tabGroups: [] })
    a.flush()
    expect(existsSync(path)).toBe(true)

    const b = new WorkspaceStore(path, '0.1.0')
    expect(b.get().ui.sidebar.collapsed).toBe(true)
  })

  it('atomic 저장 시 기존 파일을 .bak으로 보존한다', () => {
    const a = new WorkspaceStore(path, '0.1.0')
    a.flush() // 1차 기록
    a.flush() // 2차 기록 → 1차본이 .bak으로
    expect(existsSync(path + '.bak')).toBe(true)
  })

  it('손상된 workspace.json은 .bak으로 롤백한다', () => {
    // 정상 .bak 준비
    const good = new WorkspaceStore(path, '0.1.0').get()
    good.ui.sidebar.width = 999 // 이 값이 살아 돌아오면 .bak 을 읽은 것이다.
    writeFileSync(path + '.bak', JSON.stringify(good), 'utf8')
    // 주 파일 손상
    writeFileSync(path, '{ 이건 깨진 JSON', 'utf8')

    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().ui.sidebar.width).toBe(999)
  })

  it('주/백업 모두 손상 시 기본 스냅샷으로 안전 부팅한다', () => {
    writeFileSync(path, 'broken', 'utf8')
    writeFileSync(path + '.bak', 'also broken', 'utf8')
    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().schemaVersion).toBe(SCHEMA_VERSION)
    expect(store.get().sessions).toEqual([])
  })

  it('알 수 없는 미래 버전은 기본 스냅샷으로 폴백한다', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 999 }), 'utf8')
    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().schemaVersion).toBe(SCHEMA_VERSION)
  })

  /**
   * 2026-08-30(FINISH-M7): 설정 [우측 아이콘 바]를 없애면서 `ui.activityOrder`·`ui.activityHidden`
   * 을 **안 읽기로만** 했다(마이그레이션 없음). 이미 그 값이 들어 있는 workspace.json 을 쓰는
   * 사용자가 있는데, 읽는 쪽이 모르는 필드에 던지면 **그 사람은 워크스페이스를 통째로 잃는다**
   * (loadFromDisk 가 던지면 defaultSnapshot 으로 안전 부팅 → 세션·프로필·설정이 전부 초기값).
   * 그러니 "던지지 않는다"를 여기에 못 박는다 — 스키마 검증을 나중에 넣는 사람이 이 검사를 본다.
   */
  it('★ 안 읽는 옛 필드(activityOrder·activityHidden)가 있어도 워크스페이스를 잃지 않는다', () => {
    const base = new WorkspaceStore(path, '0.1.0').get()
    base.ui.sidebar.width = 321 // 이 값이 살아 돌아와야 "기본값으로 리셋"이 아니다.
    const raw = base as unknown as { ui: Record<string, unknown> }
    raw.ui.activityOrder = ['log', 'ai', '없어진항목']
    raw.ui.activityHidden = ['preview']
    writeFileSync(path, JSON.stringify(base), 'utf8')

    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().ui.sidebar.width).toBe(321)
    // 렌더러 읽기 경로도 같이 본다 — 설정 화면·부트 복원이 공유하는 하이드레이트다.
    const prefs = prefsFrom(store.get().ui)
    expect(prefs.scrollback).toBe(store.get().ui.scrollback ?? prefs.scrollback)
    expect(prefs).not.toHaveProperty('activityOrder')
    expect(prefs).not.toHaveProperty('activityHidden')
  })

  it('flush는 savedAt과 app.version을 갱신한다', () => {
    const store = new WorkspaceStore(path, '9.9.9')
    store.flush()
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.app.version).toBe('9.9.9')
    expect(typeof written.savedAt).toBe('string')
  })

  // #193: 그룹 배치(순서·2단 중첩)는 **준 것만** 덮어쓴다. 그룹 이름만 고치는 옛 호출부
  // (group.new · group.rename)가 사용자가 끌어다 정한 순서를 조용히 지우면 안 된다.
  it('그룹 배치는 준 것만 덮어쓴다 — 목록만 바꾸는 저장이 순서·중첩을 지우지 않는다', () => {
    const store = new WorkspaceStore(path, '0.1.0')
    store.setGroups(['운영', '결제'], { order: ['운영', '결제'], parents: { 결제: '운영' } })
    store.setGroups(['운영', '결제', '신규']) // 배치 없이 목록만
    expect(store.get().ui.groupOrder).toEqual(['운영', '결제'])
    expect(store.get().ui.groupParents).toEqual({ 결제: '운영' })
    // 빈 배열·빈 객체는 "지운다"는 뜻이다(undefined 와 구분한다) — 중첩을 전부 푸는 길이 있어야 한다.
    store.setGroups(['운영', '결제'], { order: [], parents: {} })
    expect(store.get().ui.groupOrder).toEqual([])
    expect(store.get().ui.groupParents).toEqual({})
  })

  // T1 BLOCKER-1 회귀: 렌더러가 삭제 전에 읽어 둔 상태를 뒤늦게 저장해도 main 소유 필드는 되살아나면 안 된다.
  // (프로필 삭제·호스트키 재설정·그룹 변경이 "껐다 켜도" 원복되던 버그.)
  it('뒤늦게 도착한 렌더러 저장이 main 소유 상태(프로필·호스트키·ui)를 되살리지 않는다', () => {
    const store = new WorkspaceStore(path, '0.1.0')
    store.upsertProfile({ id: 'p1', type: 'ssh', name: '서울-웹', host: '10.0.0.1', port: 22, username: 'deploy', auth: { type: 'key', keyPath: 'k' } })
    store.addKnownHost('10.0.0.1:22', { algorithm: 'ssh-ed25519', fingerprint: 'AAAA', firstSeen: '' })
    store.setGroups(['운영'])
    // 렌더러 persist 가 이 시점 스냅샷을 통째로 읽었다고 가정한다(옛 계약의 페이로드).
    const staleFull = structuredClone(store.get())
    store.removeProfile('p1')
    store.removeKnownHost('10.0.0.1:22')
    store.setGroups([])
    // 삭제 뒤에 도착한 저장. 타입은 이미 좁혔지만, 넓은 페이로드가 와도 main 이 세 필드만 취해야 한다.
    store.update(staleFull as WorkspaceSaveInput)

    expect(store.get().profiles).toEqual([])
    expect(store.get().knownHosts).toEqual({})
    expect(store.get().ui.groups).toEqual([])
    // 반대로 렌더러 소유 필드는 그대로 반영돼야 한다.
    store.update({ sessions: [{ id: 's1', type: 'local', title: '셸 1', serverKey: 'localhost' }], layout: { type: 'pane', sessionId: 's1' }, tabGroups: [] })
    expect(store.get().sessions).toHaveLength(1)
    expect(store.get().layout).toEqual({ type: 'pane', sessionId: 's1' })
    // 디스크까지 같은 결과(재시작 후에도 되살아나지 않는다).
    store.flush()
    const reopened = new WorkspaceStore(path, '0.1.0')
    expect(reopened.get().profiles).toEqual([])
    expect(reopened.get().sessions).toHaveLength(1)
  })

  // W4sat F21: 프로필 type 판별 필드 도입(v3→v4). 옛 스냅샷은 profiles 에 type 이 없다 —
  // 마이그레이션이 없으면 그 프로필들이 판별 유니온 밖(둘 다 아닌 형태)이 되어 auth 접근이 깨진다.
  it('schemaVersion 3(type 없는 프로필) 을 열면 전부 type:ssh 로 채워 v4 로 올라간다', () => {
    const v3 = {
      schemaVersion: 3,
      savedAt: '',
      app: { version: '0.1.0' },
      profiles: [
        { id: 'p1', name: '서울-웹', host: '10.0.0.1', port: 22, username: 'deploy', auth: { type: 'key', keyPath: 'k' } }
      ],
      knownHosts: {},
      layout: { type: 'pane', sessionId: null },
      sessions: [],
      tabGroups: [],
      ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'list', font: { term: 'x', sizePx: 14, lineHeight: 1.5 }, locale: 'ko' }
    }
    writeFileSync(path, JSON.stringify(v3), 'utf8')
    const store = new WorkspaceStore(path, '0.1.0')
    expect(store.get().schemaVersion).toBe(SCHEMA_VERSION)
    expect(store.get().profiles).toHaveLength(1)
    expect(store.get().profiles[0].type).toBe('ssh')
    // 프로필의 나머지 필드는 그대로 보존된다.
    expect(store.get().profiles[0].name).toBe('서울-웹')
  })

  it('창 크기·위치를 저장하고 재시작 후 복원한다(F6)', () => {
    const a = new WorkspaceStore(path, '0.1.0')
    a.setWindowBounds({ x: 120, y: 60, width: 1600, height: 1000 })
    a.flush()
    const b = new WorkspaceStore(path, '0.1.0')
    expect(b.get().ui.window).toEqual({ x: 120, y: 60, width: 1600, height: 1000 })
  })
})
