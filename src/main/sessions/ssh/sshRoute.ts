/**
 * M8 TM-01 고급 연결 — 점프 호스트·프록시·재접속 백오프. 순수 판정은 단위 테스트 대상(tests/sshRoute.test.ts).
 *
 * Orca 와 다른 점(옮긴/뺀 표는 agent_talk/m8-r2-conn-done.md):
 *  · Orca 는 점프를 **시스템 ssh**(`ssh -W host:port -J …`)로 건다(ssh-proxy-command.ts). 아라는 ssh2
 *    `forwardOut` 체인으로 건다 — Windows 에 OpenSSH 가 없거나 버전이 달라도 같고, 각 홉의 호스트키도
 *    아라의 TOFU(knownHosts)를 그대로 지난다.
 *  · `~/.ssh/config` 는 읽지 않는다 — 아라는 원래 안 읽는다(새 파서 금지). 그래서 ProxyCommand 는 없고
 *    프로필의 점프 칸(ProxyJump 표기)만 있다.
 *  · 프록시는 SOCKS5·HTTP CONNECT 를 **직접** 말한다(새 의존성 없음). 인증 프록시는 뺐다 — 자격을
 *    workspace.json 평문에 둘 수 없다. 필요해지면 vault 에 넣는 칸을 따로 만든다.
 */
import net from 'node:net'
import type { Duplex } from 'node:stream'

export type JumpHop = { host: string; port: number; username: string }

/**
 * ProxyJump 표기 `[user@]host[:port][,…]` → 홉 목록(앞에서부터 차례로 거친다).
 * IPv6 는 `[::1]:2222`. 사용자를 안 적은 홉은 대상 프로필의 사용자로 붙는다(OpenSSH 와 같다).
 */
export function parseJump(spec: string | undefined, defaultUser: string): JumpHop[] | { error: string } {
  const out: JumpHop[] = []
  for (const raw of (spec ?? '').split(',')) {
    const s = raw.trim()
    if (!s) continue
    const at = s.lastIndexOf('@')
    const user = at >= 0 ? s.slice(0, at) : defaultUser
    const rest = at >= 0 ? s.slice(at + 1) : s
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest) ?? /^([^:\s]+)(?::(\d+))?$/.exec(rest)
    if (!m || !user) return { error: `점프 호스트 표기가 올바르지 않습니다: ${s}` }
    const port = m[2] ? Number(m[2]) : 22
    if (!(port > 0 && port < 65536)) return { error: `점프 호스트 포트가 올바르지 않습니다: ${s}` }
    out.push({ host: m[1], port, username: user })
  }
  return out
}

export type ProxySpec = { kind: 'socks5' | 'http'; host: string; port: number }

/** `socks5://host:1080` · `http://host:8080` → 프록시 설정. 빈 값은 null(프록시 없음). */
export function parseProxy(url: string | undefined): ProxySpec | null | { error: string } {
  const s = (url ?? '').trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { error: `프록시 주소가 올바르지 않습니다: ${s}` }
  }
  const kind = u.protocol === 'socks5:' || u.protocol === 'socks5h:' || u.protocol === 'socks:' ? 'socks5' : u.protocol === 'http:' ? 'http' : null
  if (!kind) return { error: `지원하지 않는 프록시 종류입니다(socks5:// 또는 http://): ${s}` }
  if (u.username || u.password) return { error: '인증이 필요한 프록시는 아직 지원하지 않습니다.' }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const port = u.port ? Number(u.port) : kind === 'socks5' ? 1080 : 8080
  if (!host) return { error: `프록시 호스트가 없습니다: ${s}` }
  return { kind, host, port }
}

/** SOCKS5 CONNECT 요청(인증 없음, 대상은 도메인 이름 — 이름 풀이는 프록시가 한다). */
export function socks5ConnectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, 'utf8')
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])])
}

/**
 * 프록시를 거쳐 host:port 까지 뚫린 소켓. ssh2 `ConnectConfig.sock` 에 그대로 넣는다.
 * 실패는 Error 로 던진다(호출측이 network 사유로 바꾼다).
 */
export function proxySocket(p: ProxySpec, host: string, port: number, timeoutMs = 10_000): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: p.host, port: p.port })
    let buf = Buffer.alloc(0)
    let stage = 0
    const fail = (why: string): void => {
      sock.destroy()
      reject(new Error(`프록시(${p.host}:${p.port}) — ${why}`))
    }
    sock.setTimeout(timeoutMs, () => fail('시간 초과'))
    sock.once('error', (e) => fail(e.message))
    sock.once('connect', () => {
      if (p.kind === 'socks5') sock.write(Buffer.from([0x05, 0x01, 0x00]))
      else sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    const done = (rest: Buffer): void => {
      sock.removeListener('data', onData)
      sock.setTimeout(0)
      sock.removeAllListeners('error')
      // 멈춰 두고 넘긴다 — 듣는 쪽이 없는 사이 흘러가 버린 바이트는 되찾을 수 없다. ssh2 는 sock 을 받으면
      // 스스로 resume 한다(client.js). 응답과 같은 덩어리로 온 대상의 첫 바이트는 되돌려 넣는다.
      sock.pause()
      if (rest.length) sock.unshift(rest)
      resolve(sock)
    }
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      if (p.kind === 'http') {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))
        if (!status || status[1] !== '200') return fail(`CONNECT 거부(${status?.[1] ?? '응답 없음'})`)
        return done(buf.subarray(end + 4))
      }
      if (stage === 0) {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('SOCKS5 인증 방식 거부')
        buf = buf.subarray(2)
        stage = 1
        sock.write(socks5ConnectRequest(host, port))
      }
      if (stage === 1) {
        if (buf.length < 5) return
        if (buf[1] !== 0x00) return fail(`SOCKS5 CONNECT 실패(코드 ${buf[1]})`)
        const len = buf[3] === 0x01 ? 4 : buf[3] === 0x04 ? 16 : 1 + buf[4]
        const total = 4 + len + 2
        if (buf.length < total) return
        done(buf.subarray(total))
      }
    }
    sock.on('data', onData)
  })
}

/** Orca 재접속 사다리(ssh-connection-timing.ts RECONNECT_BACKOFF_MS) 그대로. 마지막 칸에서 멈춘다. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]

export function backoffDelay(attempt: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(Math.max(0, attempt), RECONNECT_BACKOFF_MS.length - 1)]
}

/**
 * `network` 실패만 백오프로 다시 시도한다(인증·호스트키는 다시 해 봐야 같다).
 * budgetMs 를 넘길 재시도는 하지 않는다 — 죽은 서버를 끝없이 때리지 않는다(2026-08-14 결정의 이유).
 */
export async function withBackoff<T extends { ok: boolean; reason?: string }>(
  attempt: () => Promise<T>,
  opts: { maxAttempts: number; budgetMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const start = now()
  let res = await attempt()
  for (let i = 0; i < opts.maxAttempts - 1; i++) {
    if (res.ok || res.reason !== 'network') return res
    const d = backoffDelay(i)
    if (now() - start + d > opts.budgetMs) return res
    await sleep(d)
    res = await attempt()
  }
  return res
}
