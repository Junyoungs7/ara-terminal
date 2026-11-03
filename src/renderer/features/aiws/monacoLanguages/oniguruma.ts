// 3차 R2-B shiki/TextMate 언어 6종 — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/syntax-highlighting/oniguruma.ts.
// 바꾼 점 하나: Orca 는 `?url` 로 WASM 을 fetch 한다. 아라 설치본은 렌더러를 file:// 로 띄우고 Chromium fetch 는 file: 을 못 읽는다 →
// `?url&inline`(data: URL — Vite 8/rolldown 은 .wasm?inline 을 파일 이름으로 읽어 렌더러 빌드가 깨진다, CSP connect-src 에 data: 있음, script-src 에 'wasm-unsafe-eval' 있음). 이 모듈은 Nim·Typst 등 그 언어 파일을 열 때만 불린다.
import type * as OnigurumaModule from 'vscode-oniguruma'
import onigurumaWasmUrl from 'vscode-oniguruma/release/onig.wasm?url&inline'

export type Oniguruma = typeof OnigurumaModule

let onigurumaPromise: Promise<Oniguruma> | undefined

/** The renderer's one Oniguruma WASM instance, shared by every TextMate tokenizer. */
export function loadOniguruma(): Promise<Oniguruma> {
  onigurumaPromise ??= (async () => {
    const oniguruma = await import('vscode-oniguruma')
    const response = await fetch(onigurumaWasmUrl)
    if (!response.ok) {
      throw new Error('Failed to load TextMate regex engine')
    }
    await oniguruma.loadWASM(await response.arrayBuffer())
    return oniguruma
  })().catch((error: unknown) => {
    // Clear failed fetches so grammar retries can recover without restart.
    onigurumaPromise = undefined
    throw error
  })
  return onigurumaPromise
}
