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
  /** 3차 R2-B 자동 저장(Orca editorAutoSave — 기본 끔). 고친 뒤 autoSaveDelayMs 동안 더 안 치면 저장. */
  autoSave: boolean
  /** Orca editorAutoSaveDelayMs — 기본 1000, 250~10000. */
  autoSaveDelayMs: number
  /** 3차 R2-B 에디터 글자 확대(Orca editorFontZoomLevel — Ctrl+=/−/0, -6~18). 설정 칸은 없다(Orca 도 키만). */
  fontZoom: number
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = { wordWrap: true, minimap: false, fontFamily: '', previewTabs: true, diffView: 'inline', autoSave: false, autoSaveDelayMs: 1000, fontZoom: 0 }
/** Orca MIN/MAX_EDITOR_AUTO_SAVE_DELAY_MS(shared/constants.ts). */
export const AUTO_SAVE_DELAY_MIN = 250
export const AUTO_SAVE_DELAY_MAX = 10_000
/** Orca lib/editor-font-zoom.ts EDITOR_FONT_ZOOM_MIN/MAX. */
export const EDITOR_ZOOM_MIN = -6
export const EDITOR_ZOOM_MAX = 18
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d)
/** Orca normalizeAutoSaveDelayMs — 없거나 손으로 고친 값이 즉시 반복·지나친 기다림이 되지 않게. */
export const normalizeAutoSaveDelayMs = (v: unknown): number => Math.max(AUTO_SAVE_DELAY_MIN, Math.min(AUTO_SAVE_DELAY_MAX, num(v, 1000)))
/** Orca nextEditorFontZoomLevel — 한 칸씩, 0 으로 되돌리기. */
export function nextEditorFontZoomLevel(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 0
  return Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, current + (direction === 'in' ? 1 : -1)))
}
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
    diffView: o.diffView === 'side-by-side' || o.diffView === 'inline' ? o.diffView : d.diffView,
    autoSave: typeof o.autoSave === 'boolean' ? o.autoSave : d.autoSave,
    autoSaveDelayMs: normalizeAutoSaveDelayMs(o.autoSaveDelayMs),
    fontZoom: Math.round(Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, num(o.fontZoom, d.fontZoom))))
  }
}
