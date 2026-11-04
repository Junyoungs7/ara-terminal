// M6 WS-07 Monaco 준비 — Orca src/renderer/src/lib/monaco-setup.ts(orcaRef 7a7f46f8a3)의 1차 판.
// CodeEditor 청크만 이 파일을 import 한다 → **파일을 처음 열 때만** Monaco(수 MB)와 워커가 불린다.
//  · 워커: Vite 의 `?worker` 로 묶어 앱 안에서 띄운다(Orca 와 같은 갈래 — json·css·html·ts, 나머지는 편집기 기본 워커).
//  · CDN 금지: @monaco-editor/react 는 설정이 없으면 jsdelivr 에서 Monaco 를 받아 온다 — loader.config({ monaco }) 로
//    이 번들의 monaco 를 쓰게 한다(사내망·CSP script-src 'self'). 이 줄이 Editor 를 그리기 전에 돌아야 한다(모듈 맨 위).
//  · 테마: 아라 토큰(tokens.css 의 CSS 변수)을 읽어 만든다 — 색 리터럴을 여기 두지 않는다. 배경 밝기로 다크/라이트 바탕을 고른다.
// M12 R2 언어 하이라이트 확장(Orca runMonacoSetupSteps 의 언어 등록 — monarch 판만): Vue·Svelte·Astro·Glimmer(.gjs/.gts)·CUDA·JSONL·dotenv·Quarto·
// Markdown 의 bash 별칭. 3차 R2-B: Nim·Lean·Typst·Zig·Groovy·CMake(shiki·Oniguruma TextMate, 지연 로드). 뺀 것: Markdown 머리말 접기.
// 뺀 것(Orca): TS 워커 유휴 정지, 붙여넣기·diff 폐기 가드 — 필요해지면 그때.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import { nextEditorFontZoomLevel } from '@shared/editorPrefs'
import { getEditorPrefs, updateEditorPrefs } from '../../store/editorPrefs'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerVueLanguage } from './monacoLanguages/register-vue'
import { registerSvelteLanguage } from './monacoLanguages/register-svelte'
import { registerAstroLanguage } from './monacoLanguages/register-astro'
import { registerGlimmerLanguages } from './monacoLanguages/register-glimmer'
import { registerCudaLanguage } from './monacoLanguages/register-cuda'
import { registerJsonlLanguage } from './monacoLanguages/register-jsonl'
import { registerDotenvLanguage } from './monacoLanguages/register-dotenv'
import { registerQuartoLanguage } from './monacoLanguages/register-quarto'
import { registerShellMarkdownAliases } from './monacoLanguages/register-shell-markdown-aliases'
// 3차 R2-B shiki/TextMate 언어 6종(Orca) — 등록은 이름표만, 문법·shiki·Oniguruma WASM 은 그 언어 모델을 처음 토큰화할 때 불린다.
import { registerNimLanguage } from './monacoLanguages/register-nim'
import { registerTypstLanguage } from './monacoLanguages/register-typst'
import { registerLeanLanguage } from './monacoLanguages/register-lean'
import { registerZigLanguage } from './monacoLanguages/register-zig'
import { registerGroovyLanguage } from './monacoLanguages/register-groovy'
import { registerCMakeLanguage } from './monacoLanguages/register-cmake'

globalThis.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// 워크트리 밖 import 를 못 푸는 워커라 진단은 빨간 줄만 늘린다 — Orca 처럼 끄고 색칠·완성만 남긴다.
const quiet = { noSemanticValidation: true, noSuggestionDiagnostics: true, noSyntaxValidation: true }
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(quiet)
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(quiet)

// 하나가 실패해도 에디터는 뜨게(Orca monaco-setup-steps 와 같은 뜻).
for (const reg of [registerVueLanguage, registerSvelteLanguage, registerAstroLanguage, registerGlimmerLanguages, registerCudaLanguage, registerJsonlLanguage, registerDotenvLanguage, registerQuartoLanguage, registerShellMarkdownAliases, registerNimLanguage, registerTypstLanguage, registerLeanLanguage, registerZigLanguage, registerGroovyLanguage, registerCMakeLanguage]) {
  try {
    reg(monaco)
  } catch (e) {
    console.warn('[monaco] language registration failed', e)
  }
}

loader.config({ monaco })

/**
 * 3차 R2-B 에디터 글자 확대(Orca resolveZoomTarget — 포커스가 에디터면 Ctrl+=/−/0 이 앱이 아니라 에디터 글자를). 값은 설정에 남는다(다시 켜도 그대로).
 * 비교(DiffView)도 같은 값을 쓴다. 뺀 것: 마크다운 미리 보기·리치 편집 확대(Orca 는 같은 값으로 키운다).
 */
export function addZoomKeys(ed: { addCommand: (key: number, run: () => void) => unknown }): void {
  const zoom = (d: 'in' | 'out' | 'reset') => () => updateEditorPrefs({ fontZoom: nextEditorFontZoomLevel(getEditorPrefs().fontZoom, d) })
  const { CtrlCmd } = monaco.KeyMod
  const K = monaco.KeyCode
  ed.addCommand(CtrlCmd | K.Equal, zoom('in'))
  ed.addCommand(CtrlCmd | K.NumpadAdd, zoom('in'))
  ed.addCommand(CtrlCmd | K.Minus, zoom('out'))
  ed.addCommand(CtrlCmd | K.NumpadSubtract, zoom('out'))
  ed.addCommand(CtrlCmd | K.Digit0, zoom('reset'))
  ed.addCommand(CtrlCmd | K.Numpad0, zoom('reset'))
}


/** 아라 토큰 → Monaco 테마. Monaco 는 #rrggbb(aa) 만 받으므로 그 꼴이 아닌 값(rgba 등)은 건너뛴다. */
function defineAraTheme(): void {
  const css = getComputedStyle(document.documentElement)
  const hex = (name: string): string | null => {
    const v = css.getPropertyValue(name).trim()
    return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v) ? v : null
  }
  const bg = hex('--bg-terminal') ?? hex('--bg-canvas')
  const luma = bg ? 0.299 * parseInt(bg.slice(1, 3), 16) + 0.587 * parseInt(bg.slice(3, 5), 16) + 0.114 * parseInt(bg.slice(5, 7), 16) : 0
  const pairs: [string, string][] = [
    ['editor.background', '--bg-terminal'],
    ['editor.foreground', '--text-hi'],
    ['editorLineNumber.foreground', '--text-dim'],
    ['editorLineNumber.activeForeground', '--text-mid'],
    ['editor.lineHighlightBackground', '--bg-surface'],
    ['editorCursor.foreground', '--accent'],
    ['editorWidget.background', '--bg-raised'],
    ['editorWidget.border', '--line'],
    ['editorGutter.background', '--bg-terminal']
  ]
  const colors: Record<string, string> = {}
  for (const [key, token] of pairs) {
    const v = hex(token)
    if (v) colors[key] = v
  }
  // FB-2.2.4 D3 diff 본문 — vs-dark 기본 초록·빨강 대신 아라 신호색(--ok·--err)을 옅게. 양쪽 사이 경계는 --line. 개요 띠는 DiffView 가 끈다(C#26).
  const tint: [string, string, string][] = [
    ['diffEditor.insertedLineBackground', '--ok', '1a'],
    ['diffEditor.insertedTextBackground', '--ok', '33'],
    ['diffEditor.removedLineBackground', '--err', '1a'],
    ['diffEditor.removedTextBackground', '--err', '33'],
    ['diffEditor.diagonalFill', '--line', '80']
  ]
  for (const [key, token, alpha] of tint) {
    const v = hex(token)
    if (v && v.length === 7) colors[key] = v + alpha
  }
  const line = hex('--line')
  if (line) colors['diffEditor.border'] = line
  monaco.editor.defineTheme('ara', { base: luma > 128 ? 'vs' : 'vs-dark', inherit: true, rules: [], colors })
}
defineAraTheme()

export { monaco }
