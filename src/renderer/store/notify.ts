import { useSyncExternalStore } from 'react'
import type { Space } from '@shared/space'

/**
 * M1 라운드 3 알림 센터 — **렌더러 알림 저장소 하나**(시안 SW-final · orca-bundle-decisions 알림 절).
 *
 * 토스트(오른쪽 아래)·벨(안 읽음 점·드롭다운)·공간 스위치 맥박 점이 전부 이 목록 하나를 읽는다.
 * 각자 세면 두 벌로 갈린다(agentStatus.ts 와 같은 모양 — 모듈 스코프 + 구독).
 *
 * 무엇이 여기로 오나(나머지 짧은 안내는 그대로 MainArea 의 pane-toast):
 *  · 사람이 **나중에 돌아와 볼 일** — 손댈 일(wait), 끝남(done), 깨짐(error), 알릴 것(info).
 *  · 방금 한 동작의 즉답("복사했습니다", "칸이 꽉 찼습니다")은 오지 않는다 — 보고 있는 사람에게 한 말이다.
 * 숫자는 없다(결정): 벨은 안 읽음 **점**, 공간 버튼은 **맥박 점**.
 */
export type NoteKind = 'done' | 'error' | 'wait' | 'info'
/** 누르면 갈 자리 — 세션은 지금 있다. 작업(task)은 AI 작업 공간이 들어오는 M3 의 자리. */
export type NoteTarget = { type: 'session' | 'task'; id: string }
export type Note = {
  id: number
  kind: NoteKind
  /** 출처 공간 — 누르면 이 공간으로 간다. */
  space: Space
  target?: NoteTarget
  title: string
  body?: string
  /** 공간 · 대상 줄(서버 · 경로 같은 것). */
  ctx?: string
  at: number
  read: boolean
  /** 그 공간을 본 뒤인가 — 맥박은 아직 안 본 공간의 wait 에만(가면 꺼진다). */
  seen: boolean
  /** 토스트로 떠 있나(닫거나 수명이 다하면 false — 목록에는 남는다). */
  toast: boolean
  /** 공간을 옮긴 뒤 그 안에서 갈 자리(M3 에이전트 탭 — AI 작업 공간 청크가 건다. Shell 은 그 상태를 모른다). */
  go?: () => void
}
export type NoteInput = Pick<Note, 'kind' | 'space' | 'title'> & Partial<Pick<Note, 'target' | 'body' | 'ctx' | 'go'>>

/** 토스트는 한 번에 셋까지 — 넘치면 "+n" 알약(결정). */
export const TOAST_MAX = 3
/** 토스트 수명(ms) — 시안 값. 손댈 일이 가장 오래 남는다. */
export const TOAST_LIFE: Record<NoteKind, number> = { done: 5000, info: 5000, error: 8000, wait: 9000 }
/** 목록 상한 — 오래된 것부터 버린다. ponytail: 고정 상한, 영속·지우기가 붙으면(2차) 다시 본다. */
export const NOTE_CAP = 50

type State = { notes: Note[]; space: Space }
let state: State = { notes: [], space: 'term' }
let seq = 0
let toastsOn = true
const listeners = new Set<() => void>()

function set(notes: Note[], space = state.space): void {
  state = { notes, space }
  listeners.forEach((f) => f())
}
const patch = (pred: (n: Note) => boolean, p: Partial<Note>): void => {
  if (!state.notes.some((n) => pred(n) && Object.entries(p).some(([k, v]) => n[k as keyof Note] !== v))) return
  set(state.notes.map((n) => (pred(n) ? { ...n, ...p } : n)))
}

/** 새 알림(최신이 앞). 지금 보는 공간에서 난 것은 이미 "본" 것이라 맥박을 켜지 않는다. */
export function pushNote(input: NoteInput, now = Date.now()): Note {
  const n: Note = { ...input, id: ++seq, at: now, read: false, seen: input.space === state.space, toast: toastsOn }
  set([n, ...state.notes].slice(0, NOTE_CAP))
  return n
}
export const readNote = (id: number): void => patch((n) => n.id === id, { read: true, toast: false })
export const readAllNotes = (): void => patch(() => true, { read: true })
export const dismissToast = (id: number): void => patch((n) => n.id === id, { toast: false })

/** 지금 보는 공간 — 그 공간의 알림은 "본" 것이 되어 맥박이 꺼진다. */
export function setNoteSpace(space: Space): void {
  if (state.space !== space) set(state.notes, space)
  patch((n) => n.space === space, { seen: true })
}

/** 설정 › 알림 [에이전트 알림](M3) — 끄면 에이전트 끝남·기다림·오류를 보내지 않는다(맥박도 없다). uiPrefs 가 건다. */
let agentNotesOn = true
export function setAgentNotesEnabled(on: boolean): void {
  agentNotesOn = on
}
export const agentNotesEnabled = (): boolean => agentNotesOn

/** 알림을 눌렀을 때의 이동(공간·세션 + go) — 화면(NotifyToasts)이 건다. OS 알림을 누를 때도 같은 길. */
let opener: ((n: Note) => void) | null = null
export function setNoteOpener(fn: ((n: Note) => void) | null): void {
  opener = fn
}
export const openNoteVia = (n: Note): void => opener?.(n)

/** 설정 › 알림 [앱 안 토스트] · 실험 기능. 끄면 떠 있던 토스트도 걷는다(목록·벨은 그대로). */
export function setToastsEnabled(on: boolean): void {
  toastsOn = on
  if (!on) patch(() => true, { toast: false })
}

// ── 판정(순수) — 화면과 단위 시험이 같은 함수를 쓴다 ──
/** 보일 토스트(오래된 → 최신, 최신이 아래)와 넘친 수. 숨은 것은 보일 때 수명이 시작된다(그때 그려진다). */
export function toastView(notes: readonly Note[]): { shown: Note[]; more: number } {
  const live = notes.filter((n) => n.toast).reverse()
  const more = Math.max(0, live.length - TOAST_MAX)
  return { shown: live.slice(more), more }
}
export const hasUnread = (notes: readonly Note[]): boolean => notes.some((n) => !n.read)
/** 맥박 — **지금 없는 공간**에 안 읽고 안 본 wait 가 있을 때만. 끝남·오류는 켜지 않는다(결정: "기다림"만). */
export function attention(notes: readonly Note[], current: Space): Partial<Record<Space, boolean>> {
  const out: Partial<Record<Space, boolean>> = {}
  for (const n of notes) if (n.kind === 'wait' && !n.read && !n.seen && n.space !== current) out[n.space] = true
  return out
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
export const notesNow = (): State => state
export const useNotes = (): State => useSyncExternalStore(subscribe, notesNow)

/** 단위 시험용 — 모듈 상태를 비운다. */
export function resetNotes(): void {
  seq = 0
  toastsOn = true
  agentNotesOn = true
  set([], 'term')
}

/**
 * 시험 훅 — `window.__araTestNotify({ kind, space, title, ... })`. 배포본에는 없다: main 이 `!isPackaged && ARA_E2E=1`
 * 일 때만 `--ara-test-hooks` 를 넘긴다(testCrash.ts 와 같은 문). AI 쪽 wait 신호가 들어오는 M3 전까지 e2e 가 맥박을 만드는 길.
 */
export function installTestNotify(enabled: boolean | undefined, win: object = window): void {
  if (enabled) (win as { __araTestNotify?: (n: NoteInput) => number }).__araTestNotify = (n) => pushNote(n).id
}
