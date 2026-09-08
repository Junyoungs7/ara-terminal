// #190 3라운드 — **컴포넌트별 리렌더 비용을 재기 위한 별도 빌드.** 제품 빌드를 건드리지 않는다.
//
// 왜 별도 빌드인가 (제품 코드를 계측용으로 고치지 않기 위해):
//  ① `<Profiler onRender>` 는 **제품 빌드에서 안 불린다.** react-dom 의 프로덕션 번들은
//     `enableProfilerTimer(__PROFILE__)` 가 꺼져 있어 actualDuration 을 아예 안 적는다.
//     그래서 소스에 <Profiler> 를 감싸도 0 만 나온다 — 감싸는 것 자체가 헛수고다.
//  ② `react-dom/profiling` 은 그 계측이 켜진 프로덕션 번들이다. React 18 은
//     `typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined'` 하나만 보고 트리 전체를
//     ProfileMode 로 만든다(ReactFiberDevToolsHook.isDevToolsPresent) — 하네스가 그 전역만
//     미리 깔아 두면(CDP Page.addScriptToEvaluateOnNewDocument) 파이버마다 actualDuration 이 찍힌다.
//     **제품 소스는 한 글자도 안 바뀐다.**
//  ③ minify:false — 압축하면 컴포넌트 함수 이름이 `q`·`pC` 로 뭉개져 "어느 컴포넌트"를 못 읽는다.
//
// 🔴 그래서 이 빌드의 **절대 ms 는 제품보다 크다**(계측 오버헤드 + 비압축). 컴포넌트 사이의
//   **비율**로만 읽어라. 절대값은 제품 빌드(out/)로 잰 판이 낸다.
//
// 돌리는 법: npx electron-vite build --config tests/perf.vite.config.ts   → out-perf/
// out-perf/ 는 커밋 대상이 아니다(측정이 끝나면 지워도 된다 — 이 파일로 언제든 다시 만든다).
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = { '@shared': resolve('src/shared') }
const OUT = resolve('out-perf')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: { outDir: resolve(OUT, 'main'), rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: { outDir: resolve(OUT, 'preload'), rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      // `react-dom/client` 는 안에서 `require('react-dom')` 을 한다 — 정확히 그 지점만 바꾼다.
      // (`react-dom` 접두 전체를 바꾸면 `react-dom/client` 자신이 자기를 가리켜 순환한다)
      alias: [
        { find: /^react-dom$/, replacement: 'react-dom/profiling' },
        { find: '@shared', replacement: sharedAlias['@shared'] }
      ]
    },
    plugins: [react()],
    build: {
      outDir: resolve(OUT, 'renderer'),
      minify: false, // 컴포넌트 이름을 살린다
      rollupOptions: { input: resolve('src/renderer/index.html') }
    }
  }
})
