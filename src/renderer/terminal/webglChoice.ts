// 터미널을 **무엇으로 그릴지**의 판정과, 실제로 무엇이 실렸는지의 기록 (#190 1라운드).
//
// 왜 TerminalPane 에서 떼어냈나: 여기서 틀리면 증상이 **"느리다"·"스크롤하면 깜빡인다"** 로만
// 나타난다. 어느 렌더러가 실렸는지는 화면 어디에도 안 나오고 로그에도 안 남으므로 사람 눈으로는
// 못 가른다 — 그래서 이 라운드에 설정 [정보] 행(GpuRow)을 함께 붙였다. 판정은 창 없이 회귀로
// 잡을 수 있어야 한다(singleInstance 의 shouldLockSingleInstance 와 같은 관행).
// 검사: tests/webglChoice.test.ts
//
// ⚠️ 이 파일은 xterm 을 import 하지 않는다 — node 환경 vitest 가 그대로 읽어야 한다
// (completionKeys·resizeGate 와 같은 자리. TerminalPane.tsx 는 xterm CSS 를 물고 있어 못 읽는다).

export type WebglProbe = {
  /**
   * `ARA_NO_WEBGL` 환경변수의 **날값**. 값 비교를 이 함수 안에서 하는 것이 의도다 —
   * 규칙(`'1'` 만 본다)이 두 곳으로 갈리면 한쪽만 고쳐지고, 그 어긋남은 창을 띄워야 보인다.
   * ARA_E2E·ARA_ALLOW_MULTI·ARA_AI_FAKE 와 같은 규칙이다.
   */
  optOut?: string | undefined
  /** webgl2 컨텍스트를 얻었나. */
  gl: boolean
  /**
   * `WEBGL_debug_renderer_info` 가 답한 GPU 이름. **확장이 막혀 있으면 빈 문자열이다** —
   * 아래 판정의 구멍이 바로 그 자리다(함수 주석 참고).
   */
  renderer: string
}

/**
 * WebGL 렌더러를 쓸까.
 *
 * 🔴 **판정 논리를 "모르면 안 쓴다"로 바꾸지 마라.** 빈 `renderer` 는 정규식에 걸리지 않으므로
 * 이 함수는 **"GPU 를 알 수 없다"를 "멀쩡하다"로 읽는다.** 구멍인 것은 맞다. 그런데 그 확장은
 * 진짜 GPU 가 있는 PC 에서도 정책으로 막히고(사내 PC 에 실제로 있다), 안전한 쪽으로 뒤집으면
 * **멀쩡한 사람 전부가 DOM 렌더러로 떨어져 오히려 느려진다.** 어느 쪽이 다수인지 우리는 아직
 * 모른다 — 그래서 이 라운드는 재기만 한다(설정 [정보] 행 + `app:gpuInfo`). 고치는 것은
 * 제보자 PC 의 `getGPUFeatureStatus()` 를 받고 나서다.
 *
 * 소프트웨어 래스터라이저(SwiftShader/llvmpipe)를 거르는 이유는 TerminalPane 의 프로브 주석에
 * 있다 — DOM 보다 느리고, 종료 시 GL 정리에서 프로세스가 접근 위반으로 죽는 사례가 있다.
 */
export function shouldUseWebgl(p: WebglProbe): boolean {
  // 탈출구가 맨 앞이다. **진단용이자 임시 처방**이라 프로브보다 앞에 있어야 한다(TerminalPane 주석).
  if (p.optOut === '1') return false
  if (!p.gl) return false
  return !/swiftshader|software|llvmpipe/i.test(p.renderer)
}

/**
 * 이 창의 터미널이 **실제로** 무엇으로 그려지나 — 설정 [정보]가 읽는다.
 *
 * 프로브 값이 아니라 **결과**를 담는다. WebglAddon 은 생성·`loadAddon` 에서 던질 수 있고
 * 컨텍스트 로스트로 스스로 dispose 되면 xterm 이 조용히 DOM 으로 돌아가는데, 그때 프로브만
 * 보여 주면 화면이 **"WebGL"이라고 거짓말을 한다** — 제보를 받아 비교할 값이 거짓이면
 * 이 라운드가 통째로 헛일이 된다.
 *
 * 창당 한 벌이면 충분해서 모듈 변수다(termPrefs 와 같은 결). 패널이 여럿이어도 판정은 창당
 * 한 번뿐(TerminalPane 의 `webglUsable` 캐시)이라 값이 갈리지 않는다.
 */
export const termRenderer: {
  /** null = 아직 터미널이 열리지 않았다. 'dom' 으로 초기화하면 그것도 거짓말이 된다. */
  kind: 'webgl' | 'dom' | null
  /** 프로브가 읽은 GPU 이름(빈 문자열 = 확장이 막혔거나 컨텍스트를 못 얻었다). */
  gpu: string
  /** `ARA_NO_WEBGL` 의 날값. `'1'` 이 아닌 오타('true'·'yes')도 그대로 보이게 둔다. */
  optOut?: string | undefined
} = { kind: null, gpu: '' }
