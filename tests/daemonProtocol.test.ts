// M4 DM-01 — 데몬 순수 규칙: 프레이밍·토큰·replay 버퍼(Orca 크기 규칙)·판 판정·경로.
import { describe, expect, it } from 'vitest'
import { DAEMON_PROTOCOL_VERSION, ReplayBuffer, createFrameParser, daemonPaths, encodeFrame, judgeDaemon, replayCapChars, tokenMatches } from '../src/main/daemon/protocol'

describe('프레이밍(NDJSON)', () => {
  it('조각난 줄을 모아 순서대로 돌려준다', () => {
    const got: unknown[] = []
    const feed = createFrameParser((m) => got.push(m))
    const wire = encodeFrame({ a: 1 }) + encodeFrame({ b: '줄\n바꿈' })
    feed(wire.slice(0, 3))
    feed(Buffer.from(wire.slice(3, 11)))
    expect(got).toEqual([{ a: 1 }])
    feed(wire.slice(11))
    expect(got).toEqual([{ a: 1 }, { b: '줄\n바꿈' }])
  })
  it('깨진 줄은 건너뛰고 다음 줄은 받는다', () => {
    const got: unknown[] = []
    const feed = createFrameParser((m) => got.push(m))
    feed('{nope\n' + encodeFrame({ ok: true }))
    expect(got).toEqual([{ ok: true }])
  })
  it('상한을 넘는 줄은 버리고 끊으라고 알린다', () => {
    let over = 0
    const got: unknown[] = []
    const feed = createFrameParser((m) => got.push(m), () => over++, 10)
    feed('x'.repeat(11))
    expect(over).toBe(1)
    feed(encodeFrame(1))
    expect(got).toEqual([1])
  })
})

describe('토큰', () => {
  it('같을 때만 맞다 — 빈 기대값·문자열 아닌 값·길이 다른 값은 틀림', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abd')).toBe(false)
    expect(tokenMatches('abc', 'abcd')).toBe(false)
    expect(tokenMatches('abc', 123)).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })
})

describe('replay 버퍼', () => {
  it('Orca 규칙: max(2 MiB, 줄 × 120) — 기본 5,000 줄이면 2 MiB', () => {
    expect(replayCapChars()).toBe(2 * 1024 * 1024)
    expect(replayCapChars(50_000)).toBe(6_000_000)
  })
  it('상한을 넘으면 앞 조각부터 버리고 최근 출력을 남긴다', () => {
    const r = new ReplayBuffer(10)
    r.push('aaaa')
    r.push('bbbb')
    r.push('cccc')
    expect(r.snapshot()).toEqual(['bbbb', 'cccc'])
    expect(r.chars).toBe(8)
  })
  it('상한보다 큰 조각 하나는 끝부분만 남긴다', () => {
    const r = new ReplayBuffer(4)
    r.push('0123456789')
    expect(r.snapshot()).toEqual(['6789'])
    r.push('')
    expect(r.chars).toBe(4)
  })
})

describe('판 판정', () => {
  it('같은 판은 그대로 쓰고, 아는 옛 판은 세션이 끝날 때까지 쓰며, 모르는 판은 건드리지 않는다', () => {
    expect(judgeDaemon(DAEMON_PROTOCOL_VERSION)).toBe('adopt')
    expect(judgeDaemon(1, 2, [1])).toBe('drain')
    expect(judgeDaemon(3, 2, [1])).toBe('ignore')
    expect(judgeDaemon(0, 2, [1])).toBe('ignore')
  })
})

describe('경로', () => {
  it('판마다 다른 소켓·토큰 — Windows 는 사용자 폴더 해시가 든 named pipe', () => {
    const w1 = daemonPaths('C:\\Users\\a\\AppData\\Roaming\\ara\\daemon', 1, 'win32')
    const w2 = daemonPaths('C:\\Users\\a\\AppData\\Roaming\\ara\\daemon', 2, 'win32')
    const other = daemonPaths('C:\\Users\\b\\AppData\\Roaming\\ara\\daemon', 1, 'win32')
    expect(w1.socketPath).toMatch(/^\\\\\?\\pipe\\ara-agent-daemon-v1-[0-9a-f]{12}$/)
    expect(w2.socketPath).not.toBe(w1.socketPath)
    expect(other.socketPath).not.toBe(w1.socketPath)
    expect(w1.tokenPath.endsWith('daemon-v1.token')).toBe(true)
    expect(daemonPaths('/home/a/.config/ara/daemon', 1, 'linux').socketPath).toBe('/home/a/.config/ara/daemon/daemon-v1.sock')
  })
})
