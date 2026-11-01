// M8 TM-01 고급 연결(점프 표기·프록시 판정·백오프) + herdr H10 붙여넣기 경로 규칙 — 순수 단위 + 로컬 가짜 프록시.
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  backoffDelay,
  parseJump,
  parseProxy,
  proxySocket,
  socks5ConnectRequest,
  withBackoff,
  RECONNECT_BACKOFF_MS
} from '../src/main/sessions/ssh/sshRoute'
import { PASTE_STALE_MS, pasteImageExt, remotePastePath, stalePasteNames } from '../src/shared/pasteImage'
import { clipImages } from '../src/renderer/store/pasteFiles'

describe('parseJump — ProxyJump 표기', () => {
  it('여러 단 · 사용자 생략 · 포트 생략 · IPv6', () => {
    expect(parseJump('a@bastion:2222, gw ,[::1]:23', 'me')).toEqual([
      { host: 'bastion', port: 2222, username: 'a' },
      { host: 'gw', port: 22, username: 'me' },
      { host: '::1', port: 23, username: 'me' }
    ])
  })
  it('비어 있으면 홉 없음', () => {
    expect(parseJump(undefined, 'me')).toEqual([])
    expect(parseJump('  ', 'me')).toEqual([])
  })
  it('잘못된 표기·포트는 오류', () => {
    expect(parseJump('a@b:99999', 'me')).toHaveProperty('error')
    expect(parseJump('a@b c', 'me')).toHaveProperty('error')
    expect(parseJump('@host', '')).toHaveProperty('error')
  })
})

describe('parseProxy — 프록시 설정 판정', () => {
  it('socks5·http · 기본 포트 · 빈 값', () => {
    expect(parseProxy('socks5://10.0.0.1:1081')).toEqual({ kind: 'socks5', host: '10.0.0.1', port: 1081 })
    expect(parseProxy('socks5h://p')).toEqual({ kind: 'socks5', host: 'p', port: 1080 })
    expect(parseProxy('http://proxy')).toEqual({ kind: 'http', host: 'proxy', port: 8080 })
    expect(parseProxy('')).toBeNull()
    expect(parseProxy(undefined)).toBeNull()
  })
  it('모르는 종류·인증 프록시·쓰레기는 오류(평문 자격을 저장하지 않는다)', () => {
    expect(parseProxy('https://p:443')).toHaveProperty('error')
    expect(parseProxy('socks5://u:pw@p:1080')).toHaveProperty('error')
    expect(parseProxy('not a url')).toHaveProperty('error')
  })
  it('SOCKS5 CONNECT 요청은 도메인 이름 형식(이름 풀이는 프록시가)', () => {
    expect([...socks5ConnectRequest('ab', 22)]).toEqual([5, 1, 0, 3, 2, 0x61, 0x62, 0, 22])
  })
})

describe('재접속 백오프', () => {
  it('Orca 사다리 · 끝에서 멈춤', () => {
    expect(backoffDelay(0)).toBe(1000)
    expect(backoffDelay(2)).toBe(5000)
    expect(backoffDelay(99)).toBe(RECONNECT_BACKOFF_MS.at(-1))
  })
  it('network 만 다시 하고, 시간 상한을 넘길 재시도는 안 한다', async () => {
    let t = 0
    const slept: number[] = []
    const opts = { maxAttempts: 10, budgetMs: 8000, sleep: async (ms: number) => void slept.push((t += ms)), now: () => t }
    let n = 0
    const r = await withBackoff(async () => (n++, { ok: false as boolean, reason: 'network' }), opts)
    expect(r.ok).toBe(false)
    expect(n).toBe(4) // 1+2+5 = 8초까지, 다음 5초는 상한을 넘는다
    expect(slept).toEqual([1000, 3000, 8000])

    n = 0
    await withBackoff(async () => (n++, { ok: false as boolean, reason: 'auth' }), opts)
    expect(n).toBe(1) // 인증 실패는 다시 해 봐야 같다

    n = 0
    t = 0
    const ok = await withBackoff(async () => (++n < 3 ? { ok: false, reason: 'network' } : { ok: true }), opts)
    expect(ok.ok).toBe(true)
    expect(n).toBe(3)
  })
})

// 로컬 가짜 프록시(127.0.0.1) — 실제·사내 프록시에 붙지 않는다.
let servers: net.Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers = []
})
// proxySocket 은 멈춘 채로 넘긴다(ssh2 가 resume 한다) — 시험도 듣고 나서 resume 한다.
function firstData(sock: import('node:stream').Duplex): Promise<string> {
  const p = new Promise<string>((r) => sock.once('data', (d: Buffer) => r(d.toString())))
  sock.resume()
  return p
}
function listen(onConn: (s: net.Socket) => void): Promise<number> {
  const srv = net.createServer(onConn)
  servers.push(srv)
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)))
}

describe('proxySocket — 로컬 가짜 프록시', () => {
  it('SOCKS5: 인사 → CONNECT → 이후 바이트는 대상의 것', async () => {
    let req: Buffer | null = null
    const port = await listen((s) => {
      let stage = 0
      s.on('data', (d) => {
        if (stage++ === 0) return void s.write(Buffer.from([5, 0]))
        req = d
        s.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]))
        s.write('SSH-2.0-fake\r\n') // 응답과 같은 덩어리로 와도 잃지 않아야 한다
      })
    })
    const sock = await proxySocket({ kind: 'socks5', host: '127.0.0.1', port }, 'target.local', 22)
    const first = await firstData(sock)
    expect(first).toBe('SSH-2.0-fake\r\n')
    expect(req!.subarray(0, 4)).toEqual(Buffer.from([5, 1, 0, 3]))
    sock.destroy()
  })
  it('HTTP CONNECT: 200 이면 통과, 아니면 실패', async () => {
    const port = await listen((s) =>
      s.once('data', (d) => {
        const ok = d.toString().startsWith('CONNECT good:22 ')
        s.write(ok ? 'HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-x\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n')
      })
    )
    const sock = await proxySocket({ kind: 'http', host: '127.0.0.1', port }, 'good', 22)
    expect(await firstData(sock)).toBe('SSH-2.0-x\r\n')
    sock.destroy()
    await expect(proxySocket({ kind: 'http', host: '127.0.0.1', port }, 'bad', 22)).rejects.toThrow(/403/)
  })
})

describe('붙여넣기 이미지 경로 규칙', () => {
  it('원격 경로는 홈 아래 한 폴더 · 형식 판정', () => {
    const now = new Date(2026, 10, 1, 14, 22, 33)
    expect(remotePastePath('/home/u/', 'image/png', now, 'ab12')).toBe('/home/u/.ara-paste/paste-20261101-142233-ab12.png')
    expect(remotePastePath('/', 'image/jpeg', now, 'x')).toBe('/.ara-paste/paste-20261101-142233-x.jpg')
    expect(remotePastePath('/h', 'text/plain', now, 'x')).toBeNull()
    expect(pasteImageExt('image/webp')).toBe('webp')
  })
  it('청소는 하루 지난 우리 파일만', () => {
    const now = 10 * PASTE_STALE_MS
    const old = (now - PASTE_STALE_MS - 1000) / 1000
    expect(
      stalePasteNames(
        [
          { filename: 'paste-1.png', mtime: old },
          { filename: 'paste-2.png', mtime: now / 1000 },
          { filename: 'notes.txt', mtime: old }
        ],
        now
      )
    ).toEqual(['paste-1.png'])
  })
  it('클립보드 이미지 판정 — 경로 없는 image/* 만(파일 복사는 기존 업로드 길)', () => {
    const shot = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
    const copied = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const text = new File(['x'], 'a.txt', { type: 'text/plain' })
    const pathOf = (f: File): string => (f === copied ? 'C:\\a.png' : '')
    expect(clipImages([shot, copied, text], pathOf)).toEqual([shot])
  })
})
