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
