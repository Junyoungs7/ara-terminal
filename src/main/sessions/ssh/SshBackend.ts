// SshBackend — ssh2 Client + shell() 채널을 SessionBackend로 감싼다 (원격 셸).
// 연결(auth·호스트키 검증)은 connectSsh()에서 끝나고, 준비된 Client+Channel을 여기서 스트림으로 흘린다.
import { readFile } from 'node:fs/promises'
import { isOpenSshSecurityKeyPrivateKey } from './securityKey'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { SessionBackend } from '../SessionBackend'
import type { Duplex } from 'node:stream'
import type { KnownHost, SshAuth, SshProfile } from '@shared/types'
import { fingerprintSha256, hostId, verifyHostKey } from './hostkey'
import { logMainError } from '../../log/MainErrorLog'
import { SHELL_PID_CMD, cwdLink, parseShellPid } from './remoteCwd'
import { parseJump, parseProxy, proxySocket, type JumpHop } from './sshRoute'
import { removeRemoteFiles, uploadPasteImage, type PasteResult } from './pasteImage'

// 출력이 이만큼 멎으면 프롬프트가 뜬 것으로 보고 CWD 를 한 번 읽는다(remoteCwd.ts 참조).
// 짧을수록 트리가 빨리 따라오지만, 명령 출력 중간중간 읽는 낭비가 는다.
const CWD_SETTLE_MS = 150

// 크기를 아무도 안 알려 줬을 때 셸을 여는 치수. SSH 관례값이고 **추정이 아니라 폴백**이다 —
// 부르는 쪽이 크기를 아는 경로(렌더러)는 deps.size 로 주고, 모르는 경로(MCP ssh_connect·접속
// 테스트)만 여기로 온다. 예전에는 이 둘이 구분되지 않아 아는 쪽도 80×24 로 열고 뒤따르는
// resize 로 따라잡았다(#158).
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

// 세션을 닫을 때 붙여넣기 임시 파일 지우기를 기다리는 최대 시간. 넘으면 그냥 끊는다.
const PASTE_CLEANUP_WAIT_MS = 3000

// ~ 확장(개인키 경로). Windows/유닉스 홈 모두 대응.
function expandHome(p: string): string {
  if (p.startsWith('~')) {
    const home = process.env['HOME'] || process.env['USERPROFILE'] || ''
    return home + p.slice(1)
  }
  return p
}

export type ConnectDeps = {
  knownHosts: Record<string, KnownHost>
  // secret = 비밀번호(password 인증) 또는 패스프레이즈(key 인증). null이면 없음.
  secret: string | null
  acceptHostKey: boolean // 최초 접속 확인 다이얼로그 통과 여부
  // 최초 접속 시 지문을 knownHosts에 기록하는 콜백(부수효과는 호출측이 소유).
  onHostKeyAccepted: (id: string, host: KnownHost) => void
  /**
   * #158 셸을 **아는 크기로 연다.** 주면 그 치수로 pty 를 요청하고, 안 주면 80×24 로 연다.
   *
   * 선택 인자인 것이 계약이다 — 부르는 쪽이 크기를 아는 경로와 모르는 경로가 둘 다 있다:
   *   · 렌더러(`ssh:connect`) — 새 세션은 **포커스 칸**에 뜨고 그 칸의 픽셀 상자는 이미 정해져
   *     있다. 지금 그 칸을 쓰고 있는 xterm 의 cols·rows 가 곧 새 세션의 치수다(termRegistry.sizeOf).
   *   · MCP `ssh_connect`·[접속 테스트] — 화면과 무관하게 부른다. 크기를 알 길이 없으므로
   *     **안 주고, 지금까지와 똑같이 동작한다.**
   * 어느 쪽이든 렌더러가 붙으면 `session:resize` 가 뒤따라 온다 — 이 값이 틀려도 곧 교정된다.
   */
  size?: { cols: number; rows: number }
  /**
   * M8 TM-01 점프 홉의 자격(같은 host:port 로 저장된 SSH 프로필 — registerSshIpc 가 ProfileStore 에서 찾는다).
   * null·미지정이면 대상 프로필이 키 인증일 때만 그 키를 빌린다(connectSshClient 주석).
   */
  hopCredentials?: (hop: JumpHop) => { auth: SshAuth; secret: string | null } | null
}

export type ConnectFailure =
  | { ok: false; reason: 'hostKeyNew'; hostId: string; algorithm: string; fingerprint: string }
  | { ok: false; reason: 'hostKeyMismatch'; hostId: string; algorithm: string; fingerprint: string; knownFingerprint: string }
  | { ok: false; reason: 'auth'; message: string }
  | { ok: false; reason: 'network'; message: string }

export type ConnectOutcome = { ok: true; backend: SshBackend } | ConnectFailure

/**
 * M8 R4: 관리형 서버가 빌린 연결 — 터미널 탭을 닫아도 셸만 닫고 연결은 남긴다. 연결은 탭이 아니라 호스트의 것(Orca SshConnectionManager:
 * 대상당 연결 하나, 탭을 닫아도 안 끊긴다). 그 연결 위의 원격 에이전트 탭이 같이 끊기지 않게. 끝내는 것은 빌린 쪽(managed closeAll).
 */
const held = new WeakSet<Client>()
export function holdClient(c: Client): void {
  held.add(c)
}

/** 셸 없이 **연결만**(M8: orcad·관리형 설치가 이 Client 위에 exec·sftp 채널을 연다). 끊을 때는 `client.end()` — 점프 홉·프록시 소켓도 같이 닫힌다. */
export type ClientOutcome = { ok: true; client: Client } | ConnectFailure

type Endpoint = { host: string; port: number; username: string; auth: SshAuth; secret: string | null; label: string; forwardAgent?: boolean }

/**
 * M15 R2 TM-05 SSH agent 포워딩에 빌려줄 이 PC 의 에이전트(Orca ssh-auth-resolution resolveDefaultAgentSocket 과 같은 순서):
 * SSH_AUTH_SOCK, 없으면 Windows 는 OpenSSH 에이전트 파이프. 없으면 undefined(포워딩 안 함 — 접속은 그대로).
 */
export function localAgentSocket(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  return env['SSH_AUTH_SOCK'] || (platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
}

// 인증 설정. 실패(개인키 못 읽음)는 문구로 돌려준다(호출측이 auth 사유로 낸다).
async function applyAuth(cfg: ConnectConfig, auth: SshAuth, secret: string | null): Promise<string | null> {
  if (auth.type === 'password') {
    cfg.password = secret ?? ''
    return null
  }
  try {
    cfg.privateKey = await readFile(expandHome(auth.keyPath))
  } catch (err) {
    return `개인키를 읽을 수 없습니다: ${(err as Error).message}`
  }
  // P3 R2-A TM-13: FIDO2 보안 키는 ssh2 가 서명하지 못한다 — 알 수 없는 오류 대신 이유를 말한다(securityKey.ts).
  if (isOpenSshSecurityKeyPrivateKey(cfg.privateKey as Buffer)) return 'FIDO2 보안 키(sk-*)는 아직 지원하지 않습니다 — 일반 키나 비밀번호를 쓰세요.'
  if (secret) cfg.passphrase = secret
  return null
}

/**
 * 한 홉 접속(인증·호스트키 TOFU 까지). sock 을 주면 TCP 대신 그 스트림 위로 붙는다(프록시·forwardOut).
 *
 * budget: `acceptHostKey` 는 **이번 시도에서 처음 만난 새 호스트키 하나만** 수락한다 — 사용자가 지문 창에서
 * 본 것이 그 하나뿐이기 때문이다. 점프 체인에서 홉과 대상이 둘 다 처음이면 첫 시도는 홉의 지문을 묻고,
 * 수락 후 재시도(홉은 이제 known)에서 대상의 지문을 또 묻는다. 한 번의 [신뢰]로 보지 않은 키까지 저장하지 않는다.
 */
async function dial(ep: Endpoint, deps: ConnectDeps, budget: { accept: number }, sock?: Duplex): Promise<ClientOutcome> {
  const id = hostId(ep.host, ep.port)

  // hostVerifier 콜백이 채우는 상태. hostKeyRejection은 "거부한 이유"만 담는다(수락 시 null).
  let hostKeyState: { fingerprint: string } | null = null
  let hostKeyRejection: ConnectFailure | null = null
  let negotiatedAlg = ''

  const cfg: ConnectConfig = {
    host: ep.host,
    port: ep.port,
    username: ep.username,
    ...(sock ? { sock: sock as ConnectConfig['sock'] } : {}),
    // 복원·재접속 시 죽은 호스트에서 무한 대기 금지 — 10초 내 미연결이면 network 실패로 반환.
    readyTimeout: 10_000,
    // R6: keepalive. 사내망 방화벽·NAT 는 유휴 SSH 세션을 조용히 끊는데, 그러면 다음 입력에서야
    // 죽은 것을 알게 된다. 15초마다 핑을 보내고 3회 무응답이면 즉시 끊어 재접속 경로로 보낸다
    // (설정 노출은 하지 않는다 — 만질 이유가 있는 값이 아니다).
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    // 호스트키 검증: 최초=사용자 확인 필요(차단), 불일치=차단, 일치=통과.
    hostVerifier: (keyDer: Buffer) => {
      const fp = fingerprintSha256(keyDer)
      hostKeyState = { fingerprint: fp }
      const verdict = verifyHostKey(deps.knownHosts, id, negotiatedAlg, fp)
      if (verdict.kind === 'known') return true
      if (verdict.kind === 'new') {
        if (deps.acceptHostKey && budget.accept > 0) {
          budget.accept--
          return true // 최초 접속 확인 완료 → 통과
        }
        hostKeyRejection = { ok: false, reason: 'hostKeyNew', hostId: id, algorithm: negotiatedAlg, fingerprint: fp }
        return false
      }
      // mismatch는 항상 차단(MITM 방지).
      hostKeyRejection = {
        ok: false,
        reason: 'hostKeyMismatch',
        hostId: id,
        algorithm: negotiatedAlg,
        fingerprint: fp,
        knownFingerprint: verdict.known.fingerprint
      }
      return false
    }
  }

  // M15 R2 TM-05: 켠 프로필의 대상에만(점프 홉엔 안 빌려준다). ssh2 는 이 연결의 모든 셸·exec 채널에 포워딩을 요청한다.
  // 에이전트를 주면 인증 후보에도 들어가지만 순서가 비밀번호·개인키 뒤라 지금 인증은 그대로다.
  const agent = ep.forwardAgent ? localAgentSocket() : undefined
  if (agent) {
    cfg.agent = agent
    cfg.agentForward = true
  }

  const authErr = await applyAuth(cfg, ep.auth, ep.secret)
  if (authErr) return { ok: false, reason: 'auth', message: ep.label + authErr }

  return await new Promise<ClientOutcome>((resolve) => {
    const client = new Client()
    let settled = false
    const done = (o: ClientOutcome) => {
      if (settled) return
      settled = true
      if (!o.ok) client.end()
      resolve(o)
    }

    // handshake는 hostVerifier 이후에 온다 → 협상된 호스트키 알고리즘 확보.
    client.on('handshake', (nego) => {
      negotiatedAlg = nego.serverHostKey
    })

    client.on('ready', () => {
      // 인증까지 성공(hostVerifier도 통과). 최초 접속이었다면 지문을 knownHosts에 기록.
      if (hostKeyState) {
        const verdict = verifyHostKey(deps.knownHosts, id, negotiatedAlg, hostKeyState.fingerprint)
        if (verdict.kind === 'new') {
          deps.onHostKeyAccepted(id, {
            algorithm: negotiatedAlg,
            fingerprint: hostKeyState.fingerprint,
            firstSeen: new Date().toISOString()
          })
        }
      }
      done({ ok: true, client })
    })

    client.on('error', (err: Error & { level?: string }) => {
      // 접속이 끝난 **뒤에** 오는 오류는 여기서 조용히 사라졌다(done 은 settled 면 아무것도 안 한다).
      // 그래서 세션이 왜 죽었는지가 어디에도 안 남았고, 화면에는 이유 없는 "연결이 끊겼습니다"만 떴다
      // (2026-08-27 준영님 제보 — "이건 끊길 일이 아닌데"). keepalive 시간초과·서버 종료·소켓 오류가
      // 전부 이 길로 온다: 이제 userData/logs/main-error.log 에 남는다.
      if (settled) {
        logMainError(`ssh:${ep.host}:${ep.port}`, err)
        return
      }
      // 호스트키 거부(hostVerifier=false)면 여기로 온다 → 저장해 둔 거부 이유를 그대로 반환.
      // (verifier가 통과한 뒤의 인증 실패는 hostKeyRejection이 null이므로 auth로 분기)
      if (hostKeyRejection) {
        // algorithm은 handshake 시점에 확정되므로 반환 직전 보정.
        const r = hostKeyRejection
        if ('algorithm' in r) r.algorithm = negotiatedAlg || r.algorithm
        done(r)
        return
      }
      const isAuth = err.level === 'client-authentication' || /authentication/i.test(err.message)
      done({ ok: false, reason: isAuth ? 'auth' : 'network', message: ep.label + err.message })
    })

    try {
      client.connect(cfg)
    } catch (err) {
      done({ ok: false, reason: 'network', message: ep.label + (err as Error).message })
    }
  })
}

function forwardOut(via: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    try {
      via.forwardOut('127.0.0.1', 0, host, port, (err, ch) =>
        err ? reject(new Error(`점프 채널 열기 실패(${host}:${port}): ${err.message}`)) : resolve(ch)
      )
    } catch (err) {
      reject(err as Error) // 이미 끊긴 Client 는 콜백 대신 동기로 던진다
    }
  })
}

/**
 * 프로필대로 **연결만** 한다: [프록시] → 점프 홉… → 대상. 각 홉은 앞 홉의 `forwardOut` 채널 위로 붙는다.
 * 대상 Client 가 닫히면 그 아래 홉·프록시 소켓도 닫는다(누가 끊든 한 줄로 정리된다).
 * 실패는 구조화된 결과로 반환(예외 던지지 않음) — 어느 홉에서 막혔는지는 message 머리 `[점프 …]` 로 붙는다.
 */
export async function connectSshClient(profile: SshProfile, deps: ConnectDeps): Promise<ClientOutcome> {
  const hops = parseJump(profile.jump, profile.username)
  if ('error' in hops) return { ok: false, reason: 'network', message: hops.error }
  const proxy = parseProxy(profile.proxy)
  if (proxy && 'error' in proxy) return { ok: false, reason: 'network', message: proxy.error }

  const route: Endpoint[] = []
  for (const h of hops) {
    // 같은 서버로 저장된 프로필이 없으면 이 프로필의 **키** 인증만 빌린다(OpenSSH 도 같은 IdentityFile 을 쓴다).
    // 비밀번호는 빌리지 않는다 — 대상의 비밀번호를 점프 서버에 보내는 셈이 된다.
    const cred = deps.hopCredentials?.(h) ?? (profile.auth.type === 'key' ? { auth: profile.auth, secret: deps.secret } : null)
    if (!cred) {
      return {
        ok: false,
        reason: 'auth',
        message: `점프 호스트 ${h.username}@${h.host}:${h.port} 의 자격 증명이 없습니다 — 그 서버를 SSH 프로필로 저장해 주세요.`
      }
    }
    route.push({ ...h, ...cred, label: `[점프 ${h.username}@${h.host}:${h.port}] ` })
  }
  route.push({ host: profile.host, port: profile.port, username: profile.username, auth: profile.auth, secret: deps.secret, label: '', forwardAgent: profile.forwardAgent === true })

  const up: Client[] = [] // 지금까지 붙은 홉들(실패·종료 시 걷는다)
  let proxySock: Duplex | null = null
  const teardown = (): void => {
    for (const c of up) c.end()
    proxySock?.destroy()
  }
  const budget = { accept: 1 }
  for (const [i, ep] of route.entries()) {
    let sock: Duplex | undefined
    try {
      if (i > 0) sock = await forwardOut(up[i - 1], ep.host, ep.port)
      else if (proxy) sock = proxySock = await proxySocket(proxy, ep.host, ep.port)
    } catch (err) {
      teardown()
      return { ok: false, reason: 'network', message: ep.label + (err as Error).message }
    }
    const r = await dial(ep, deps, budget, sock)
    if (!r.ok) {
      teardown()
      return r
    }
    up.push(r.client)
  }
  const client = up.pop()!
  if (up.length || proxySock) client.once('close', teardown)
  return { ok: true, client }
}

// ssh2로 연결(점프·프록시 포함)→호스트키 TOFU 검증→shell 채널을 연다. 실패는 구조화된 결과로 반환(예외 던지지 않음).
// W4sat F21: 호출측(registerSshIpc)이 profile.type==='ssh' 를 이미 확인했다 — rdp 는 여기 오지 않는다.
export async function connectSsh(profile: SshProfile, deps: ConnectDeps): Promise<ConnectOutcome> {
  const r = await connectSshClient(profile, deps)
  if (!r.ok) return r
  const client = r.client
  const cols = deps.size?.cols ?? FALLBACK_COLS
  const rows = deps.size?.rows ?? FALLBACK_ROWS
  return await new Promise<ConnectOutcome>((resolve) => {
    const fail = (why: string): void => {
      client.end()
      resolve({ ok: false, reason: 'network', message: `셸 채널 열기 실패: ${why}` })
    }
    try {
      // 3인자 형태로 부른다: `env` 를 창 옵션과 같은 객체에 넣으면 ssh2 가 그 객체를 통째로 opts 로
      // 해석해 **pty 요청의 term·크기가 사라진다**(ssh2 client.js shell() 의 인자 판별).
      client.shell({ term: 'xterm-256color', cols, rows }, {}, (err, channel) => {
        if (err) return fail(err.message)
        resolve({ ok: true, backend: new SshBackend(client, channel) })
      })
    } catch (err) {
      fail((err as Error).message)
    }
  })
}

export class SshBackend implements SessionBackend {
  constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel
  ) {
    // 셸 PID 는 커넥션이 살아 있는 동안 안 변한다 — 접속 직후 한 번만 찾는다.
    void this.findShellPid()
  }

  // ── 원격 CWD 추적(remoteCwd.ts 주석에 근거) ──
  // 터미널 채널로는 아무것도 안 보낸다. exec 로 셸 PID 를 한 번 찾고, 그 뒤로는 출력이 멎을 때마다
  // (= 프롬프트가 떴을 때) sftp readlink 로 /proc/<pid>/cwd 하나만 읽는다.
  private cwdCb: ((cwd: string) => void) | null = null
  private shellPid: number | null = null
  private cwdSftp: SFTPWrapper | null = null
  private cwdTimer: ReturnType<typeof setTimeout> | null = null
  private cwdBusy = false
  private lastCwd = ''
  private tracking = true

  // 추적 종료. 커넥션이 끊긴 뒤에도 타이머가 살아 있으면 ssh2 가 "Not connected" 를 **동기로 던져**
  // main 이 통째로 죽는다(실측) — 세션이 끝나는 모든 길목에서 여기를 지난다.
  private stopCwd(): void {
    this.tracking = false
    if (this.cwdTimer) {
      clearTimeout(this.cwdTimer)
      this.cwdTimer = null
    }
    this.cwdSftp = null
  }

  private findShellPid(): void {
    this.channel.on('close', () => this.stopCwd())
    let out = ''
    try {
      this.client.exec(SHELL_PID_CMD, (err, stream) => {
        if (err || !stream) {
          this.stopCwd()
          return
        }
        stream.on('data', (d: Buffer) => {
          out += d.toString('utf8')
        })
        stream.on('close', () => {
          this.shellPid = parseShellPid(out)
          // ps·$PPID 가 없는 원격(임베디드·fish 등)이면 여기서 조용히 포기한다 —
          // 파일 트리는 기존 "자동 동기 미지원" 안내대로 수동 이동만 된다.
          if (this.shellPid === null) this.stopCwd()
          else this.readCwd() // 로그인 디렉토리를 즉시 한 번 반영
        })
        stream.stderr.resume() // 안 읽으면 채널이 안 닫힌다
      })
    } catch {
      this.stopCwd() // 이미 끊긴 커넥션
    }
  }

  // 출력이 멎고 CWD_SETTLE_MS 지나면 한 번 읽는다. 출력이 계속 오면 계속 미뤄져 명령 실행 중에는 안 읽는다.
  private scheduleCwd(): void {
    if (!this.tracking || this.shellPid === null) return
    if (this.cwdTimer) clearTimeout(this.cwdTimer)
    this.cwdTimer = setTimeout(() => this.readCwd(), CWD_SETTLE_MS)
  }

  private readCwd(): void {
    if (!this.tracking || this.shellPid === null || this.cwdBusy) return
    this.cwdBusy = true
    this.withSftp((sftp) => {
      if (!sftp) {
        this.cwdBusy = false
        return
      }
      try {
        sftp.readlink(cwdLink(this.shellPid!), (err, target) => {
          this.cwdBusy = false
          if (err || !target) {
            // /proc 이 없거나(비리눅스) 셸이 이미 죽었다 — 반복해 봐야 소용없다.
            this.stopCwd()
            return
          }
          if (target !== this.lastCwd) {
            this.lastCwd = target
            this.cwdCb?.(target)
          }
        })
      } catch {
        this.cwdBusy = false
        this.stopCwd()
      }
    })
  }

  // sftp 채널 하나를 세션 내내 재사용한다(읽기마다 새로 열면 프롬프트마다 채널이 생겼다 사라진다).
  private withSftp(cb: (sftp: SFTPWrapper | null) => void): void {
    if (this.cwdSftp) return cb(this.cwdSftp)
    try {
      this.client.sftp((err, sftp) => {
        if (err || !sftp) {
          this.stopCwd()
          return cb(null)
        }
        this.cwdSftp = sftp
        sftp.on('close', () => {
          this.cwdSftp = null
        })
        cb(sftp)
      })
    } catch {
      // 끊긴 커넥션에서는 ssh2 가 콜백이 아니라 예외를 던진다.
      this.stopCwd()
      cb(null)
    }
  }

  onCwd(cb: (cwd: string) => void): void {
    this.cwdCb = cb
  }

  // F7: SFTP 서브시스템은 이 커넥션을 재사용한다(새 연결 금지, §C.0). 세션 매니저가 SftpService에 넘긴다.
  sshClient(): Client {
    return this.client
  }

  write(data: string): void {
    this.channel.write(data)
  }
  resize(cols: number, rows: number): void {
    try {
      this.channel.setWindow(rows, cols, 0, 0)
    } catch {
      /**
       * #158 **버려도 되는 이유**(2026-08-31 실측). 예전엔 "채널 종료 레이스: 무시" 한 줄이라
       * 왜 괜찮은지가 아무 데도 없었다.
       *
       * ① **보류할 상태가 없다.** SshBackend 는 **이미 열린 채널**로만 만들어진다
       *    (`done({ ok: true, backend: new SshBackend(client, channel) })`) — "아직 안 열림"이
       *    존재하지 않으므로 나중에 적용할 것을 쌓아 둘 이유가 없다. 남는 경우는 "이미 닫힘"뿐이고,
       *    닫힌 셸의 창 크기는 아무 의미가 없다.
       * ② **애초에 거의 던지지 않는다.** ssh2 의 `Channel.setWindow` 는 `writable &&
       *    outgoing.state === 'open'` 일 때만 패킷을 만든다(lib/Channel.js) — 닫힌 뒤에는 조용한
       *    no-op 다. 하네스로 `kill()` 후·상대가 끊은 후 둘 다 불러 봤고 **둘 다 안 던졌다.**
       * 그래도 남겨 두는 것은, 소켓만 먼저 죽고 채널 상태가 아직 open 인 찰나(RST)를 재현하지
       * 못했기 때문이다. 이 파일의 CWD 추적이 바로 그런 순간에 ssh2 가 **동기로 던져** main 을
       * 통째로 죽인 이력이 있다(stopCwd 주석) — 세 줄로 살 수 있는 보험이다.
       */
    }
  }
  pause(): void {
    this.channel.pause()
  }
  resume(): void {
    this.channel.resume()
  }
  // M8 herdr H10: 이 세션이 원격 임시 폴더에 올린 붙여넣기 이미지. 세션이 닫힐 때 지운다.
  private pasted: string[] = []

  /** 클립보드 이미지를 이 연결의 SFTP 로 올리고 경로를 돌려준다(성공한 것만 정리 목록에 담는다). */
  async pasteImage(bytes: Buffer, mime: string): Promise<PasteResult> {
    const r = await uploadPasteImage(this.client, bytes, mime)
    if (r.ok) this.pasted.push(r.path)
    return r
  }

  kill(): void {
    this.stopCwd()
    const end = (): void => {
      if (held.has(this.client)) return
      try {
        this.client.end()
      } catch {
        // 이미 종료: 무시.
      }
    }
    try {
      this.channel.end()
    } catch {
      // 이미 종료: 무시.
    }
    if (this.pasted.length === 0) return end()
    // 올린 이미지를 지우고 끊는다. 서버가 굼뜨면 기다리지 않는다 — 남은 것은 다음 업로드의 청소가 걷는다.
    const timer = setTimeout(end, PASTE_CLEANUP_WAIT_MS)
    void removeRemoteFiles(this.client, this.pasted.splice(0)).finally(() => {
      clearTimeout(timer)
      end()
    })
  }
  onData(cb: (data: string) => void): void {
    // stdout + stderr 모두 터미널로. Buffer → utf8 문자열.
    // 🔴 2026-10-08 오류 신고 #12("한글이 간헐적으로 깨진다"): 예전엔 청크마다 `d.toString('utf8')` 했다.
    //    SSH 패킷 경계는 UTF-8 글자를 가리지 않아 한글(3바이트)이 두 청크로 갈리면 양쪽이 U+FFFD(�)
    //    가 되고, 매니저는 그 깨진 **문자열**을 다시 바이트로 바꿀 뿐이라 되살릴 수 없었다("매니저
    //    배칭이 보존한다"던 옛 주석은 틀렸다). 스트림마다 StringDecoder 가 잘린 꼬리를 다음 청크로 넘긴다.
    //    stdout·stderr 는 따로 잘리므로 디코더도 따로다.
    // 여기서만 lastData 를 찍는다 — 별도 리스너를 달면 그 순간 스트림이 흐르기 시작해(flowing mode)
    // 매니저가 붙기 전 도착한 출력이 터미널에 안 보이고 사라진다.
    const tap = (dec: StringDecoder) => (d: Buffer) => {
      this.scheduleCwd()
      const s = dec.write(d)
      if (s) cb(s)
    }
    this.channel.on('data', tap(new StringDecoder('utf8')))
    this.channel.stderr.on('data', tap(new StringDecoder('utf8')))
  }
  onExit(cb: (exitCode: number, signal?: number) => void): void {
    // 둘 다 거는 이유: 셸이 스스로 끝나면 채널만 닫히고(`exit`), 네트워크가 끊기면 채널 close 없이
    // 커넥션만 닫힌다 — 한쪽만 보면 나머지 절반의 종료를 놓친다.
    //
    // 2026-08-28 감사 ⑤: 그런데 `exit` 을 치면 **둘 다** 발화한다(채널이 닫히고 곧이어 커넥션도
    // 닫힌다). 그러면 종료 하나가 session:exit 두 번이 되고, 눈에 보이는 결과가 둘이었다:
    //   · TerminalPane 이 `[프로세스 종료 — code N]` 을 두 줄 찍는다(그쪽엔 가드가 없다).
    //   · MainArea 의 closedByUser 는 **한 번 쓰면 지워지는 표시**라, 두 번째 호출은 "사용자가
    //     닫은 게 아니다"로 판정돼 방금 닫은 탭에 [재접속] 카드를 띄운다.
    // 종료는 한 번이다 — 먼저 온 쪽만 통과시킨다.
    let fired = false
    const once = (code: number): void => {
      if (fired) return
      fired = true
      cb(code)
    }
    this.channel.on('close', (code: number | null) => once(code ?? 0))
    this.client.on('close', () => once(0))
  }
}
