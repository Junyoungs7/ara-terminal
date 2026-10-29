// P3(2026-10-29 e2e BOOT-5): 아라 채팅을 처음 열 때 부트스트랩 제출 글이 사라졌다. prefill 효과가
// 엔진이 뜨기 전(phase closed/opening)에 send 를 불렀고 send 는 그때 버렸다 — 효과는 다시 돌지 않았다.
// 이제 보낼 것은 엔진이 준비될 때까지 **기다렸다가** 한 번만 보낸다.
import { describe, it, expect } from 'vitest'
import { prefillStep } from '../src/renderer/store/araChatItems'

const auto = { text: '부트스트랩 요청', at: 1, autoSend: true }

describe('prefillStep — 얹어 줄 말을 언제 어떻게', () => {
  it('엔진이 아직 안 떴으면 보내지 않고 기다린다(버리지 않는다)', () => {
    expect(prefillStep(auto, null, true, false)).toBe('wait')
  })
  it('준비되면 보낸다', () => {
    expect(prefillStep(auto, null, true, true)).toBe('send')
  })
  it('이미 처리한 것은 다시 보내지 않는다', () => {
    expect(prefillStep(auto, 1, true, true)).toBe('none')
  })
  it('autoSend 가 아니면 엔진과 무관하게 입력칸에 얹는다', () => {
    expect(prefillStep({ text: 'x', at: 2 }, null, true, false)).toBe('draft')
  })
  it('패널이 닫혀 있거나 글이 비면 아무것도 안 한다', () => {
    expect(prefillStep(auto, null, false, true)).toBe('none')
    expect(prefillStep({ text: '  ', at: 3, autoSend: true }, null, true, true)).toBe('none')
    expect(prefillStep(null, null, true, true)).toBe('none')
  })
})
