// M12 R2 에디터 옵션 → Monaco 옵션. Orca components/editor/MonacoEditor.tsx·file-editor-word-wrap-options.ts·lib/editor-font-zoom.ts
// (orcaRef fdfcfb3551): 글꼴은 설정값, 비면 터미널 글꼴 · 크기는 터미널 글자 크기(8~32) · 줄바꿈 on/off · 미니맵.
// 이 파일은 monaco 를 import 하지 않는다(옵션 객체만) — 에디터 청크가 부른다.
import type { EditorPrefs } from '@shared/editorPrefs'
import { getEditorPrefs } from '../../store/editorPrefs'

export function editorFont(css: CSSStyleDeclaration = getComputedStyle(document.documentElement), p: EditorPrefs = getEditorPrefs()): { fontFamily: string; fontSize?: number } {
  const size = parseFloat(css.getPropertyValue('--tt'))
  const fontFamily = p.fontFamily || css.getPropertyValue('--term').trim() || css.getPropertyValue('--mono').trim()
  return size > 0 ? { fontFamily, fontSize: Math.max(8, Math.min(32, size)) } : { fontFamily }
}

export function codeEditorOptions(p: EditorPrefs): { fontFamily: string; fontSize?: number; wordWrap: 'on' | 'off'; minimap: { enabled: boolean } } {
  return { ...editorFont(undefined, p), wordWrap: p.wordWrap ? 'on' : 'off', minimap: { enabled: p.minimap } }
}
