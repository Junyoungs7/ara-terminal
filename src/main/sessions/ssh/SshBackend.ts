// SshBackend — ssh2 Client + shell() 채널을 SessionBackend로 감싼다 (원격 셸).
// 연결(auth·호스트키 검증)은 connectSsh()에서 끝나고, 준비된 Client+Channel을 여기서 스트림으로 흘린다.
import { readFile } from 'node:fs/promises'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { SessionBackend } from '../SessionBackend'
import type { KnownHost, SshProfile } from '@shared/types'
import { fingerprintSha256, hostId, verifyHostKey } from './hostkey'
import { logMainError } from '../../log/MainErrorLog'
import { SHELL_PID_CMD, cwdLink, parseShellPid, ttyLink } from './remoteCwd'
import type { HookSink } from '../../agent/AgentHookServer'
import { prepareRemoteHooks } from '../../agent/remoteHooks'
import { buildRemoteAiCommand, type AiCommand } from '@shared/aiCli'

// 출력이 이만큼 멎으면 프롬프트가 뜬 것으로 보고 CWD 를 한 번 읽는다(remoteCwd.ts 참조).
// 짧을수록 트리가 빨리 따라오지만, 명령 출력 중간중간 읽는 낭비가 는다.
const CWD_SETTLE_MS = 150

// 크기를 아무도 안 알려 줬을 때 셸을 여는 치수. SSH 관례값이고 **추정이 아니라 폴백**이다 —
// 부르는 쪽이 크기를 아는 경로(렌더러)는 deps.size 로 주고, 모르는 경로(MCP ssh_connect·접속
// 테스트)만 여기로 온다. 예전에는 이 둘이 구분되지 않아 아는 쪽도 80×24 로 열고 뒤따르는
// resize 로 따라잡았다(#158).
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

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
   * F1b 원격 훅. 주면 **셸을 열기 전에** 역터널을 열고 원격 `~/.claude/settings.json` 을 병합한 뒤,
   * 그 결과 env(`ARA_HOOK_PORT`·`ARA_PANE`)를 셸 요청에 실어 보낸다.
   *
   * paneId 는 **세션 id 를 미리 받은 것**이다 — 셸이 열린 뒤에 정해지면 env 에 실을 수 없다
   * (그래서 `MainSessionManager.adopt` 가 id 를 받는다. 로컬은 `create` 가 같은 이유로 id 를 먼저 만든다).
   * 안 주면 이 커넥션은 훅 없이 열린다(접속 테스트 경로가 그렇다).
   */
  hooks?: { sink: HookSink; paneId: string }
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
   * D(#168) **셸 대신 이 CLI 를 그 채널의 프로세스로 연다**(AI 세션 전용).
   *
   * ⚠️ 여기만 `exec` 채널이다. F1b 는 **일부러** exec 로 가지 않았다 — `ForceCommand` 나
   * `PermitTTY no` 인 서버에서 exec 가 거절되면 그날부터 **모든 SSH 탭이 안 열린다.** 그 값이
   * 달라서 여기서는 간다: 이 채널은 "AI 를 띄운다" 하나뿐이라, 거절당해도 **그 한 번**이 실패하고
   * 사용자의 셸 탭은 지금까지와 똑같이 `client.shell()` 로 열린다. 기존 경로는 한 줄도 안 바뀐다.
   */
  aiCommand?: { argv: AiCommand; cwd: string }
}

/**
 * D(#168) AI 채널만 훅 설치가 끝나기를 기다리는 상한.
 *
 * 셸은 안 기다린다(remoteHooks.ts 주석 — 사용자가 `claude` 를 치는 것은 한참 뒤다). 여기서는
 * **우리가 그 순간을 정한다**: claude 는 뜰 때 `settings.json` 을 한 번 읽으므로, 아직 안 심긴
 * 채로 띄우면 그 세션은 훅이 없어 [AI] 목록에 안 뜬다 — 이 기능이 원한 것의 정반대다.
 * 두 번째 접속부터는 파일이 이미 같아 왕복 없이 즉시 끝난다(planHooks 의 `next === null`).
 * 상한에 닿으면 그냥 띄운다 — 탭이 영영 안 열리는 것이 더 나쁘다.
 */
const HOOK_INSTALL_WAIT_MS = 3000

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

    // F1b: 훅 준비는 **셸을 열기 전에** 끝나야 한다 — env 는 셸 요청에 함께 실려 가므로 셸이 먼저
    // 뜨면 그 탭에서 도는 claude 는 갈 곳을 모른다(F1a 가 창보다 먼저 포트를 잡는 것과 같은 순서).
    // 준비가 실패해도 셸은 연다: 훅은 있으면 좋은 것이지 접속의 조건이 아니다.
    const openShell = async (): Promise<void> => {
      let env: Record<string, string> | null = null
      // #162 셸이 뜬 뒤에 그 셸의 tty 를 알려 줄 자리. env 를 버리는 sshd 에서 훅이 자기를 찾는 길이다.
      let onTty: ((tty: string) => void) | undefined
      if (deps.hooks) {
        try {
          const prep = await prepareRemoteHooks(client, deps.hooks.sink, deps.hooks.paneId, profile.name || profile.host)
          env = prep?.env ?? null
          onTty = prep?.publish
          // D(#168) AI 채널만 설치를 기다린다(HOOK_INSTALL_WAIT_MS 주석의 이유).
          if (deps.aiCommand && prep) {
            await Promise.race([prep.installed, new Promise((r) => setTimeout(r, HOOK_INSTALL_WAIT_MS))])
          }
          void prep?.installed.then((r) => {
            // 설치 실패는 접속을 막지 않는다 — 대신 조용히 사라지지도 않게 남긴다(왜 상태가
            // 안 뜨는지 물어볼 사람이 있다). `skipped` 는 실패가 아니라 **안 한 것**이라 안 남긴다
            // (claude 없는 서버가 대부분이고, 그때마다 로그를 쌓으면 로그가 곧 소음이다).
            if (!r.ok && r.reason !== 'skipped') logMainError(`agent hook install:${profile.host}`, new Error(r.message))
          })
        } catch (e) {
          logMainError(`agent hook prepare:${profile.host}`, e)
        }
      }
      // 3인자 형태로 부른다: `env` 를 창 옵션과 같은 객체에 넣으면 ssh2 가 그 객체를 통째로 opts 로
      // 해석해 **pty 요청의 term·크기가 사라진다**(ssh2 client.js shell() 의 인자 판별).
      const cols = deps.size?.cols ?? FALLBACK_COLS
      const rows = deps.size?.rows ?? FALLBACK_ROWS
      // D(#168) AI 세션 — 셸이 아니라 이 명령이 그 채널의 프로세스다. **pty 를 함께 요청한다**:
      // 그래야 CLI 가 TUI 로 뜨고, sshd 가 `SSH_TTY` 를 넣어 주며(#162 폴백 파일이 그 이름을 쓴다)
      // `/proc/<pid>/fd/0` 도 그 tty 를 가리킨다 — 즉 아래 findShellPid·publish 가 셸 때와 똑같이 돈다.
      if (deps.aiCommand) {
        const line = buildRemoteAiCommand(deps.aiCommand.argv, deps.aiCommand.cwd)
        if (line === null) {
          done({ ok: false, reason: 'network', message: '실행할 수 없는 AI 명령입니다.' })
          return
        }
        client.exec(line, { pty: { term: 'xterm-256color', cols, rows }, ...(env ? { env } : {}) }, (err, channel) => {
          if (err) {
            // 여기서 실패해도 잃는 것은 이 한 번이다(ConnectDeps.aiCommand 주석) — 사용자의 셸 탭은
            // 이 길을 지나지 않는다. 사유를 그대로 올려 무엇이 거절했는지 보이게 한다.
            done({ ok: false, reason: 'network', message: `AI 채널 열기 실패: ${err.message}` })
            return
          }
          done({ ok: true, backend: new SshBackend(client, channel, onTty) })
        })
        return
      }
      client.shell({ term: 'xterm-256color', cols, rows }, env ? { env } : {}, (err, channel) => {
        if (err) {
          done({ ok: false, reason: 'network', message: `셸 채널 열기 실패: ${err.message}` })
          return
        }
        done({ ok: true, backend: new SshBackend(client, channel, onTty) })
      })
    }

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
      void openShell()
    })

    client.on('error', (err: Error & { level?: string }) => {
      // 접속이 끝난 **뒤에** 오는 오류는 여기서 조용히 사라졌다(done 은 settled 면 아무것도 안 한다).
      // 그래서 세션이 왜 죽었는지가 어디에도 안 남았고, 화면에는 이유 없는 "연결이 끊겼습니다"만 떴다
      // (2026-08-27 준영님 제보 — "이건 끊길 일이 아닌데"). keepalive 시간초과·서버 종료·소켓 오류가
      // 전부 이 길로 온다: 이제 userData/logs/main-error.log 에 남는다.
      if (settled) {
        logMainError(`ssh:${profile.host}:${profile.port}`, err)
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
    private readonly channel: ClientChannel,
    /**
     * #162 이 셸의 tty 를 한 번 알려 준다(못 알아내면 빈 문자열 — 그것도 답이라 반드시 부른다).
     * 원격 훅이 그 이름으로 폴백 파일을 놓는다. 안 주면 tty 를 읽지 않는다(접속 테스트 경로).
     */
    private readonly onTty?: (tty: string) => void
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
    // #162 포기도 결과다. 여기를 안 지나는 포기 경로가 없으므로(위 주석) 한 자리에서 알린다 —
    // 안 알리면 설정 화면이 그 서버를 영영 "확인 중"으로 둔다.
    this.emitTty('')
  }

  // #162 tty 는 세션당 한 번만 알린다. 못 알아낸 경우(빈 문자열)도 한 번이다.
  private ttySent = false
  private emitTty(tty: string): void {
    if (this.ttySent || !this.onTty) return
    this.ttySent = true
    this.onTty(tty)
  }

  /**
   * #162 셸 PID 를 찾은 직후, **같은 sftp 채널로** tty 와 cwd 를 잇달아 읽는다.
   * 따로 부르면 두 채널이 열린다(첫 `withSftp` 가 아직 돌아오기 전에 두 번째가 또 연다).
   */
  private readShellLinks(): void {
    if (!this.onTty) {
      this.readCwd()
      return
    }
    this.withSftp((sftp) => {
      if (!sftp) return // withSftp 가 이미 stopCwd → emitTty('')
      try {
        sftp.readlink(ttyLink(this.shellPid!), (err, target) => {
          this.emitTty(err || !target ? '' : target)
          this.readCwd()
        })
      } catch {
        this.stopCwd()
      }
    })
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
          else this.readShellLinks() // tty(#162) 한 번 + 로그인 디렉토리를 즉시 한 번 반영
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
