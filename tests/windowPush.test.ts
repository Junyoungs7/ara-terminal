// FIX-destroyed: util/windowPush.ts 단일 가드 — null/destroyed/isDestroyed() 자체가 던지는 경우/
// send() 가 가드를 지나고도 던지는(예측 못 한 네이티브 레이스) 경우까지 전부 조용히 무시해야 한다.
// 실기동(진짜 Electron 프로세스에서 진짜 destroyed WebContents)은 tests/fix-destroyed-smoke.cjs 가 맡는다
// (지시서 §3 — 단위 목킹만으로는 이 결함이 안 잡힌 전례가 있어 최소 1건은 실기동으로 고정).
import { describe, it, expect, vi } from 'vitest'
import { pushSend, pushMessage } from '../src/main/util/windowPush'

function fakeWc(opts: {
  isDestroyed?: () => boolean
  send?: () => void
  postMessage?: () => void
}): any {
  return {
    isDestroyed: opts.isDestroyed ?? (() => false),
    send: opts.send ?? vi.fn(),
    postMessage: opts.postMessage ?? vi.fn()
  }
}

describe('windowPush — pushSend/pushMessage 단일 가드', () => {
  it('wc 가 null/undefined 면 아무것도 안 하고 던지지 않는다', () => {
    expect(() => pushSend(null, 'x', 1)).not.toThrow()
    expect(() => pushMessage(undefined, 'x', new Uint8Array())).not.toThrow()
  })

  it('isDestroyed() 가 true 면 send/postMessage 를 호출하지 않는다', () => {
    const send = vi.fn()
    const wc = fakeWc({ isDestroyed: () => true, send })
    pushSend(wc, 'ai:delta', { text: 'hi' })
    expect(send).not.toHaveBeenCalled()
  })

  it('isDestroyed() 가 false 면 정상적으로 send() 를 호출한다', () => {
    const send = vi.fn()
    const wc = fakeWc({ send })
    pushSend(wc, 'ai:delta', { text: 'hi' })
    expect(send).toHaveBeenCalledWith('ai:delta', { text: 'hi' })
  })

  it('isDestroyed() 자체가 던져도(파괴 레이스) 삼킨다 — registerWindowIpc.ts 기존 관행과 동일 전제', () => {
    const wc = fakeWc({ isDestroyed: () => { throw new Error('Object has been destroyed') } })
    expect(() => pushSend(wc, 'x', 1)).not.toThrow()
  })

  it('isDestroyed()===false 인데도 send() 가 던지면(예측 못 한 레이스) 삼킨다', () => {
    // FIX-destroyed 조사에서 확인: 이 케이스를 로컬에서 못 잡으면 uncaughtException 안전망도
    // 못 잡는 경로(fire-and-forget async 안 재호출)로 새어 나간다 — 그래서 지점 자체를 감싼다.
    const wc = fakeWc({ send: () => { throw new Error('Object has been destroyed') } })
    expect(() => pushSend(wc, 'x', 1)).not.toThrow()
  })

  it('postMessage 도 같은 가드를 받는다(session:data 경로)', () => {
    const postMessage = vi.fn()
    const wc = fakeWc({ isDestroyed: () => true, postMessage })
    pushMessage(wc, 'session:data:1', new Uint8Array([1, 2]))
    expect(postMessage).not.toHaveBeenCalled()
  })
})
