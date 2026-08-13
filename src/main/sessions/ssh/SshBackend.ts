// SshBackend — ssh2 Client + shell() 채널을 SessionBackend로 감싼다 (원격 셸).
// 연결(auth·호스트키 검증)은 connectSsh()에서 끝나고, 준비된 Client+Channel을 여기서 스트림으로 흘린다.
import { readFile } from 'node:fs/promises'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { SessionBackend } from '../SessionBackend'
import type { KnownHost, SshProfile } from '@shared/types'
import { fingerprintSha256, hostId, verifyHostKey } from './hostkey'
import { SHELL_PID_CMD, cwdLink, parseShellPid } from './remoteCwd'

// 출력이 이만큼 멎으면 프롬프트가 뜬 것으로 보고 CWD 를 한 번 읽는다(remoteCwd.ts 참조).
// 짧을수록 트리가 빨리 따라오지만, 명령 출력 중간중간 읽는 낭비가 는다.
const CWD_SETTLE_MS = 150

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
}

export type ConnectOutcome =
  | { ok: true; backend: SshBackend }
  | { ok: false; reason: 'hostKeyNew'; hostId: string; algorithm: string; fingerprint: string }
  | { ok: false; reason: 'hostKeyMismatch'; hostId: string; algorithm: string; fingerprint: string; knownFingerprint: string }
  | { ok: false; reason: 'auth'; message: string }
  | { ok: false; reason: 'network'; message: string }

// ssh2로 연결→호스트키 TOFU 검증→shell 채널을 연다. 실패는 구조화된 결과로 반환(예외 던지지 않음).
// W4sat F21: 호출측(registerSshIpc)이 profile.type==='ssh' 를 이미 확인했다 — rdp 는 여기 오지 않는다.
export async function connectSsh(profile: SshProfile, deps: ConnectDeps): Promise<ConnectOutcome> {
  const id = hostId(profile.host, profile.port)

  // hostVerifier 콜백이 채우는 상태. hostKeyRejection은 "거부한 이유"만 담는다(수락 시 null).
  let hostKeyState: { fingerprint: string } | null = null
  let hostKeyRejection: ConnectOutcome | null = null
  let negotiatedAlg = ''

  const cfg: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
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
        if (deps.acceptHostKey) return true // 최초 접속 확인 완료 → 통과
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

  if (profile.auth.type === 'password') {
    cfg.password = deps.secret ?? ''
  } else {
    // key 인증: 개인키 파일 읽기 + (있으면) 패스프레이즈.
    try {
      cfg.privateKey = await readFile(expandHome(profile.auth.keyPath))
    } catch (err) {
      return { ok: false, reason: 'auth', message: `개인키를 읽을 수 없습니다: ${(err as Error).message}` }
    }
    if (deps.secret) cfg.passphrase = deps.secret
  }

  return await new Promise<ConnectOutcome>((resolve) => {
    const client = new Client()
    let settled = false
    const done = (o: ConnectOutcome) => {
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
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, channel) => {
        if (err) {
          done({ ok: false, reason: 'network', message: `셸 채널 열기 실패: ${err.message}` })
          return
        }
        done({ ok: true, backend: new SshBackend(client, channel) })
      })
    })

    client.on('error', (err: Error & { level?: string }) => {
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
      done({ ok: false, reason: isAuth ? 'auth' : 'network', message: err.message })
    })

    try {
      client.connect(cfg)
    } catch (err) {
      done({ ok: false, reason: 'network', message: (err as Error).message })
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
      // 채널 종료 레이스: 무시.
    }
  }
  pause(): void {
    this.channel.pause()
  }
  resume(): void {
    this.channel.resume()
  }
  kill(): void {
    this.stopCwd()
    try {
      this.channel.end()
      this.client.end()
    } catch {
      // 이미 종료: 무시.
    }
  }
  onData(cb: (data: string) => void): void {
    // stdout + stderr 모두 터미널로. Buffer → utf8 문자열(멀티바이트 경계는 매니저 배칭이 바이트로 보존).
    // 여기서만 lastData 를 찍는다 — 별도 리스너를 달면 그 순간 스트림이 흐르기 시작해(flowing mode)
    // 매니저가 붙기 전 도착한 출력이 터미널에 안 보이고 사라진다.
    const tap = (d: Buffer) => {
      this.scheduleCwd()
      cb(d.toString('utf8'))
    }
    this.channel.on('data', tap)
    this.channel.stderr.on('data', tap)
  }
  onExit(cb: (exitCode: number, signal?: number) => void): void {
    this.channel.on('close', (code: number | null) => cb(code ?? 0))
    this.client.on('close', () => cb(0))
  }
}
