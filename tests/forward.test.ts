// W2 F8 포트 포워딩 검증 — ssh2 하네스로 direct-tcpip 실왕복(실서버 없음) + 보안 불변식 어서션.
// 여기서 증명하는 것(설계 §2 / 보안 체크리스트):
//   · 로컬 바인드가 127.0.0.1 고정이다(사내망 IP 로는 닿지 않는다)
//   · 원격 목적지가 127.0.0.1 고정이다(하네스가 받은 destIP 로 확인 — 프로토콜 레벨 증거)
//   · 포트 검증 · 세션 없음 거부 · 멱등 · 세션당 상한 · 세션 종료 시 정리
import { describe, it, expect, afterEach } from 'vitest'
import { connect as netConnect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { readFileSync } from 'node:fs'
import type { Client, ServerChannel } from 'ssh2'
import { connectSsh, type SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { createForwardService, isValidPort, LOCAL_BIND, MAX_PER_SESSION, REMOTE_HOST } from '../src/main/forward/PortForward'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { SshProfile } from '../src/shared/types'

let harness: Harness | null = null
let backend: SshBackend | null = null

afterEach(async () => {
  backend?.kill()
  backend = null
  await harness?.close()
  harness = null
})

function pwProfile(port: number): SshProfile {
  return {
    id: 'p1',
    name: 'harness',
    host: '127.0.0.1',
    port,
    username: 'tester',
    type: 'ssh',
    auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } }
  }
}

async function connectClient(): Promise<Client> {
  const res = await connectSsh(pwProfile(harness!.port), {
    knownHosts: {},
    secret: harness!.password,
    acceptHostKey: true,
    onHostKeyAccepted: () => {}
  })
  if (!res.ok) throw new Error('connect failed: ' + res.reason)
  backend = res.backend
  return res.backend.sshClient()!
}

// 로컬 포워딩 입구로 한 줄 보내고 돌아온 응답을 모은다.
// 상대가 소켓을 끊으면(세션 사망 경로) ECONNRESET 이 정상 결과이므로 오류도 "받은 것까지"로 마감한다.
function roundTrip(port: number, payload: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port }, () => socket.write(payload))
    let out = ''
    socket.setTimeout(4000, () => socket.destroy())
    socket.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    socket.on('close', () => resolve(out))
    socket.on('error', () => resolve(out))
  })
}

// 접속이 되는지만 본다(성공=true). 거부·타임아웃은 false.
function reachable(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const done = (v: boolean): void => {
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

// 이 PC 의 사내망(비-loopback) IPv4. 없으면 undefined(그 어서션은 건너뛴다).
function lanIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return undefined
}

describe('포트 검증(IPC 남용 방어)', () => {
  it('정수 1..65535 만 통과한다', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
    expect(isValidPort(80.5)).toBe(false)
    expect(isValidPort('80')).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
    expect(isValidPort(undefined)).toBe(false)
  })

  it('잘못된 포트·세션은 리스너를 만들지 않고 사유를 돌려준다', async () => {
    const svc = createForwardService(() => ({}) as Client)
    for (const bad of [0, 70000, '80' as unknown as number, -1, 1.5]) {
      const r = await svc.create('sid', bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid')
    }
    expect(svc.list()).toHaveLength(0)
  })

  it('활성 SSH 세션이 없으면(로컬·죽은 세션) 거부한다', async () => {
    const svc = createForwardService(() => null)
    const r = await svc.create('local-session', 8080)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('noSession')
    expect(svc.list()).toHaveLength(0)
  })
})

describe('바인드·목적지 불변식', () => {
  it('상수가 loopback 이고 소스에 다른 바인드 주소가 없다', () => {
    expect(LOCAL_BIND).toBe('127.0.0.1')
    expect(REMOTE_HOST).toBe('127.0.0.1')
    const src = readFileSync(new URL('../src/main/forward/PortForward.ts', import.meta.url), 'utf8')
    // 0.0.0.0 리터럴은 주석에도 등장하지만(불변식 설명) listen 인자에는 LOCAL_BIND 만 온다.
    for (const call of src.match(/\.listen\([^)]*\)/g) ?? []) {
      expect(call).toContain('LOCAL_BIND')
    }
    // forwardOut 의 목적지 호스트도 상수 하나뿐이다.
    expect(src).toMatch(/forwardOut\(LOCAL_BIND, [^,]+, REMOTE_HOST,/)
  })
})

describe('ssh2 하네스 포워딩 실왕복', () => {
  it('로컬 소켓 → 원격 loopback 으로 왕복하고, 원격이 받은 목적지가 127.0.0.1 이다', async () => {
    const seen: { destIP: string; destPort: number }[] = []
    harness = await startPasswordServer({
      tcpipHandler: (info, channel: ServerChannel) => {
        seen.push(info)
        channel.on('data', (d: Buffer) => {
          channel.write('원격에코:' + d.toString('utf8'))
          channel.end()
        })
      }
    })
    const client = await connectClient()
    const svc = createForwardService(() => client)

    const res = await svc.create('sid', 8765)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.forward.remotePort).toBe(8765)
    expect(res.forward.sessionId).toBe('sid')
    // 계약에 호스트 필드가 아예 없다(렌더러가 목적지를 지목할 수 없다는 타입 수준 방어).
    expect(Object.keys(res.forward).sort()).toEqual(
      ['conns', 'exact', 'id', 'localPort', 'remotePort', 'sessionId'].sort()
    )

    const out = await roundTrip(res.forward.localPort, '한글왕복\n')
    expect(out).toContain('원격에코:한글왕복')
    // ★ 프로토콜 레벨 증거: 원격이 받은 목적지는 언제나 loopback 이다.
    expect(seen).toHaveLength(1)
    expect(seen[0].destIP).toBe('127.0.0.1')
    expect(seen[0].destPort).toBe(8765)

    svc.stopAll()
  })

  it('사내망 IP 로는 포워딩 입구에 닿지 않는다(0.0.0.0 바인드 아님)', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    const svc = createForwardService(() => client)
    const res = await svc.create('sid', 9100)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(await reachable('127.0.0.1', res.forward.localPort)).toBe(true)
    const lan = lanIPv4()
    // 사내망 인터페이스가 없는 환경(격리 CI)에서는 loopback 접속만 확인하고 넘어간다.
    if (lan) expect(await reachable(lan, res.forward.localPort)).toBe(false)

    svc.stopAll()
  })
})

describe('수명·멱등', () => {
  it('같은 포트를 두 번(동시에도) 만들어도 리스너는 하나다', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    const svc = createForwardService(() => client)

    const [a, b] = await Promise.all([svc.create('sid', 3000), svc.create('sid', 3000)])
    const c = await svc.create('sid', 3000)
    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    expect(b.forward.localPort).toBe(a.forward.localPort)
    expect(c.forward.id).toBe(a.forward.id)
    expect(svc.list()).toHaveLength(1)

    svc.stopAll()
  })

  it('exactPort 는 점유 시 실패하고(폴백 금지), 일반 경로는 임의 포트로 열린다', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    const svc = createForwardService(() => client)

    // 원격 포트 번호와 같은 로컬 포트를 미리 점유한다.
    const squatter = createServer()
    const taken = await new Promise<number>((resolve) => {
      squatter.listen(0, '127.0.0.1', () => {
        const a = squatter.address()
        resolve(typeof a === 'object' && a !== null ? a.port : 0)
      })
    })

    const oauth = await svc.create('sid', taken, true)
    expect(oauth.ok).toBe(false)
    if (!oauth.ok) expect(oauth.reason).toBe('portInUse')
    expect(svc.list()).toHaveLength(0) // 실패한 시도가 리스너를 남기지 않는다

    const preview = await svc.create('sid', taken)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.forward.exact).toBe(false)
    expect(preview.forward.localPort).not.toBe(taken)

    svc.stopAll()
    await new Promise<void>((r) => squatter.close(() => r()))
  })

  it('세션당 상한을 넘으면 거부한다', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    const svc = createForwardService(() => client)
    // 원격 포트 번호는 겹치지 않게, 로컬은 점유 여부와 무관하게 열린다(exact 아님).
    for (let i = 0; i < MAX_PER_SESSION; i++) {
      const r = await svc.create('sid', 40000 + i)
      expect(r.ok).toBe(true)
    }
    const over = await svc.create('sid', 40000 + MAX_PER_SESSION)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.reason).toBe('invalid')
    expect(svc.list()).toHaveLength(MAX_PER_SESSION)
    svc.stopAll()
  })

  it('세션 종료(stopSession)가 리스너를 닫고 목록을 비운다', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    const svc = createForwardService(() => client)
    const res = await svc.create('sid', 5555)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const port = res.forward.localPort
    expect(await reachable('127.0.0.1', port)).toBe(true)

    svc.stopSession('sid')
    expect(svc.list()).toHaveLength(0)
    expect(await reachable('127.0.0.1', port)).toBe(false)
  })

  it('세션이 죽은 뒤 들어온 소켓은 끊고 포워딩을 스스로 정리한다', async () => {
    harness = await startPasswordServer({ tcpipHandler: (_i, ch) => ch.end() })
    const client = await connectClient()
    let alive = true
    const svc = createForwardService(() => (alive ? client : null))
    const res = await svc.create('sid', 6006)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    alive = false // exit 훅을 놓친 상황을 흉내 낸다
    expect(await roundTrip(res.forward.localPort, 'x')).toBe('') // 응답 없이 끊긴다
    expect(svc.list()).toHaveLength(0)
  })
})
