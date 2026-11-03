// 3차 R2-B — stablyai/orca @ec112c6b01 (MIT) src/renderer/src/lib/syntax-highlighting/oniguruma-test-harness.ts 그대로(시험 전용).
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Oniguruma } from '../../src/renderer/features/aiws/monacoLanguages/oniguruma'

let nodeOnigurumaPromise: Promise<Oniguruma> | undefined

/** The bundled Oniguruma WASM read from disk, for tests running outside a browser. */
export function loadNodeOniguruma(): Promise<Oniguruma> {
  nodeOnigurumaPromise ??= (async () => {
    const oniguruma = await import('vscode-oniguruma')
    const wasm = await readFile(
      createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm')
    )
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
    return oniguruma
  })()
  return nodeOnigurumaPromise
}
