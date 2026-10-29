// 2.0 앱 잠금 — 렌더러 쪽 상태 그릇. 주인은 main(AppLock)이고 여기는 `lock:state` 방송을 받아 들고만 있다.
// 모든 창이 main.tsx 에서 이 파일을 **가장 먼저** import 한다 — 아래 키 가드가 다른 어떤 리스너보다 먼저 걸려야 한다.
import { useSyncExternalStore } from 'react'
import { isLockedState, type LockView } from '@shared/lock'
import { matchBinding, setLockShortcut } from '@shared/keymap'

let view: LockView | null = null
const subs = new Set<() => void>()

function set(v: LockView): void {
  view = v
  setLockShortcut(v.shortcut)
  for (const fn of subs) fn()
}

export const lockView = (): LockView | null => view
export const isLockedNow = (): boolean => !!view && isLockedState(view.state)

export function subscribeLock(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export const useLockView = (): LockView | null => useSyncExternalStore(subscribeLock, lockView)

/** 덮개가 사는 자리(본문 #root 밖). 잠긴 동안 키 입력은 여기 안에서만 산다. */
export const LOCK_HOST_ID = 'lock-root'

/**
 * 첫 상태를 받아 온다. 실패하면(스모크 하네스처럼 lock:* 핸들러가 없는 main) null — 잠금 없음으로 다룬다.
 * **모르면 막지 않는다**가 아니라 "main 이 잠금을 모른다 = 잠금이 없다"이다: 잠금 상태의 주인은 main 이라
 * 렌더러가 추측해서 잠글 근거가 없다.
 */
export async function initLock(): Promise<LockView | null> {
  const api = window.ev?.lock
  if (!api) return null
  api.onState(set)
  try {
    const v = await api.get()
    set(v)
    return v
  } catch {
    return null
  }
}

/**
 * 잠긴 동안 키보드 가드 — **window 캡처 단계**에서 다른 모든 키 리스너(Shell·MainArea·RDP·편집기의 단축키)를
 * 막는다. 덮개 안 입력칸의 글자 입력·Enter 제출·Tab 이동은 기본 동작이라 그대로 된다.
 * (#root 는 inert 라 포커스·클릭이 이미 막혀 있다 — 이건 window 에 직접 건 단축키 리스너를 위한 것이다.)
 */
function guard(e: KeyboardEvent): void {
  if (!isLockedNow()) return
  e.stopImmediatePropagation()
  const host = document.getElementById(LOCK_HOST_ID)
  if (!(e.target instanceof Node) || !host?.contains(e.target)) e.preventDefault()
}
// window 가 없는 자리(노드 단위 시험이 이 파일을 간접 import 한다)에서는 걸지 않는다.
const hasWindow = typeof window !== 'undefined'
if (hasWindow) for (const type of ['keydown', 'keyup', 'keypress'] as const) window.addEventListener(type, guard, true)

/**
 * 통합 검색(F1)·메뉴의 "아라 잠그기"는 dispatchAction 이 만든 **합성 keydown** 으로 온다(실제 키는 main 이
 * before-input-event 로 먼저 잡아 여기까지 안 온다).
 */
if (hasWindow) {
  window.addEventListener('keydown', (e) => {
    if (!isLockedNow() && matchBinding(e, 'app.lock')) void window.ev?.lock?.lock()
  })
}
