// M6 WS-07·08 — AI 작업 공간 가운데 **파일 탭**의 상태(zustand). Orca store/slices/editor.ts(orcaRef 7a7f46f8a3)의 1차 부분:
// 열린 파일 목록 · 작업 단위별 고른 파일 · 더러움 · 디스크 서명(baseline) · 밖에서 바뀜(충돌).
// 편집 중인 글 자체는 Monaco 모델이 든다(여기엔 마지막으로 디스크에서 읽은 글만) — 그래서 저장·모델 정리는 에디터 청크가
// editorOps 로 걸어 둔다(이 파일은 monaco 를 import 하지 않는다 — 파일을 안 열면 Monaco 청크가 안 불린다).
import { create } from 'zustand'
import { isMac } from '@shared/keymap'
import { isInsidePath, onDiskChange } from '@shared/codeFiles'
import { areWorktreePathsEqual, type Worktree } from '@shared/worktrees'
import { QUICK_OPEN_RECENT_LIMIT } from '@shared/codeSearch'
import { hostOfWorktree, useAiwsStore } from './store'
import { t } from '../../i18n'

export type CodeFile = {
  path: string
  worktreeId: string
  /** 워크트리 폴더 — main 은 이 안의 경로만 받는다. */
  root: string
  /** M8 R5 원격 작업 단위의 서버(hostKey) — 읽기·쓰기·감시를 main 이 SSH 로 한다. 없으면 이 PC. */
  host?: string
  /** 마지막으로 디스크에서 읽은(또는 저장한) 글. 다시 읽으면 loadSeq 가 오른다 → 에디터가 모델에 넣는다. */
  text: string
  eol: 'lf' | 'crlf'
  sig: string
  bytes: number
  /** 상한(CODE_READONLY_BYTES)을 넘어 앞부분만 연 파일. */
  readOnly: boolean
  dirty: boolean
  /** 밖에서 바뀜(더러울 때) · 지워짐. 내 것 유지를 골라도 남는다 — 저장 때 덮어쓸지 묻는 근거는 main 의 서명 비교다. */
  conflict: 'changed' | 'missing' | null
  loadSeq: number
  /** 열 때 가리킬 줄(1부터). seq 가 바뀌면 에디터가 그 줄로 간다. */
  reveal: { line: number; seq: number } | null
}

/** 에디터 청크가 걸어 두는 손잡이 — 모델의 지금 글로 저장, 탭을 닫을 때 모델 정리. 에디터가 아직 안 떴으면 null. */
export type EditorOps = { save: (path: string) => Promise<boolean>; dispose: (path: string) => void }

type CodeState = {
  files: CodeFile[]
  /** 작업 단위별 가운데에 보이는 파일. null·없음 = 에이전트 탭이 보인다. */
  activeByWorktree: Record<string, string | null>
  editorOps: EditorOps | null
  /** 작업 단위별 최근 연 파일(워크트리 기준 '/' 경로, 최근 것이 앞) — 빠른 열기(Ctrl+P)가 먼저 보인다. 재시작하면 비어 있다. */
  recentByWorktree: Record<string, string[]>
  setActive: (worktreeId: string, path: string | null) => void
  setDirty: (path: string, dirty: boolean) => void
  /** 저장·다시 읽기 뒤 — 새 기준(서명·글). */
  markSaved: (path: string, sig: string, text: string, dirty: boolean) => void
  setConflict: (path: string, conflict: CodeFile['conflict']) => void
  /** 디스크 것 받기 — 다시 읽어 모델을 바꾼다(더러움·충돌 지움). */
  reloadFromDisk: (path: string) => Promise<void>
  closeFile: (path: string) => void
}

export const PLATFORM = isMac() ? 'darwin' : typeof navigator !== 'undefined' && /Win/i.test(navigator.platform) ? 'win32' : 'linux'
// 원격 경로('/…')는 Windows 에서도 POSIX 로 견준다(대소문자를 가른다).
const same = (a: string, b: string): boolean => areWorktreePathsEqual(a, b, PLATFORM === 'win32' && a.startsWith('/') ? 'linux' : PLATFORM)
const patch = (path: string, p: Partial<CodeFile>) => (s: CodeState) => ({ files: s.files.map((f) => (same(f.path, path) ? { ...f, ...p } : f)) })

export const useCodeStore = create<CodeState>()((set, get) => ({
  files: [],
  activeByWorktree: {},
  editorOps: null,
  recentByWorktree: {},
  setActive: (worktreeId, path) => set((s) => ({ activeByWorktree: { ...s.activeByWorktree, [worktreeId]: path } })),
  setDirty: (path, dirty) => {
    if (get().files.find((f) => same(f.path, path))?.dirty !== dirty) set(patch(path, { dirty }))
  },
  markSaved: (path, sig, text, dirty) => set(patch(path, { sig, text, dirty, conflict: null })),
  setConflict: (path, conflict) => set(patch(path, { conflict })),
  reloadFromDisk: async (path) => {
    const f = get().files.find((x) => same(x.path, path))
    if (!f) return
    const r = await window.ev.code.read(f.root, f.path, f.host)
    if (!r.ok) return set(patch(path, { conflict: r.missing ? 'missing' : f.conflict }))
    set(patch(path, { text: r.text, eol: r.eol, sig: r.sig, bytes: r.bytes, readOnly: r.readOnly, dirty: false, conflict: null, loadSeq: f.loadSeq + 1 }))
  },
  closeFile: (path) => {
    const f = get().files.find((x) => same(x.path, path))
    if (!f) return
    void window.ev.code.unwatch(f.path, f.host)
    get().editorOps?.dispose(f.path)
    set((s) => {
      const files = s.files.filter((x) => x !== f)
      const active = s.activeByWorktree[f.worktreeId]
      // 닫은 것이 보이던 파일이면 같은 작업 단위의 마지막 파일로, 없으면 에이전트 탭으로.
      const next = active && same(active, f.path) ? ([...files].reverse().find((x) => x.worktreeId === f.worktreeId)?.path ?? null) : (active ?? null)
      return { files, activeByWorktree: { ...s.activeByWorktree, [f.worktreeId]: next } }
    })
  }
}))

function activeWorktree(): Worktree | undefined {
  const s = useAiwsStore.getState()
  return s.activeWorktreeId ? Object.values(s.worktreesByRepo).flat().find((w) => w.id === s.activeWorktreeId) : undefined
}

/**
 * **파일 열기 API**(M6 R1 — R2 의 Ctrl+P·전체 검색이 이것을 부른다). 지금 고른 작업 단위에서 연다.
 * path = 절대 경로 또는 워크트리 기준 상대 경로(/·\ 둘 다). line = 1부터, 주면 그 줄로 간다.
 * 이미 열려 있으면 그 탭을 고르고(줄 이동만), 아니면 디스크에서 읽어 탭을 하나 더한다. 실패하면 사람이 읽을 이유(message — 그대로 보여 주면 된다).
 */
export async function openFile(path: string, line?: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const wt = activeWorktree()
  if (!wt) return { ok: false, message: t('code.err.noWorktree') }
  // M8 R5 원격 작업 단위 — 서버 경로(POSIX)로 열고, 읽기·쓰기·감시는 main 이 SSH 로(host). 빠른 열기·검색·링크가 모두 이 길을 지난다.
  const host = hostOfWorktree(wt.id)
  const platform = host ? 'linux' : PLATFORM
  const abs = /^([a-zA-Z]:)?[\\/]/.test(path) ? path : `${wt.path.replace(/[\\/]+$/, '')}/${path}`.replace(/\//g, platform === 'win32' ? '\\' : '/')
  if (!isInsidePath(wt.path, abs, platform)) return { ok: false, message: t('code.err.outside') }
  const s = useCodeStore.getState()
  const reveal = line && line > 0 ? { line, seq: Date.now() } : null
  const rel = abs.slice(wt.path.replace(/[\\/]+$/, '').length).replace(/\\/g, '/').replace(/^\/+/, '')
  const remember = (): void =>
    useCodeStore.setState((x) => ({
      recentByWorktree: { ...x.recentByWorktree, [wt.id]: [rel, ...(x.recentByWorktree[wt.id] ?? []).filter((p) => p !== rel)].slice(0, QUICK_OPEN_RECENT_LIMIT) }
    }))
  const open = s.files.find((f) => same(f.path, abs))
  if (open) {
    useCodeStore.setState(patch(abs, reveal ? { reveal } : {}))
    s.setActive(open.worktreeId, open.path)
    remember()
    return { ok: true }
  }
  const r = await window.ev.code.read(wt.path, abs, host)
  if (!r.ok) return { ok: false, message: r.message }
  // 읽는 사이 같은 파일을 또 열었으면(연타) 하나만.
  if (!useCodeStore.getState().files.some((f) => same(f.path, abs))) {
    const file: CodeFile = { path: abs, worktreeId: wt.id, root: wt.path, ...(host ? { host } : {}), text: r.text, eol: r.eol, sig: r.sig, bytes: r.bytes, readOnly: r.readOnly, dirty: false, conflict: null, loadSeq: 0, reveal }
    useCodeStore.setState((x) => ({ files: [...x.files, file] }))
    void window.ev.code.watch(wt.path, abs, host)
    startWatch()
  }
  useCodeStore.getState().setActive(wt.id, abs)
  remember()
  return { ok: true }
}

let watchStarted = false
/** 밖에서 바뀜(WS-08) — 더럽지 않으면 조용히 다시 읽고, 더러우면 충돌 안내, 지워졌으면 지워짐 안내. */
function startWatch(): void {
  if (watchStarted) return
  watchStarted = true
  window.ev.code.onChanged(async ({ path }) => {
    const f = useCodeStore.getState().files.find((x) => same(x.path, path))
    if (!f) return
    const r = await window.ev.code.read(f.root, f.path, f.host)
    if (!r.ok && !r.missing) return
    // 읽는 사이 더러워졌을 수 있다 — 판정은 지금 상태로.
    const now = useCodeStore.getState().files.find((x) => same(x.path, path))
    if (!now) return
    const act = onDiskChange(now, r.ok ? r.sig : null)
    // 지워졌다가 같은 내용으로 돌아왔으면 안내를 거둔다.
    if (act === 'ignore' && now.conflict === 'missing') useCodeStore.getState().setConflict(path, null)
    else if (act === 'missing') useCodeStore.getState().setConflict(path, 'missing')
    else if (act === 'conflict') useCodeStore.getState().setConflict(path, 'changed')
    else if (act === 'reload' && r.ok) useCodeStore.setState(patch(path, { text: r.text, eol: r.eol, sig: r.sig, bytes: r.bytes, readOnly: r.readOnly, conflict: null, loadSeq: now.loadSeq + 1 }))
  })
}
