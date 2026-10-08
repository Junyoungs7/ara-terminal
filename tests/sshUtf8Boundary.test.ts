// 오류 신고 #12 — SSH 출력에서 한글이 간헐적으로 깨진다(�).
// SSH 패킷 경계는 UTF-8 글자를 가리지 않는다. 한 글자(3바이트)가 두 data 청크로 갈려 와도
// SshBackend.onData 는 온전한 글자를 내야 한다. 청크마다 toString 하면 이 시험이 깨진다.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client, ClientChannel } from 'ssh2'
import { SshBackend } from '../src/main/sessions/ssh/SshBackend'

function fakeBackend(): { backend: SshBackend; channel: EventEmitter & { stderr: EventEmitter } } {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
  // 셸 PID 찾기(exec)는 실패시켜 CWD 추적을 끈다 — 이 시험의 관심은 출력 디코딩뿐이다.
  const client = { exec: (_c: string, cb: (e: Error) => void) => cb(new Error('no exec')) }
  const backend = new SshBackend(client as unknown as Client, channel as unknown as ClientChannel)
  return { backend, channel }
}

describe('SshBackend 출력 — UTF-8 멀티바이트가 청크 경계에 걸려도 깨지지 않는다(#12)', () => {
  it('한 글자가 모든 위치에서 갈려도 원문 그대로', () => {
    const text = '안녕하세요 터미널'
    const bytes = Buffer.from(text, 'utf8')
    for (let cut = 1; cut < bytes.length; cut++) {
      const { backend, channel } = fakeBackend()
      let out = ''
      backend.onData((s) => (out += s))
      channel.emit('data', bytes.subarray(0, cut))
      channel.emit('data', bytes.subarray(cut))
      expect(out).toBe(text)
      expect(out).not.toContain('�')
    }
  })

  it('stdout·stderr 가 번갈아 와도 각자의 잘린 꼬리를 섞지 않는다', () => {
    const { backend, channel } = fakeBackend()
    let out = ''
    backend.onData((s) => (out += s))
    const a = Buffer.from('가', 'utf8')
    const b = Buffer.from('나', 'utf8')
    channel.emit('data', a.subarray(0, 1))
    channel.stderr.emit('data', b.subarray(0, 2))
    channel.emit('data', a.subarray(1))
    channel.stderr.emit('data', b.subarray(2))
    expect(out).toBe('가나')
  })
})
