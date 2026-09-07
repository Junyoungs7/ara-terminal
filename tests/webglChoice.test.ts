// 터미널 렌더러 판정 (#190 1라운드) — **창 없이 검사한다.**
//
// 이 판정이 틀렸을 때 사용자에게 보이는 것은 하나다: **"느리다."** 어느 렌더러가 실렸는지는
// 화면에도 로그에도 안 남으므로(그래서 같은 라운드에 설정 [정보] 행을 붙였다) 눈으로는 못 가른다.
// singleInstance.test.ts 와 같은 자리 — 그쪽은 "안 켜진다", 이쪽은 "느리다".
//
// ⚠️ 이 스위트가 지키지 **못하는** 것: WebglAddon 이 실제로 실렸는지, 아틀라스가 깨지는지는
// 여기서 안 보인다(그건 GPU 가 붙은 실기와 tmux 가 필요하다). 여기 있는 것은 판정뿐이다.
import { describe, it, expect } from 'vitest'
import { shouldUseWebgl } from '../src/renderer/terminal/webglChoice'

const real = { gl: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' }

describe('WebGL 렌더러를 쓸 자리인가', () => {
  it('진짜 GPU 면 쓴다 — 이게 다수 경로다', () => {
    expect(shouldUseWebgl(real)).toBe(true)
  })

  it('컨텍스트를 못 얻으면 안 쓴다(드라이버 없음·headless)', () => {
    expect(shouldUseWebgl({ gl: false, renderer: '' })).toBe(false)
  })

  it('소프트웨어 래스터라이저면 안 쓴다 — DOM 보다 느리고 종료 때 죽는 사례가 있다', () => {
    for (const r of ['Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Software Renderer']) {
      expect(shouldUseWebgl({ gl: true, renderer: r })).toBe(false)
    }
  })

  it('★ ARA_NO_WEBGL=1 이면 안 쓴다 — 증상을 만난 사람에게 줄 손잡이가 이것뿐이다', () => {
    expect(shouldUseWebgl({ ...real, optOut: '1' })).toBe(false)
  })

  it("'1' 이 아닌 값은 탈출구가 아니다 — ARA_E2E·ARA_ALLOW_MULTI 와 같은 규칙", () => {
    for (const v of ['', '0', 'true', 'yes', ' 1', undefined]) {
      expect(shouldUseWebgl({ ...real, optOut: v })).toBe(true)
    }
  })

  it('🔴 GPU 이름을 모르면 **쓴다** — 이 라운드는 이 구멍을 고치지 않는다', () => {
    // WEBGL_debug_renderer_info 가 정책으로 막히면 renderer 가 빈 문자열이다. 즉 우리는
    // "모른다"를 "멀쩡하다"로 읽는다. 뒤집으면 확장만 막힌 멀쩡한 PC 전부가 DOM 으로 떨어져
    // **더 느려지므로**, 제보자 PC 의 getGPUFeatureStatus() 를 받기 전에는 바꾸지 않는다.
    // 이 검사는 그 선택이 **의도**라는 표시다 — 바꾸려면 이 줄을 보고 오게 된다.
    expect(shouldUseWebgl({ gl: true, renderer: '' })).toBe(true)
  })
})
