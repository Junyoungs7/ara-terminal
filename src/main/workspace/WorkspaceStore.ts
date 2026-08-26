// WorkspaceStore — 사람이 읽는 JSON 스냅샷 영속화 (계획서 §B.3/§B.7).
// 로드: path → .bak → 마이그레이션 → 실패 시 기본 스냅샷(안전 부팅).
// 저장: 30초 디바운스 주기 flush + before-quit 동기 flush 이중화. atomic + .bak.
import type {
  DetachedWindowState, WorkspaceSnapshot, WorkspaceSaveInput, ConnectionProfile, KnownHost, FontConfig, WindowBounds, UiPrefs, SidebarState, WorkProfile, AiCliRecent } from '@shared/types'
import { SCHEMA_VERSION } from '@shared/types'
import { aiSessionsOf } from '@shared/aiSession'
import { writeJsonAtomic, readJsonWithBackup, cleanupTemp } from '../util/atomicJson'
import { defaultSnapshot } from './defaults'
import { migrate } from './migrations'

const FLUSH_DEBOUNCE_MS = 30_000

export class WorkspaceStore {
  private snapshot: WorkspaceSnapshot
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly path: string,
    private readonly appVersion: string
  ) {
    cleanupTemp(path)
    this.snapshot = this.loadFromDisk()
  }

  private loadFromDisk(): WorkspaceSnapshot {
    const raw = readJsonWithBackup<Record<string, unknown> | null>(this.path, null)
    if (raw === null) return defaultSnapshot(this.appVersion)
    if (raw.schemaVersion === SCHEMA_VERSION) return raw as unknown as WorkspaceSnapshot
    // 버전 불일치 → 마이그레이션 시도, 실패 시 안전 부팅
    return migrate(raw) ?? defaultSnapshot(this.appVersion)
  }

  get(): WorkspaceSnapshot {
    return this.snapshot
  }

  // 렌더러 소유 필드(세션·레이아웃·탭그룹)만 병합 + 주기 flush 예약(디바운스).
  // profiles·knownHosts·ui 는 여기서 건드리지 않는다 — 그쪽 주인은 main 이고, 렌더러가 읽어 둔
  // 사본으로 통째 교체하던 시절엔 삭제·호스트키 재설정이 뒤늦은 저장에 되살아났다(T1 BLOCKER-1).
  update(state: WorkspaceSaveInput): void {
    // 렌더러가 보낸 것은 신뢰 경계 밖 입력이다 — 세 필드만 골라 쓴다(스프레드로 통째 병합하면
    // 옛 페이로드나 조작된 페이로드가 profiles·knownHosts 를 되살릴 수 있다). 모양이 아니면 버린다.
    const { sessions, layout, tabGroups } = state ?? {}
    if (!layout || !Array.isArray(sessions) || !Array.isArray(tabGroups)) return
    this.snapshot = { ...this.snapshot, sessions, layout, tabGroups }
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS)
  }

  /**
   * #128 AI 세션(작업대) 목록. update() 의 세 필드 화이트리스트를 건드리지 않으려고 따로 둔다
   * (창 자리·설정과 같은 결). 저장값은 신뢰 경계 밖이라 aiSessionsOf 로 모양을 맞춰 받는다.
   */
  setAiSessions(list: unknown): void {
    this.snapshot.aiSessions = aiSessionsOf(list)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS)
  }

  /**
   * F32 R2: 떼어낸 창들의 자리. **main 이 소유한다** — 렌더러가 보낸 페이로드에 섞어 받지 않는다
   * (update() 가 세 필드만 골라 쓰는 것과 같은 이유: 신뢰 경계 밖 입력으로 창 좌표를 정하지 않는다).
   * 빈 배열이면 필드를 지운다 — 창을 다 닫았는데 옛 자리가 남아 다음 부팅에 되살아나면 안 된다.
   */
  setDetachedWindows(windows: DetachedWindowState[]): void {
    if (windows.length === 0) delete this.snapshot.windows
    else this.snapshot.windows = windows
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS)
  }

  // ── 창 크기·위치(F6). resize/move 는 고빈도라 즉시 flush 대신 디바운스 예약(update 와 동일). ──
  setWindowBounds(bounds: WindowBounds): void {
    this.snapshot.ui.window = bounds
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS)
  }

  // 즉시 디스크 기록(before-quit 훅에서 동기 호출).
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.snapshot.savedAt = new Date().toISOString()
    this.snapshot.app.version = this.appVersion
    writeJsonAtomic(this.path, this.snapshot)
  }

  // ── 프로필/knownHosts (F3). 프로필 변경은 저빈도·중요 상태이므로 즉시 flush. ──
  getProfiles(): ConnectionProfile[] {
    return this.snapshot.profiles
  }

  getProfile(id: string): ConnectionProfile | undefined {
    return this.snapshot.profiles.find((p) => p.id === id)
  }

  // id가 이미 있으면 교체, 없으면 추가. 즉시 flush로 재시작 후에도 유지(완료조건).
  upsertProfile(profile: ConnectionProfile): void {
    const idx = this.snapshot.profiles.findIndex((p) => p.id === profile.id)
    if (idx >= 0) this.snapshot.profiles[idx] = profile
    else this.snapshot.profiles.push(profile)
    this.flush()
  }

  removeProfile(id: string): ConnectionProfile | undefined {
    const idx = this.snapshot.profiles.findIndex((p) => p.id === id)
    if (idx < 0) return undefined
    const [removed] = this.snapshot.profiles.splice(idx, 1)
    this.flush()
    return removed
  }

  // ── 터미널 동작 설정(R5 설정 창). 저빈도·재시작 지속 필요 → 즉시 flush. ──
  setPrefs(prefs: UiPrefs): void {
    this.snapshot.ui = { ...this.snapshot.ui, ...prefs }
    this.flush()
  }

  // ── 연결 그룹 목록(R6). 빈 그룹은 프로필에서 파생되지 않으므로 여기에만 남는다. ──
  setGroups(groups: string[]): void {
    this.snapshot.ui.groups = groups
    this.flush()
  }

  // ── 작업 프로필(서버+폴더 즐겨찾기). 그룹 목록과 같은 자리·같은 규칙(저빈도, 즉시 flush). ──
  setWorkProfiles(list: WorkProfile[]): void {
    this.snapshot.ui.workProfiles = list
    this.flush()
  }

  // ── F27 AI CLI 최근 목록. 작업 프로필과 같은 자리·같은 규칙(전체 덮어쓰기, 즉시 flush). ──
  setAiCliRecent(list: AiCliRecent[]): void {
    this.snapshot.ui.aiCliRecent = list
    this.flush()
  }

  // ── 폰트 설정(F5). ui.font{term,sizePx,lineHeight}. 저빈도·재시작 지속 필요 → 즉시 flush. ──
  setFont(font: FontConfig): void {
    this.snapshot.ui.font = font
    this.flush()
  }

  /** 지난 대화 이름(2026-08-26). 빈 이름은 지운다 — "이름 없음"을 저장할 이유가 없다. */
  setAraChatName(id: string, name: string): void {
    const names = { ...(this.snapshot.ui.araChatNames ?? {}) }
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (clean) names[id] = clean
    else delete names[id]
    this.snapshot.ui.araChatNames = names
    this.flush()
  }

  /**
   * F23 MCP 서버 on/off (2026-08-26). **기본은 켬** — 미지정과 false 를 구분하려고 저장한다.
   * 저장하지 않으면 사용자가 끈 것이 재시작 때마다 되살아나 "껐는데 왜 또 켜지지"가 된다.
   */
  setMcpEnabled(on: boolean): void {
    this.snapshot.ui.mcpEnabled = on
    this.flush()
  }

  // ── 사이드바 폭·접힘·활성 탭(R4.3). 드래그 중이 아니라 놓았을 때만 오므로 저빈도 → 즉시 flush. ──
  setSidebar(sidebar: SidebarState): void {
    this.snapshot.ui.sidebar = sidebar
    this.flush()
  }

  getKnownHosts(): Record<string, KnownHost> {
    return this.snapshot.knownHosts
  }

  addKnownHost(hostId: string, host: KnownHost): void {
    this.snapshot.knownHosts[hostId] = host
    this.flush()
  }

  // 호스트키 재설정(서버 재설치 등으로 지문이 바뀐 뒤 mismatch 차단을 푸는 유일한 수단).
  // 다음 접속은 다시 최초 접속(TOFU 확인)으로 취급된다. 지운 항목이 있으면 true.
  removeKnownHost(hostId: string): boolean {
    if (!(hostId in this.snapshot.knownHosts)) return false
    delete this.snapshot.knownHosts[hostId]
    this.flush()
    return true
  }
}
