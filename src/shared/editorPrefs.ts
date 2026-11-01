// M12 R2 에디터 옵션 — 설정 › 편집기. Orca shared/default-global-settings.ts(orcaRef fdfcfb3551)의 기본값 그대로:
// editorWordWrap true · editorMinimapEnabled false · editorFontFamily ''(= 터미널 글꼴을 따른다) · editorPreviewTabsEnabled true ·
// diffDefaultView 'inline'. 글자 크기는 Orca 처럼 터미널 글자 크기를 따른다(따로 칸 없음).
// workspace.json ui.codeEditor 에 둔다 — 렌더러 값은 신뢰 경계 밖이라 읽는 쪽이 editorPrefsOf 로 클램프한다.

export type DiffView = 'inline' | 'side-by-side'
export type EditorPrefs = {
  wordWrap: boolean
  minimap: boolean
  /** 비면 터미널 글꼴(--term)을 따른다(Orca resolveEditorFontFamily). */
  fontFamily: string
  /** 탐색기에서 한 번 누른 파일은 미리 보기 탭(기울임) — 다음 미리 보기가 그 자리를 갈아 끼운다. 고치거나 탭을 두 번 누르면 고정. */
  previewTabs: boolean
  /** 변경 비교를 열 때의 보기. 비교 탭 안의 [한 줄 | 나란히]는 그 탭에서만 바꾼다(Orca 와 같음). */
  diffView: DiffView
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = { wordWrap: true, minimap: false, fontFamily: '', previewTabs: true, diffView: 'inline' }
/** 글꼴 이름 상한 — CSS font-family 한 줄. */
const FONT_MAX = 200

export function editorPrefsOf(v: unknown): EditorPrefs {
  const o = v && typeof v === 'object' ? (v as Partial<Record<keyof EditorPrefs, unknown>>) : {}
  const d = DEFAULT_EDITOR_PREFS
  return {
    wordWrap: typeof o.wordWrap === 'boolean' ? o.wordWrap : d.wordWrap,
    minimap: typeof o.minimap === 'boolean' ? o.minimap : d.minimap,
    // 줄바꿈·제어 문자·중괄호(다른 CSS 규칙으로 새는 것)는 뺀다.
    fontFamily: typeof o.fontFamily === 'string' ? o.fontFamily.replace(/[\u0000-\u001f{};<>]/g, '').trim().slice(0, FONT_MAX) : d.fontFamily,
    previewTabs: typeof o.previewTabs === 'boolean' ? o.previewTabs : d.previewTabs,
    diffView: o.diffView === 'side-by-side' || o.diffView === 'inline' ? o.diffView : d.diffView
  }
}
