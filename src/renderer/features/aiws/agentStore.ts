// M3 에이전트 — 렌더러 상태(zustand). Orca slices/detected-agents.ts(감지 목록) + 터미널 탭(terminal-tab-agent-launch-pane.ts)의 1차 부분.
// 탭은 main 의 로컬 세션(space:'ai'). R2: 에이전트 상태(훅 + 화면 판정)를 'agents:status' 로 받고 봄/안 봄(done·idle)을 여기서 가른다.
// AI 작업 공간 청크 안에 산다 — 처음 열 때만 불러온다.
import { create } from 'zustand'
import type { AgentId, AgentSettings, DetectedAgent } from '@shared/agents'
import type { AgentLaunchOptions, AgentLaunchResult, AgentTabInfo } from '@shared/ipc'
import { AGENT_SESSION_LOST_EXIT, type AgentStatusView } from '@shared/agentHooks'
import { areWorktreePathsEqual } from '@shared/worktrees'
import { AGENTS } from '@shared/agents'
import { nextSeen } from './agentStatusView'
import { FEED_CAP, feedKindOf, noteKindOf, type FeedEvent, type FeedKind } from './agentBoard'
import { ensureAiwsLoaded, hostOfWorktree, useAiwsStore } from './store'
import { agentNotesEnabled, openNoteVia, pushNote } from '../../store/notify'
import { isLockedNow } from '../../store/lock'
import { t } from '../../i18n'
import { clearDraft, readChatOn, writeChatOn } from './chatDraft'
import { deriveGeneratedTabTitle } from '@shared/agentTabTitle'
import { openSettings } from '../../store/settingsNav'
import { OrielInstallButton } from './OrielInstall'
import { layoutOf, orderTabs, readTabLayout, restoreActive, writeTabLayout } from './tabLayout'

export type AgentTab = {
  sessionId: string
  agent: AgentId
  /** 어느 작업 단위의 탭인가 — 사이드바에서 고른 워크트리의 탭만 보인다. */
  worktreeId: string
  title: string
  /** 셸에 친 한 줄(탭 제목 툴팁 — 무엇이 실행됐는지 감추지 않는다). */
  line: string
  exited: boolean
  /** M4 DM-01: 데몬이 죽어 세션을 잃었다(종료와 구별해 그린다). */
  lost?: boolean
  /** 첫 지시(넣지 못했을 때 사람이 붙여 넣게 보여 준다). */
  prompt?: string
  /** M5 AI-19 채팅 이름(첫 요청으로 지은 것). 없으면 에이전트 이름만. */
  name?: string
  /** M8 DM-05 원격(관리형 서버 hostKey). 잃음 = SSH 끊김 — 세션은 서버에 살아 [다시 연결]로 이어 붙는다. */
  host?: string
  /** M11 지난 세션에서 재개했을 때 그 세션 제목(Orca aiVaultTitle). */
  vaultTitle?: string
  /** M11 첫 지시로 지은 제목(Orca generatedTitle — 설정 tabAutoTitle 이 켜졌을 때만 보인다). */
  genTitle?: string
  /** p3-M21 잠재우기(hibernation.ts) — 세션은 끝났고 돌아오면 이 세션 id 로 이어 띄운다. minutes = 쉬던 시간(알림 글). */
  slept?: { resume: string; minutes: number }
  /** p3-M21 잠들었다 깨어난 탭 — 그 탭을 보는 동안 한 줄 알림(분). */
  woke?: number
  /** R0 띄운 계정(main 이 알려 준 것 — null = 시스템 기본). 없으면 모름(예전·되살린 탭 — 지금 고른 계정으로 본다). */
  account?: string | null
  /** R0 다른 계정으로 이어 띄운 탭 — 그 계정 이름(한 줄 알림, [닫기]로 걷는다). */
  switched?: string
}

type AgentState = {
  /** null = 아직 안 찾음. */
  detected: DetectedAgent[] | null
  detecting: boolean
  settings: AgentSettings | null
  tabs: AgentTab[]
  activeTabByWorktree: Record<string, string>
  /** 탭(세션)별 에이전트 상태 — main 원장의 사본. */
  statusById: Record<string, AgentStatusView>
  /** R1 원격 탭에 지금 붙은 PC 이름들(이 PC 포함 — 둘 이상이면 탭에 "PC n대"). 붙을 때 사건이 탭보다 먼저 올 수 있어 탭과 따로 둔다. */
  viewersById: Record<string, string[]>
  /** R3 원격 탭이 한도에 걸렸다(서버 훅 StopFailure rate_limit — 다음 지시면 풀림). 탭보다 먼저 올 수 있어 따로 둔다. */
  limitById: Record<string, boolean>
  /** 봤나(herdr seen). 없으면 본 것. */
  seenById: Record<string, boolean>
  /** 지금 화면에 보이는 에이전트 탭(AI 작업 공간이 열려 있고 그 탭이 고른 탭). 없으면 null. */
  viewing: string | null
  /** 가운데에 무엇을 그리나 — 고른 작업 단위(탭) · 대시보드(AI-08) · 활동 피드(AI-09). 레일이 바꾼다. */
  view: AiwsView
  /** 활동 피드(AI-09) — 상태 변화 이력, 들어온 순. 그릴 때 feedView 로 최신이 위. */
  feed: FeedEvent[]
  /** M5 AI-13: 채팅으로 보는 탭(없으면 터미널). AI-14: 새 탭은 설정 › 에이전트의 "채팅 | CLI" 를 따르고, 고른 것은 재시작 뒤에도(localStorage). */
  chatOn: Record<string, boolean>
  toggleChat: (sessionId: string) => void
  loadAgents: (force?: boolean) => Promise<void>
  saveSettings: (next: AgentSettings) => Promise<void>
  /** resume = 지난 세션 id(M4 AI-07) — 첫 지시 대신 재개로 띄운다. */
  launchAgent: (o: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string; resume?: string; options?: AgentLaunchOptions; vaultTitle?: string }) => Promise<AgentLaunchResult>
  /** M11 재시작 칩(Orca Restart chip) — 끝난 탭(또는 에이전트만 끝난 탭) 자리에서 같은 에이전트·같은 폴더로 새로 띄운다. 실패면 사유. */
  restartTab: (sessionId: string) => Promise<string | null>
  setActiveTab: (worktreeId: string, sessionId: string) => void
  /** M8 DM-05 끊긴 원격 탭 [다시 연결] — 그 서버의 끊긴 탭을 모두 같은 세션으로 되살린다. 실패면 사유. */
  reconnectHost: (hostKey: string) => Promise<string | null>
  /** R1 서버 세션에 붙기(다른 PC 가 만든 것도) — 이 PC 에 그 저장소가 없으면 등록하고, 그 탭으로 간다. 실패면 사유. */
  attachRemote: (hostKey: string, sessionId: string) => Promise<string | null>
  /** R1 탭 메뉴 "서버에서도 끝내기" — 서버의 에이전트를 끝내고 탭을 닫는다(다른 PC 의 탭도 끝남으로). */
  endRemote: (sessionId: string) => Promise<void>
  /** 탭 닫기. 원격 탭은 이 PC 에서만(R1 결정 4 ⓑ — 서버 세션은 산다). */
  closeTab: (sessionId: string) => void
  setViewing: (sessionId: string | null) => void
  setView: (view: AiwsView) => void
}

/** search = 왼쪽 목록 자리가 전체 검색(WS-09)으로 바뀌고 가운데는 작업 단위 그대로. */
export type AiwsView = 'worktree' | 'dashboard' | 'activity' | 'sessions' | 'servers' | 'search'

export const useAgentStore = create<AgentState>()((set, get) => ({
  detected: null,
  detecting: false,
  settings: null,
  tabs: [],
  activeTabByWorktree: {},
  statusById: {},
  viewersById: {},
  limitById: {},
  seenById: {},
  viewing: null,
  view: 'worktree',
  feed: [],
  chatOn: readChatOn(),

  loadAgents: async (force) => {
    startStatus()
    if (get().detecting) return
    set({ detecting: true })
    try {
      const [settings, detected] = await Promise.all([window.ev.agents.getSettings(), window.ev.agents.detect(force)])
      set({ settings, detected })
    } finally {
      set({ detecting: false })
    }
  },

  saveSettings: async (next) => {
    set({ settings: next })
    set({ settings: await window.ev.agents.setSettings(next) })
  },

  launchAgent: async ({ agent, worktreeId, cwd, prompt, resume, options, vaultTitle }) => {
    // M8 DM-05 실행 위치 = 그 작업 단위의 프로젝트 자리(원격 저장소면 그 서버). 모든 실행 길(새 작업·+ 탭·지난 세션 재개)이 여기를 지난다.
    const host = hostOfWorktree(worktreeId)
    const r = await window.ev.agents.launch(agent, cwd, prompt, resume, options, host)
    if (!r.ok) return r
    // M9 R2 Oriel 이 없어 웹 도구 없이 띄웠다(main 이 앱 실행 중 처음 한 번만 알려 준다). 설치 안내는 설정 › 에이전트.
    if (r.noOriel) pushNote({ kind: 'info', space: 'ai', title: t('aiws.note.noOriel'), body: t('aiws.note.noOriel.body'), go: () => openSettings('agents', 'agents.oriel'), extra: OrielInstallButton })
    // M11 실행 지시로 지은 제목 — main 도 같은 규칙으로 짓지만 그 push 는 launch 응답보다 먼저 와 버려진다(되살리기용으로 main 이 남긴다).
    const genTitle = prompt ? deriveGeneratedTabTitle(prompt) : null
    const tab: AgentTab = { sessionId: r.sessionId, agent, worktreeId, title: r.title, line: r.line, exited: false, ...(prompt?.trim() ? { prompt } : {}), ...(host ? { host } : {}), ...(vaultTitle?.trim() ? { vaultTitle } : {}), ...(genTitle ? { genTitle } : {}), ...(r.account !== undefined ? { account: r.account } : {}) }
    const chatOn = { ...get().chatOn, [r.sessionId]: get().settings?.agents[agent].view === 'chat' }
    writeChatOn(chatOn)
    set((s) => ({ tabs: [...s.tabs, tab], activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: r.sessionId }, chatOn }))
    watchExit(r.sessionId)
    return r
  },

  restartTab: async (sessionId) => {
    const old = get().tabs.find((x) => x.sessionId === sessionId)
    // 끝난 탭(셸까지 끝남) 또는 에이전트만 끝나고 셸이 남은 탭(main 화면 판정 agentExited — 그 셸은 닫는다).
    if (!old || !(old.exited || get().statusById[sessionId]?.agentExited)) return null
    const w = Object.values(useAiwsStore.getState().worktreesByRepo)
      .flat()
      .find((x) => x.id === old.worktreeId)
    if (!w) return t('aiws.agent.restart.noWorktree')
    const r = await get().launchAgent({ agent: old.agent, worktreeId: old.worktreeId, cwd: w.path, ...(old.vaultTitle ? { vaultTitle: old.vaultTitle } : {}) })
    if (!r.ok) return r.error
    // 새 탭(끝에 붙음)을 옛 탭 자리로 옮기고 옛 탭은 닫는다(셸이 남아 있으면 closeTab 이 끈다).
    set((s) => {
      const fresh = s.tabs.find((x) => x.sessionId === r.sessionId)
      return fresh ? { tabs: s.tabs.filter((x) => x !== fresh).flatMap((x) => (x.sessionId === sessionId ? [x, fresh] : [x])) } : {}
    })
    get().closeTab(sessionId)
    get().setActiveTab(old.worktreeId, r.sessionId)
    return null
  },

  setActiveTab: (worktreeId, sessionId) => set((s) => ({ activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: sessionId } })),

  reconnectHost: async (hostKey) => {
    const r = await window.ev.agents.reconnect(hostKey)
    if (!r.ok) return r.error
    const ids = new Set(r.tabs.map((x) => x.sessionId))
    // 있던 탭은 그 자리에서 되살리고(같은 id — 터미널은 붙은 채라 원격 replay 가 그대로 그려진다), 이 창이 모르던 세션은 새 탭으로.
    const known = get().tabs.filter((x) => ids.has(x.sessionId))
    // M8 R4 그 서버의 끊긴 탭 중 서버에 없는 것은 이미 끝났다 — '끊김'이 아니라 '종료'로.
    set((s) => ({ tabs: s.tabs.map((x) => (ids.has(x.sessionId) ? { ...x, exited: false, lost: false } : x.host === hostKey && x.lost ? { ...x, lost: false } : x)) }))
    known.forEach((x) => watchExit(x.sessionId))
    restoreTabs(r.tabs)
    return null
  },

  attachRemote: async (hostKey, sessionId) => {
    const go = (worktreeId: string): void => {
      useAiwsStore.getState().setActiveWorktree(worktreeId)
      get().setActiveTab(worktreeId, sessionId)
      get().setView('worktree')
    }
    const open = get().tabs.find((x) => x.sessionId === sessionId)
    if (open && !open.exited) {
      go(open.worktreeId)
      return null
    }
    await ensureAiwsLoaded() // F1 로 터미널 공간에서 왔으면 작업 단위 목록이 아직 없을 수 있다
    const r = await window.ev.agents.attachRemote(hostKey, sessionId)
    if (!r.ok) return r.error
    const tab = r.tabs[0]
    if (!tab) return t('servers.err.gone')
    const find = (): string | undefined =>
      Object.values(useAiwsStore.getState().worktreesByRepo)
        .flat()
        .find((w) => areWorktreePathsEqual(w.path, tab.cwd, 'other'))?.id
    // 다른 PC 가 만든 세션 — 이 PC 에 그 원격 저장소가 없으면 등록한다(탭은 작업 단위에 산다).
    if (!find()) {
      const p = await useAiwsStore.getState().addRemoteRepo(hostKey, tab.cwd)
      if (typeof p === 'string') return p
    }
    if (open) {
      set((s) => ({ tabs: s.tabs.map((x) => (x.sessionId === sessionId ? { ...x, exited: false, lost: false } : x)) }))
      watchExit(sessionId)
    } else restoreTabs(r.tabs)
    const w = find()
    if (w) go(w)
    return null
  },

  endRemote: async (sessionId) => {
    const tab = get().tabs.find((x) => x.sessionId === sessionId)
    if (!tab?.host) return
    await window.ev.agents.killRemote(tab.host, sessionId).catch(() => false)
    get().closeTab(sessionId)
  },

  closeTab: (sessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    // 원격 탭의 destroy = 이 PC 에서만 놓기(main RemoteBackend) — 서버 세션은 산다. 서버에서 끝내기는 endRemote.
    if (!tab.exited) void window.ev.session.destroy(sessionId)
    // R1 끊긴 원격 탭 — 이 PC 에서만 닫는다(다음에 켜도 되살리지 않게 저장 목록에서만 뺀다). M8 R4 의 "닫기 = 서버에서 끝내기"를 바꿨다.
    else if (tab.lost && tab.host) void window.ev.agents.forgetRemote(sessionId).catch(() => {})
    clearDraft(sessionId)
    const pending = pendingNotes.get(sessionId)
    if (pending) clearTimeout(pending.timer)
    pendingNotes.delete(sessionId)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.sessionId !== sessionId)
      const { [sessionId]: _st, ...statusById } = s.statusById
      const { [sessionId]: _seen, ...seenById } = s.seenById
      const { [sessionId]: _viewers, ...viewersById } = s.viewersById
      const { [sessionId]: _chat, ...chatOn } = s.chatOn
      writeChatOn(chatOn)
      const active = { ...s.activeTabByWorktree }
      if (active[tab.worktreeId] === sessionId) {
        const rest = tabs.filter((t) => t.worktreeId === tab.worktreeId)
        if (rest.length) active[tab.worktreeId] = rest[rest.length - 1].sessionId
        else delete active[tab.worktreeId]
      }
      return { tabs, activeTabByWorktree: active, statusById, seenById, viewersById, chatOn }
    })
  },

  // 탭을 보면 본 것(herdr: 그 칸으로 가면 seen = true).
  setViewing: (sessionId) => set((s) => ({ viewing: sessionId, ...(sessionId ? { seenById: { ...s.seenById, [sessionId]: true } } : {}) })),

  setView: (view) => set({ view }),

  toggleChat: (sessionId) =>
    set((s) => {
      const chatOn = { ...s.chatOn, [sessionId]: !s.chatOn[sessionId] }
      writeChatOn(chatOn)
      return { chatOn }
    })
}))

/** 그 에이전트 탭으로 — 워크트리를 고르고 그 탭을 고른 뒤 가운데를 탭 화면으로(대시보드 카드·피드·알림이 같은 길). */
export function revealAgent(sessionId: string): void {
  const tab = useAgentStore.getState().tabs.find((x) => x.sessionId === sessionId)
  if (!tab) return
  useAiwsStore.getState().setActiveWorktree(tab.worktreeId)
  useAgentStore.getState().setActiveTab(tab.worktreeId, sessionId)
  useAgentStore.getState().setView('worktree')
}

export { hostOfWorktree }

/** 워크트리 이름(카드·피드·알림 줄). 지워졌으면 id 그대로. */
export function worktreeName(worktreeId: string): string {
  return (
    Object.values(useAiwsStore.getState().worktreesByRepo)
      .flat()
      .find((w) => w.id === worktreeId)?.displayName ?? worktreeId
  )
}

/**
 * 알림은 잠깐 늦춘다 — 잠깐 막혔다가 스스로 이어 가는 CLI 가 자기 알림을 거둘 수 있게(옛 aiQuietWatch 의 1.5초 규칙 그대로).
 * 피드·보드는 즉시(그리는 것은 값이 싸다), 알림은 한 번 뜨면 사람이 치워야 한다.
 */
export const NOTE_DELAY_MS = 1_500
const pendingNotes = new Map<string, { kind: FeedKind; timer: ReturnType<typeof setTimeout> }>()

function sendAgentNote(sessionId: string, kind: FeedKind): void {
  const s = useAgentStore.getState()
  const tab = s.tabs.find((x) => x.sessionId === sessionId)
  // 늦추는 사이 그 탭을 열었으면 보낼 것이 없다.
  const nk = noteKindOf(kind, s.viewing === sessionId && typeof document !== 'undefined' && document.hasFocus(), agentNotesEnabled())
  if (!tab || !nk) return
  const title = t(`aiws.note.${kind}`).replace('{a}', AGENTS[tab.agent].label).replace('{w}', worktreeName(tab.worktreeId))
  const note = pushNote({ kind: nk, space: 'ai', target: { type: 'task', id: sessionId }, title, body: t(`aiws.note.${kind}.body`), go: () => revealAgent(sessionId) })
  // 앱이 뒤에 있을 때만 OS 알림(옛 aiQuietWatch 와 같은 방식 — 렌더러 Notification). 앞에 있으면 토스트·벨로 충분하다.
  if (typeof document === 'undefined' || document.hasFocus()) return
  try {
    // 앱 잠금 중에는 내용 없이(작업 이름·에이전트를 화면 밖으로 흘리지 않는다).
    const hide = isLockedNow()
    const n = new Notification(hide ? t('lock.notify.title') : title, { body: hide ? t('lock.notify.body') : note.body, tag: `ara-agent-${sessionId}-${kind}` })
    n.onclick = () => {
      window.focus()
      openNoteVia(note)
    }
  } catch {
    // 알림 권한이 없거나 OS 가 막았다 — 토스트·벨·맥박은 그대로.
  }
}

/** 상태가 바뀔 때 — 피드에 남기고 알림을 예약한다. 다른 종류로 바뀌면 걸린 예약은 거둔다(같은 종류의 도구 변화는 그대로 둔다). */
function onTransition(prev: AgentStatusView | undefined, next: AgentStatusView, viewingNow: boolean, now = Date.now()): void {
  const kind = feedKindOf(prev, next)
  const pending = pendingNotes.get(next.sessionId)
  if (pending && kind && pending.kind !== kind) {
    clearTimeout(pending.timer)
    pendingNotes.delete(next.sessionId)
  }
  if (!kind) return
  useAgentStore.setState((s) => ({ feed: [...s.feed, { id: ++feedSeq, at: now, sessionId: next.sessionId, kind, estimated: next.estimated }].slice(-FEED_CAP) }))
  if (!noteKindOf(kind, viewingNow, agentNotesEnabled())) return
  pendingNotes.set(next.sessionId, {
    kind,
    timer: setTimeout(() => {
      pendingNotes.delete(next.sessionId)
      sendAgentNote(next.sessionId, kind)
    }, NOTE_DELAY_MS)
  })
}
let feedSeq = 0

/** 탭의 세션이 끝나면 '종료' — 데몬이 죽어 잃었으면 '잃음'(M4 DM-01). */
function watchExit(sessionId: string): void {
  const off = window.ev.session.onExit(sessionId, (info) => {
    off()
    const lost = info.exitCode === AGENT_SESSION_LOST_EXIT
    useAgentStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, exited: true, ...(lost ? { lost: true } : {}) } : t)) }))
  })
}

/**
 * M4 DM-01: 데몬에서 되살린 탭을 올린다. 워크트리는 cwd 로 찾는다(id 는 repoId::path) — 목록이 아직 안 올라왔으면 올라올 때 다시.
 * M11 R2: cold 탭(데몬째 죽어 잃음)은 같은 에이전트·같은 폴더로 다시 띄운다(resume 이 있으면 재개). initial(켤 때 한 번)이면
 * 지난 레이아웃(탭 순서·고른 탭·고른 작업 단위)을 되살리고, 그 뒤로 바뀔 때마다 남긴다.
 * ponytail: 끝내 못 찾는 탭(워크트리를 지움)은 안 보인 채 구독이 남는다 — 세션은 데몬에 살아 [백그라운드 에이전트 모두 종료]로 끈다.
 */
function restoreTabs(list: AgentTabInfo[], initial = false): void {
  let pending = list.filter((x) => !useAgentStore.getState().tabs.some((t) => t.sessionId === x.sessionId))
  const layout = initial ? readTabLayout() : null
  const idMap = new Map<string, string>()
  const place = async (): Promise<boolean> => {
    const all = Object.values(useAiwsStore.getState().worktreesByRepo).flat()
    const found: AgentTab[] = []
    const cold: { info: AgentTabInfo; worktreeId: string; cwd: string }[] = []
    pending = pending.filter((x) => {
      const w = all.find((w) => areWorktreePathsEqual(w.path, x.cwd, /^[A-Za-z]:/.test(x.cwd) ? 'win32' : 'other'))
      if (w && x.cold) cold.push({ info: x, worktreeId: w.id, cwd: w.path })
      // M8 R4 cut = 앱을 다시 켰을 때의 원격 탭 — 붙지 않은 채 '끊김'으로(사람이 [다시 연결]).
      else if (w) found.push({ sessionId: x.sessionId, agent: x.agent, worktreeId: w.id, title: x.title, line: x.line, exited: !!x.cut, ...(x.cut ? { lost: true } : {}), ...(x.prompt ? { prompt: x.prompt } : {}), ...(x.name ? { name: x.name } : {}), ...(x.host ? { host: x.host } : {}), ...(x.genTitle ? { genTitle: x.genTitle } : {}), ...(x.account !== undefined ? { account: x.account } : {}) })
      return !w
    })
    if (found.length) {
      useAgentStore.setState((s) => ({
        tabs: [...s.tabs, ...found],
        activeTabByWorktree: { ...Object.fromEntries(found.map((t) => [t.worktreeId, t.sessionId])), ...s.activeTabByWorktree }
      }))
      found.filter((t) => !t.exited).forEach((t) => watchExit(t.sessionId))
    }
    // 한 번에 하나씩(띄우는 순서 = 기록 순서). 실패한 탭은 알림 한 줄 — 지난 세션 목록에서 이어 할 수 있다.
    let missed = 0
    for (const c of cold) {
      const r = await useAgentStore.getState().launchAgent({ agent: c.info.agent, worktreeId: c.worktreeId, cwd: c.cwd, ...(c.info.resume ? { resume: c.info.resume } : {}) })
      if (!r.ok) {
        missed += 1
        continue
      }
      idMap.set(c.info.sessionId, r.sessionId)
      const keep = { ...(c.info.name ? { name: c.info.name } : {}), ...(c.info.genTitle ? { genTitle: c.info.genTitle } : {}) }
      if (Object.keys(keep).length) useAgentStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.sessionId === r.sessionId ? { ...t, ...keep } : t)) }))
    }
    if (missed) pushNote({ kind: 'info', space: 'ai', title: t('aiws.restore.missed').replace('{n}', String(missed)), body: t('aiws.restore.missed.body') })
    if (layout && (found.length || cold.length)) applyLayout()
    return pending.length === 0
  }
  const applyLayout = (): void => {
    if (!layout) return
    useAgentStore.setState((s) => ({ tabs: orderTabs(s.tabs, layout, idMap), activeTabByWorktree: restoreActive(s.tabs, layout, idMap, s.activeTabByWorktree) }))
    const aiws = useAiwsStore.getState()
    const w = layout.worktree
    if (!aiws.activeWorktreeId && w && Object.values(aiws.worktreesByRepo).flat().some((x) => x.id === w)) aiws.setActiveWorktree(w)
  }
  // 자리 찾기가 겹치지 않게 줄 세운다(워크트리 목록이 바뀔 때마다 불린다 — cold 를 두 번 띄우지 않게).
  let running: Promise<boolean> = Promise.resolve(false)
  const run = (): Promise<boolean> => (running = running.then(place, () => false))
  void run().then((done) => {
    if (initial) saveLayoutFromNowOn(() => new Set(pending.map((x) => x.sessionId)))
    if (done) return
    const retry = (): void => void run().then((d) => d && unsub())
    const unsub = useAiwsStore.subscribe(retry)
    retry() // 첫 자리 찾기와 구독 사이에 목록이 올라왔을 수 있다
  })
}

/** 켤 때 되살리기 뒤부터 레이아웃이 바뀔 때마다 남긴다(그 전에 남기면 빈 탭 줄이 지난 레이아웃을 덮는다). */
function saveLayoutFromNowOn(pending: () => ReadonlySet<string>): void {
  let prev = readTabLayout()
  const save = (): void => {
    const a = useAgentStore.getState()
    prev = layoutOf(a.tabs, a.activeTabByWorktree, useAiwsStore.getState().activeWorktreeId, prev, pending())
    writeTabLayout(prev)
  }
  save()
  useAgentStore.subscribe((s, p) => {
    if (s.tabs !== p.tabs || s.activeTabByWorktree !== p.activeTabByWorktree) save()
  })
  useAiwsStore.subscribe((s, p) => {
    if (s.activeWorktreeId !== p.activeWorktreeId) save()
  })
}

let statusStarted = false
/** 상태 구독 — AI 작업 공간을 처음 열 때(피커가 감지를 부를 때) 한 번. 창이 늦게 떠도 지금까지의 상태를 받아 온다. */
function startStatus(): void {
  if (statusStarted) return
  statusStarted = true
  const apply = (v: AgentStatusView): void => {
    const s = useAgentStore.getState()
    const prev = s.statusById[v.sessionId]
    // 탭이 아직 안 올라왔어도(launch 응답보다 상태가 먼저) 상태는 담아 둔다 — 탭이 생기면 그대로 보인다.
    const viewingNow = s.viewing === v.sessionId && typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
    const seen = nextSeen(prev, v, s.seenById[v.sessionId] ?? true, viewingNow)
    useAgentStore.setState((x) => ({ statusById: { ...x.statusById, [v.sessionId]: v }, seenById: { ...x.seenById, [v.sessionId]: seen } }))
    onTransition(prev, v, viewingNow)
  }
  window.ev.agents.onStatus(apply)
  // M5 AI-19 — 이름이 정해지면 그 탭에(탭이 아직 없으면 버린다 — 되살릴 때 tabs() 가 다시 준다).
  window.ev.agents.onName((e) => useAgentStore.setState((s) => ({ tabs: s.tabs.map((x) => (x.sessionId === e.sessionId ? { ...x, name: e.name } : x)) })))
  // M11 첫 지시로 지은 제목 — 터미널에서 친 첫 요청(훅)·채팅 입력. 실행 지시의 것은 launchAgent 가 바로 붙인다.
  window.ev.agents.onTitle((e) => useAgentStore.setState((s) => ({ tabs: s.tabs.map((x) => (x.sessionId === e.sessionId ? { ...x, genTitle: e.title } : x)) })))
  // R1 원격 탭에 붙은 PC(이 PC 포함).
  window.ev.agents.onViewers((e) => useAgentStore.setState((s) => ({ viewersById: { ...s.viewersById, [e.sessionId]: e.viewers } })))
  // R3 원격 탭 한도(띠·카드).
  window.ev.agents.onRemoteLimit((e) => useAgentStore.setState((s) => ({ limitById: { ...s.limitById, [e.sessionId]: e.hit } })))
  // M4 DM-01: 앱을 다시 켰으면 데몬에 살아 있던 에이전트 탭을 되살린다.
  void window.ev.agents
    .tabs()
    .then((list) => restoreTabs(list, true))
    .catch(() => {})
  void window.ev.agents
    .statuses()
    .then((list) => list.forEach(apply))
    .catch(() => {})
}

/** 피커가 처음 고를 에이전트 — 기본 에이전트가 설치·켜짐이면 그것, 아니면 설치된 첫 것. */
export function pickInitialAgent(settings: AgentSettings | null, detected: DetectedAgent[] | null): AgentId | null {
  const usable = (detected ?? []).filter((d) => d.installed && settings?.agents[d.id].enabled !== false).map((d) => d.id)
  if (settings && usable.includes(settings.defaultAgent)) return settings.defaultAgent
  return usable[0] ?? null
}
