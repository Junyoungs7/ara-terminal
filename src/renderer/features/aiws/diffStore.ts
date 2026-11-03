// M7 R1 WS-10·11 — AI 작업 공간 가운데 **"변경 비교 · n" 탭**과 diff 줄 주석의 상태(zustand). monaco 를 import 하지 않는다
// (diff 를 안 열면 Monaco 청크가 안 불린다 — 그림은 DiffView 청크). Orca store/slices/diffComments·editor-open-diff
// (orcaRef fdfcfb3551)의 1차 판. 공유 API(openDiff·창 이벤트)는 agent_talk/m7-shared-api.md.
import { create } from 'zustand'
import type { DiffMode, GitBranchCompareResult, GitStatusResult } from '@shared/gitDiff'
import { formatDiffComments, markSent, parseStoredComments, type DiffComment } from '@shared/diffComments'
import type { Worktree } from '@shared/worktrees'
import { hostOfWorktree, useAiwsStore } from './store'
import { useAgentStore } from './agentStore'
import { useCodeStore } from './codeStore'
import { t } from '../../i18n'
import { getEditorPrefs, subscribeEditorPrefs } from '../../store/editorPrefs'

/** 목록 갈래 — 작업 중 변경(status) / 분기 기준 대비(branchCompare). */
export type DiffList = 'working' | 'branch'
export type DiffSel = { path: string; oldPath?: string; mode: DiffMode }
/** conflicts(3차 R2-B 충돌 검토 — Orca EditorConflictReviewSurface 의 목록) = 작업 중 목록에서 충돌 파일만. */
export type WorktreeDiff = { list: DiffList; selected: DiffSel | null; working: GitStatusResult | null; branch: GitBranchCompareResult | null; loading: boolean; conflicts?: boolean }

// 주석은 이 PC 의 localStorage 에 작업 단위 **폴더 경로**로 둔다 — 앱을 다시 켜도 남는다(Orca 는 orca-data.json 의 worktree meta).
// ponytail: 창 하나·쓰기 한 곳이라 Orca 의 쓰기 줄 세우기·되돌리기는 뺐다. 여러 창이 같은 주석을 고치게 되면 main 저장으로 옮긴다.
const COMMENTS_KEY = 'aiws.diffComments'

function loadComments(): Record<string, DiffComment[]> {
  try {
    return parseStoredComments(JSON.parse(localStorage.getItem(COMMENTS_KEY) ?? 'null'))
  } catch {
    return {}
  }
}
function saveComments(all: Record<string, DiffComment[]>): void {
  try {
    localStorage.setItem(COMMENTS_KEY, JSON.stringify(all))
  } catch {
    // 저장 못 해도 이번 창에서는 그대로 쓴다
  }
}

type DiffState = {
  byWorktree: Record<string, WorktreeDiff>
  /** 작업 단위별 가운데에 diff 탭이 보이는가. */
  shownByWorktree: Record<string, boolean>
  /** 한 줄 보기(true) / 나란히(false). 이 PC 의 보기 설정. */
  inline: boolean
  /** 작업 단위 폴더 경로 → 주석. */
  comments: Record<string, DiffComment[]>
  setShown: (worktreeId: string, shown: boolean) => void
  close: (worktreeId: string) => void
  setList: (wt: Worktree, list: DiffList) => void
  select: (worktreeId: string, sel: DiffSel) => void
  setInline: (inline: boolean) => void
  /** 3차 R2-B 충돌만 보기 켜고 끄기. */
  setConflicts: (worktreeId: string, on: boolean) => void
  /** 목록 다시 읽기(지금 갈래만). */
  refresh: (wt: Worktree) => Promise<void>
  addComment: (wtPath: string, c: Omit<DiffComment, 'id' | 'createdAt'>) => void
  /** 고치면 보냄 표시를 지운다(Orca). */
  editComment: (wtPath: string, id: string, body: string) => void
  deleteComment: (wtPath: string, id: string) => void
}

const empty = (): WorktreeDiff => ({ list: 'working', selected: null, working: null, branch: null, loading: false })

export const useDiffStore = create<DiffState>()((set, get) => {
  const putComments = (wtPath: string, f: (list: DiffComment[]) => DiffComment[]): void => {
    const comments = { ...get().comments, [wtPath]: f(get().comments[wtPath] ?? []) }
    if (comments[wtPath].length === 0) delete comments[wtPath]
    set({ comments })
    saveComments(comments)
  }
  const patchWt = (id: string, p: Partial<WorktreeDiff>): void => set((s) => ({ byWorktree: { ...s.byWorktree, [id]: { ...(s.byWorktree[id] ?? empty()), ...p } } }))
  return {
    byWorktree: {},
    shownByWorktree: {},
    // M12 R2: 처음 보기 = 설정 › 편집기 [변경 보기](Orca diffDefaultView, 기본 한 줄). 탭 안의 [한 줄 | 나란히]는 이번 실행에서만.
    inline: getEditorPrefs().diffView === 'inline',
    comments: loadComments(),
    setConflicts: (id, on) => patchWt(id, { conflicts: on }),
    setShown: (id, shown) => set((s) => ({ shownByWorktree: { ...s.shownByWorktree, [id]: shown } })),
    close: (id) =>
      set((s) => {
        const byWorktree = { ...s.byWorktree }
        delete byWorktree[id]
        return { byWorktree, shownByWorktree: { ...s.shownByWorktree, [id]: false } }
      }),
    setList: (wt, list) => {
      patchWt(wt.id, { list, selected: null, conflicts: false })
      void get().refresh(wt)
    },
    select: (id, sel) => patchWt(id, { selected: sel }),
    setInline: (inline) => set({ inline }),
    refresh: async (wt) => {
      const list = (get().byWorktree[wt.id] ?? empty()).list
      patchWt(wt.id, { loading: true })
      // M8 R5 원격 작업 단위 — 같은 조회를 그 서버의 git 으로(host).
      const host = hostOfWorktree(wt.id)
      if (list === 'working') patchWt(wt.id, { working: await window.ev.gitInspect.status(wt.path, host), loading: false })
      else patchWt(wt.id, { branch: await window.ev.gitInspect.branchCompare(wt.path, undefined, host), loading: false })
    },
    addComment: (wtPath, c) => putComments(wtPath, (l) => [...l, { ...c, id: crypto.randomUUID(), createdAt: Date.now() }]),
    editComment: (wtPath, id, body) =>
      putComments(wtPath, (l) =>
        l.map((c) => {
          if (c.id !== id) return c
          const { sentAt: _sent, ...rest } = c
          return { ...rest, body, updatedAt: Date.now() }
        })
      ),
    deleteComment: (wtPath, id) => putComments(wtPath, (l) => l.filter((c) => c.id !== id))
  }
})

/** 탭 이름의 n — 작업 중이면 파일 수(같은 파일 staged·unstaged 는 하나로), 분기면 바뀐 파일 수. 아직 안 읽었으면 null. */
export function changeCount(d: WorktreeDiff | undefined): number | null {
  if (!d) return null
  if (d.list === 'working') return d.working?.ok ? new Set(d.working.entries.map((e) => e.path)).size : null
  return d.branch?.ok ? d.branch.entries.length : null
}

function findWorktree(id?: string): Worktree | undefined {
  const s = useAiwsStore.getState()
  const want = id ?? s.activeWorktreeId
  return want ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === want) : undefined
}

/**
 * **diff 탭 열기 API**(R2 소스 제어 패널이 부른다 — 진입 청크에서는 창 이벤트 OPEN_DIFF_EVENT). filePath = 워크트리 기준 '/' 경로
 * (GitStatusEntry.path 그대로), 없으면 목록만. mode 가 branch 면 분기 갈래로. 열면 가운데를 diff 탭으로 바꾼다.
 */
export function openDiff(filePath?: string, mode: DiffMode = 'unstaged', worktreeId?: string): boolean {
  const wt = findWorktree(worktreeId)
  if (!wt) return false
  const s = useDiffStore.getState()
  const cur = s.byWorktree[wt.id]
  const list: DiffList = mode === 'branch' ? 'branch' : 'working'
  const fresh = !cur || cur.list !== list
  useDiffStore.setState((x) => ({
    byWorktree: { ...x.byWorktree, [wt.id]: { ...(cur ?? empty()), list, selected: filePath ? { path: filePath, mode } : fresh ? null : (cur?.selected ?? null) } },
    shownByWorktree: { ...x.shownByWorktree, [wt.id]: true }
  }))
  // 파일 탭이 보이고 있었으면 내린다(diff 탭이 위).
  useCodeStore.getState().setActive(wt.id, null)
  void useDiffStore.getState().refresh(wt)
  return true
}

/** 3차 R2-B 충돌 검토 목록(Orca openConflictReview) — 변경 비교 탭을 작업 중 목록·충돌만 보기로 연다. */
export function openConflictReview(worktreeId?: string): boolean {
  const wt = findWorktree(worktreeId)
  if (!wt || !openDiff(undefined, 'unstaged', wt.id)) return false
  useDiffStore.getState().setConflicts(wt.id, true)
  return true
}

/**
 * 안 보낸 주석을 모아 **그 작업 단위의 에이전트 탭**에 보낸다(Orca "Send to agent" — submit-after-ready).
 * 길은 M3·M5 의 안전한 입력(agents:chatSend → 입력 상자가 뜬 뒤 괄호 붙여넣기 → Enter). 셸에 치지 않는다.
 * 대상 = 그 작업 단위에서 지금 고른 탭, 없으면 살아 있는 마지막 탭. 보내면 sentAt 을 찍고 그 탭으로 옮긴다.
 */
export async function sendCommentsToAgent(wt: Worktree, filePath?: string): Promise<{ ok: true; sent: number } | { ok: false; message: string }> {
  const all = useDiffStore.getState().comments[wt.path] ?? []
  const unsent = all.filter((c) => !c.sentAt && (!filePath || c.filePath === filePath))
  if (unsent.length === 0) return { ok: false, message: t('diff.send.none') }
  const ag = useAgentStore.getState()
  const live = ag.tabs.filter((x) => x.worktreeId === wt.id && !x.exited && !x.lost)
  const tab = live.find((x) => x.sessionId === ag.activeTabByWorktree[wt.id]) ?? live[live.length - 1]
  if (!tab) return { ok: false, message: t('diff.send.noAgent') }
  const r = await window.ev.agents.chatSend(tab.sessionId, tab.agent, formatDiffComments(unsent))
  if (!r.ok) return { ok: false, message: t('diff.send.failed') }
  const comments = { ...useDiffStore.getState().comments }
  comments[wt.path] = markSent(comments[wt.path] ?? [], unsent, Date.now())
  useDiffStore.setState({ comments })
  saveComments(comments)
  useDiffStore.getState().setShown(wt.id, false)
  ag.setActiveTab(wt.id, tab.sessionId)
  return { ok: true, sent: unsent.length }
}

// 설정 › 편집기 [변경 보기]를 바꾸면 열린 비교도 그 보기로(설정이 기준 — Orca 는 새 비교 탭부터지만 아라는 비교 탭이 하나다).
let lastDiffView = getEditorPrefs().diffView
subscribeEditorPrefs(() => {
  const v = getEditorPrefs().diffView
  if (v === lastDiffView) return
  lastDiffView = v
  useDiffStore.getState().setInline(v === 'inline')
})
