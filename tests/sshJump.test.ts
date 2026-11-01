// M8 TM-01 점프 호스트 경유 접속 + herdr H10 붙여넣기 이미지 업로드·정리 — ssh2 하네스 둘(점프 → 대상)로 실증.
// 전부 127.0.0.1 임시 포트다. 실제 서버·사내 서버에 붙지 않는다.
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSsh, type ConnectDeps } from '../src/main/sessions/ssh/SshBackend'
import { startPasswordServer, type Harness } from './ssh-harness'
import type { KnownHost, SshProfile } from '../src/shared/types'

let harnesses: Harness[] = []
let servers: net.Server[] = []
let dirs: string[] = []
afterEach(async () => {
  for (const h of harnesses) await h.close()
  for (const s of servers) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  harnesses = []
  servers = []
  dirs = []
})

// 점프 서버: direct-tcpip 를 받아 실제 TCP 로 대상까지 잇는다(sshd 의 AllowTcpForwarding 과 같다).
async function startJump(password = 'jumppw'): Promise<{ h: Harness; opened: { destPort: number }[] }> {
  const opened: { destPort: number }[] = []
  const h = await startPasswordServer({
    password,
    tcpipHandler: (info, ch) => {
      opened.push({ destPort: info.destPort })
      const s = net.connect(info.destPort, info.destIP)
      ch.pipe(s).pipe(ch)
      s.on('error', () => ch.close())
      ch.on('close', () => s.destroy())
    }
  })
  harnesses.push(h)
  return { h, opened }
}

function target(port: number, jump: string, extra: Partial<SshProfile> = {}): SshProfile {
  return {
    id: 't',
    type: 'ssh',
    name: 'target',
    host: '127.0.0.1',
    port,
    username: 'tester',
    auth: { type: 'password', secretRef: { store: 'vault', key: 't' } },
    jump,
    ...extra
  }
}

function deps(known: Record<string, KnownHost>, secret: string, jumpPw: string | null, accept = true): ConnectDeps {
  return {
    knownHosts: known,
    secret,
    acceptHostKey: accept,
    onHostKeyAccepted: (id, host) => {
      known[id] = host
    },
    hopCredentials: () => (jumpPw === null ? null : { auth: { type: 'password', secretRef: { store: 'vault', key: 'j' } }, secret: jumpPw })
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('점프 호스트 경유 접속 (하네스 둘)', () => {
  it('점프 → 대상으로 셸이 열리고, 호스트키는 한 번에 하나씩 묻는다', async () => {
    const { h: jump, opened } = await startJump()
    const tgt = await startPasswordServer()
    harnesses.push(tgt)
    const known: Record<string, KnownHost> = {}
    const prof = target(tgt.port, `jumper@127.0.0.1:${jump.port}`)

    // ① 아무것도 모름 → 점프의 지문을 묻는다
    const r1 = await connectSsh(prof, deps(known, tgt.password, 'jumppw', false))
    expect(r1.ok).toBe(false)
    if (!r1.ok && r1.reason === 'hostKeyNew') expect(r1.hostId).toBe(`127.0.0.1:${jump.port}`)
    else throw new Error('hostKeyNew 기대')

    // ② [신뢰] 후 재시도 → 점프는 저장되고, 이번엔 **대상**의 지문을 묻는다(한 번의 수락이 둘을 넘기지 않는다)
    const r2 = await connectSsh(prof, deps(known, tgt.password, 'jumppw', true))
    expect(r2.ok).toBe(false)
    if (!r2.ok && r2.reason === 'hostKeyNew') expect(r2.hostId).toBe(`127.0.0.1:${tgt.port}`)
    else throw new Error('대상 hostKeyNew 기대')
    expect(Object.keys(known)).toEqual([`127.0.0.1:${jump.port}`])

    // ③ 다시 [신뢰] → 접속. 대상 TCP 는 점프 서버가 열었다(직접 붙지 않았다)
    const r3 = await connectSsh(prof, deps(known, tgt.password, 'jumppw', true))
    expect(r3.ok).toBe(true)
    if (!r3.ok) return
    expect(opened.some((o) => o.destPort === tgt.port)).toBe(true)
    let out = ''
    r3.backend.onData((d) => (out += d))
    r3.backend.write('hello-jump\r')
    for (let i = 0; i < 40 && !out.includes('hello-jump'); i++) await wait(50)
    expect(out).toContain('A.R.A 원격 셸 준비 완료')
    expect(out).toContain('hello-jump')

    // 끊기(대상이 닫히면 connectSshClient 의 teardown 이 점프 연결도 닫는다)
    const exited = new Promise<void>((res) => r3.backend.onExit(() => res()))
    r3.backend.kill()
    await exited
  })

  it('점프 자격이 없고 대상이 비밀번호 인증이면 비밀번호를 점프 서버에 보내지 않는다', async () => {
    const { h: jump } = await startJump()
    const r = await connectSsh(target(1, `127.0.0.1:${jump.port}`), deps({}, 'secret', null))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('auth')
  })

  it('점프 인증 실패는 어느 홉인지 말한다', async () => {
    const { h: jump } = await startJump()
    const r = await connectSsh(target(1, `jumper@127.0.0.1:${jump.port}`), deps({}, 'x', 'wrong'))
    expect(r.ok).toBe(false)
    if (!r.ok && 'message' in r) expect(r.message).toContain('[점프 jumper@127.0.0.1')
  })

  it('SOCKS5 프록시 → 점프 → 대상', async () => {
    const { h: jump } = await startJump()
    const tgt = await startPasswordServer()
    harnesses.push(tgt)
    // 최소 SOCKS5(인증 없음, 도메인/IPv4 CONNECT) — 로컬 전용 가짜.
    let proxied = 0
    const srv = net.createServer((c) => {
      c.once('data', () => {
        c.write(Buffer.from([5, 0]))
        c.once('data', (d: Buffer) => {
          const host = d[3] === 3 ? d.subarray(5, 5 + d[4]).toString() : [...d.subarray(4, 8)].join('.')
          const port = d.readUInt16BE(d.length - 2)
          const up = net.connect(port, host, () => {
            proxied++
            c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            c.pipe(up).pipe(c)
          })
          up.on('error', () => c.destroy())
        })
      })
    })
    servers.push(srv)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const pport = (srv.address() as AddressInfo).port
    const prof = target(tgt.port, `jumper@127.0.0.1:${jump.port}`, { proxy: `socks5://127.0.0.1:${pport}` })
    const known: Record<string, KnownHost> = {}
    await connectSsh(prof, deps(known, tgt.password, 'jumppw')) // 점프 지문 수락
    await connectSsh(prof, deps(known, tgt.password, 'jumppw')) // 대상 지문 수락
    const r = await connectSsh(prof, deps(known, tgt.password, 'jumppw'))
    expect(r.ok).toBe(true)
    expect(proxied).toBeGreaterThanOrEqual(1)
    if (r.ok) r.backend.kill()
  })
})

describe('클립보드 이미지 → 원격 붙여넣기 (sftp 하네스)', () => {
  it('원격 홈 아래 .ara-paste 에 올리고 경로를 돌려준다 · 세션을 닫으면 지운다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ara-paste-'))
    dirs.push(root)
    const tgt = await startPasswordServer({ sftpRoot: root })
    harnesses.push(tgt)
    const known: Record<string, KnownHost> = {}
    const prof: SshProfile = { ...target(tgt.port, ''), jump: undefined }
    const r = await connectSsh(prof, deps(known, tgt.password, null))
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const up = await r.backend.pasteImage(png, 'image/png')
    expect(up.ok).toBe(true)
    if (!up.ok) return
    expect(up.path).toMatch(/^\/\.ara-paste\/paste-\d{8}-\d{6}-[0-9a-f]{4}\.png$/)
    const local = join(root, up.path)
    expect(readFileSync(local)).toEqual(png)

    // 상한·형식은 서버에 가기 전에 막는다
    expect((await r.backend.pasteImage(Buffer.alloc(0), 'image/png')).ok).toBe(false)
    expect((await r.backend.pasteImage(png, 'application/pdf')).ok).toBe(false)

    const exited = new Promise<void>((res) => r.backend.onExit(() => res()))
    r.backend.kill()
    await exited
    for (let i = 0; i < 40 && existsSync(join(root, '.ara-paste')); i++) await wait(50)
    expect(existsSync(local)).toBe(false)
    expect(readdirSync(root)).toEqual([]) // 폴더까지 걷혔다 — 흔적 0
  })
})
