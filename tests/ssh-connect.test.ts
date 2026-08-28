// SSH 실접속 통합 검증 — node ssh2 서버 하네스에 실제로 접속해 파이프라인 전체를 실증한다.
// 검증: 호스트키 TOFU(최초 차단→수락 후 저장→불일치 차단), 비밀번호 인증, shell 한글 출력, 입력 에코.
import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { connectSsh, SshBackend } from '../src/main/sessions/ssh/SshBackend'
import { startPasswordServer, genHostKey, type Harness } from './ssh-harness'
import type { KnownHost, SshProfile } from '../src/shared/types'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'

let harness: Harness | null = null
afterEach(async () => {
  if (harness) await harness.close()
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

// backend 출력을 문자열로 모으는 헬퍼.
function drain(backend: SessionBackend): { text: () => string; onExit: Promise<void> } {
  let buf = ''
  backend.onData((d) => {
    buf += d
  })
  const onExit = new Promise<void>((res) => backend.onExit(() => res()))
  return { text: () => buf, onExit }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('SSH 실접속 (ssh2 하네스)', () => {
  it('최초 접속은 acceptHostKey 없이는 hostKeyNew로 차단된다(TOFU)', async () => {
    harness = await startPasswordServer()
    const knownHosts: Record<string, KnownHost> = {}
    const res = await connectSsh(pwProfile(harness.port), {
      knownHosts,
      secret: harness.password,
      acceptHostKey: false,
      onHostKeyAccepted: () => {}
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('hostKeyNew')
    // 차단되었으므로 knownHosts에 기록되지 않음.
    expect(Object.keys(knownHosts)).toHaveLength(0)
  })

  it('acceptHostKey=true면 접속 성공 + knownHosts에 지문 저장 + 한글 셸 출력 + 입력 에코', async () => {
    harness = await startPasswordServer()
    const knownHosts: Record<string, KnownHost> = {}
    const res = await connectSsh(pwProfile(harness.port), {
      knownHosts,
      secret: harness.password,
      acceptHostKey: true,
      onHostKeyAccepted: (id, host) => {
        knownHosts[id] = host
      }
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // 호스트키 저장 확인(완료조건: 최초 저장).
    const id = `127.0.0.1:${harness.port}`
    expect(knownHosts[id]).toBeDefined()
    expect(knownHosts[id].fingerprint.startsWith('SHA256:')).toBe(true)

    const d = drain(res.backend)
    await wait(300) // 배너 수신
    res.backend.write('안녕하세요 A.R.A\n') // 에코 라운드트립
    await wait(300)
    res.backend.kill()
    await Promise.race([d.onExit, wait(500)])

    const out = d.text()
    expect(out).toContain('A.R.A 원격 셸 준비 완료') // shell 한글 배너
    expect(out).toContain('안녕하세요 A.R.A') // 입력 에코(한글 무결)
  })

  it('이미 저장된 호스트키와 일치하면 acceptHostKey 없이 통과(known)', async () => {
    harness = await startPasswordServer()
    // 1차 접속으로 지문 확보.
    const knownHosts: Record<string, KnownHost> = {}
    const first = await connectSsh(pwProfile(harness.port), {
      knownHosts,
      secret: harness.password,
      acceptHostKey: true,
      onHostKeyAccepted: (id, host) => {
        knownHosts[id] = host
      }
    })
    expect(first.ok).toBe(true)
    if (first.ok) first.backend.kill()

    // 2차: knownHosts에 지문이 있으므로 acceptHostKey=false여도 통과.
    const second = await connectSsh(pwProfile(harness.port), {
      knownHosts,
      secret: harness.password,
      acceptHostKey: false,
      onHostKeyAccepted: () => {}
    })
    expect(second.ok).toBe(true)
    if (second.ok) second.backend.kill()
  })

  it('저장된 지문과 다른 호스트키면 연결 차단(hostKeyMismatch, MITM 방지)', async () => {
    harness = await startPasswordServer()
    const id = `127.0.0.1:${harness.port}`
    // 다른(가짜) 지문을 저장해 둠 → 실제 서버 호스트키와 불일치 상황 시뮬레이션.
    const knownHosts: Record<string, KnownHost> = {
      [id]: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:FAKE_FINGERPRINT_XXXX', firstSeen: 'past' }
    }
    const res = await connectSsh(pwProfile(harness.port), {
      knownHosts,
      secret: harness.password,
      acceptHostKey: true, // 수락해도 불일치는 항상 차단되어야 함.
      onHostKeyAccepted: () => {}
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('hostKeyMismatch')
      if (res.reason === 'hostKeyMismatch') expect(res.knownFingerprint).toBe('SHA256:FAKE_FINGERPRINT_XXXX')
    }
  })

  it('잘못된 비밀번호는 auth 실패로 구분된다', async () => {
    harness = await startPasswordServer({ password: 'correct-pw' })
    const res = await connectSsh(pwProfile(harness.port), {
      knownHosts: {},
      secret: 'WRONG-PW',
      acceptHostKey: true,
      onHostKeyAccepted: () => {}
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('auth')
  })

  it('연결 거부(포트에 서버 없음)는 network 오류', async () => {
    // 사용하지 않는 포트로 시도(즉시 ECONNREFUSED).
    const server = await startPasswordServer()
    const port = server.port
    await server.close() // 서버를 닫아 포트를 비움
    harness = null
    const res = await connectSsh(pwProfile(port), {
      knownHosts: {},
      secret: 'x',
      acceptHostKey: true,
      onHostKeyAccepted: () => {}
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('network')
  })

  it('genHostKey는 매번 다른 호스트키를 만든다(지문 변조 시나리오용)', () => {
    expect(genHostKey()).not.toBe(genHostKey())
  })
})

// 2026-08-28 감사 ⑤ 회귀 가드.
//
// onExit 은 채널 close 와 커넥션 close **양쪽**에 걸려 있다(한쪽만 보면 절반을 놓친다: 셸이 스스로
// 끝나면 채널만 닫히고, 네트워크가 끊기면 채널 close 없이 커넥션만 닫힌다). 문제는 사용자가 `exit`
// 을 쳤을 때다 — 채널이 닫히고 곧이어 커넥션도 닫혀 **둘 다** 온다. 예전엔 그대로 두 번 흘러나가
// 터미널에 `[프로세스 종료]` 가 두 줄 찍히고(TerminalPane 에 가드가 없다), MainArea 의 "사용자가
// 닫았다" 표시는 한 번 쓰면 지워지는 값이라 두 번째 호출이 방금 닫은 탭에 [재접속] 카드를 띄웠다.
//
// 하네스로는 이 상황을 만들 수 없다: ssh2 루프백 서버는 셸 채널을 스스로 닫지 않아서 `kill()` 로도
// `dropAll()` 로도 **커넥션 close 하나만** 온다(실측). 그래서 두 이벤트를 직접 쏘는 가짜로 건다 —
// 검사 대상은 "close 두 번 → 콜백 한 번"이라는 래치 하나뿐이다.
describe('SshBackend.onExit 래치', () => {
  const fakePair = (): { client: EventEmitter; channel: EventEmitter; backend: SshBackend } => {
    const client = new EventEmitter()
    const channel = new EventEmitter()
    // 생성자가 셸 PID 를 찾으려 exec 를 부른다. 없으면 던지고 SshBackend 가 삼켜(=추적 포기)
    // 나머지는 그대로 동작한다 — 이 검사는 CWD 추적과 무관하다.
    return { client, channel, backend: new SshBackend(client as never, channel as never) }
  }

  it('채널과 커넥션이 둘 다 닫혀도 콜백은 한 번뿐이다(`exit` 을 친 경우)', () => {
    const { client, channel, backend } = fakePair()
    const codes: number[] = []
    backend.onExit((code) => codes.push(code))
    channel.emit('close', 0)
    client.emit('close')
    expect(codes).toEqual([0]) // 래치가 없으면 [0, 0] 이다
  })

  it('커넥션만 닫혀도(네트워크 끊김) 종료를 놓치지 않는다', () => {
    const { client, backend } = fakePair()
    const codes: number[] = []
    backend.onExit((code) => codes.push(code))
    client.emit('close')
    expect(codes).toEqual([0])
  })

  it('채널이 준 종료코드를 그대로 넘긴다(먼저 온 쪽이 이긴다)', () => {
    const { client, channel, backend } = fakePair()
    const codes: number[] = []
    backend.onExit((code) => codes.push(code))
    channel.emit('close', 130) // Ctrl+C 로 끝난 셸
    client.emit('close') // 뒤따라오는 커넥션 close 는 0 으로 덮어쓰지 않는다
    expect(codes).toEqual([130])
  })
})
