import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * dev 전용 교정 — RDP wasm 이 "Failed to fetch" 로 죽던 것 (2026-08-22 준영님 제보 20번).
 *
 * `@devolutions/iron-remote-desktop-rdp` 는 wasm 을 **base64 data: URL 로 내장**하고
 * `new URL("data:application/wasm;base64,…", import.meta.url)` 로 읽는다. data: 는 절대 URL 이라
 * 원래는 두 번째 인자가 무시되는데, vite 의 에셋 처리(`vite:asset-import-meta-url`)가 이 패턴을
 * **에셋 참조로 오인해 경로를 다시 쓴다.** 그 결과 dev 에서 실제로 요청되는 주소가 이렇게 된다:
 *
 *   http://localhost:5173/@fs/…/iron-remote-desktop-rdp/data:application/wasm;base64,AGFzbQ…
 *
 * 존재하지 않는 경로라 fetch 가 실패하고, 화면에는 "Failed to fetch" 한 줄만 남았다.
 * 빌드(rollup)는 이 변환을 하지 않아 **설치본은 멀쩡했다** — 그래서 dev 에서만 나던 결함이다.
 *
 * 고치는 자리: 우리가 **먼저**(enforce:'pre') 그 패턴을 문자열 리터럴로 눌러 두면 뒤 플러그인이
 * 손댈 것이 없다. 동작은 그대로다(data: URL 을 fetch 하는 것은 CSP connect-src data: 로 이미 허용).
 * 실측: 이 플러그인 없이는 init() 이 "Failed to fetch", 넣으면 92ms 에 통과.
 */
function rdpWasmDataUrlFix() {
  return {
    name: 'ara-rdp-wasm-data-url',
    enforce: 'pre' as const,
    apply: 'serve' as const,
    transform(code: string, id: string) {
      if (!id.includes('iron-remote-desktop-rdp') || !code.includes('import.meta.url')) return null
      const out = code.replace(
        /new URL\(\s*("data:application\/wasm;base64,[^"]*")\s*,\s*import\.meta\.url\s*\)/g,
        '$1'
      )
      return out === code ? null : { code: out, map: null }
    }
  }
}

export default defineConfig({
  main: {
    // node-pty 등 네이티브 모듈은 번들하지 않고 externalize(계획서 §B.5).
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [rdpWasmDataUrlFix(), react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
