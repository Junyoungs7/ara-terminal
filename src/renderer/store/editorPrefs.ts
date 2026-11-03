// M12 R2 에디터 옵션의 렌더러 거울 — useUiPrefs(applyUiPrefs)가 넣고, AI 작업 공간 청크(CodeEditor·DiffView)가 읽는다.
// zustand 를 진입 청크에 끌어오지 않으려고 useSyncExternalStore 한 겹만.
import { useSyncExternalStore } from 'react'
import { DEFAULT_EDITOR_PREFS, type EditorPrefs } from '@shared/editorPrefs'

let cur: EditorPrefs = DEFAULT_EDITOR_PREFS
const subs = new Set<() => void>()

export function setEditorPrefs(p: EditorPrefs): void {
  if (p === cur) return
  cur = p
  for (const f of subs) f()
}
export const getEditorPrefs = (): EditorPrefs => cur
export function subscribeEditorPrefs(f: () => void): () => void {
  subs.add(f)
  return () => void subs.delete(f)
}
export const useEditorPrefs = (): EditorPrefs => useSyncExternalStore(subscribeEditorPrefs, getEditorPrefs)

// 3차 R2-B — AI 작업 공간 청크(에디터 확대 키)가 설정을 바꿀 길. useUiPrefs 가 저장까지 하는 update 를 걸어 둔다.
let writer: ((p: EditorPrefs) => void) | null = null
export function setEditorPrefsWriter(w: ((p: EditorPrefs) => void) | null): void {
  writer = w
}
export function updateEditorPrefs(patch: Partial<EditorPrefs>): void {
  const next = { ...cur, ...patch }
  if (writer) writer(next)
  else setEditorPrefs(next)
}
