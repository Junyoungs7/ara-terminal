// node ssh2 서버 하네스 — 실제 sshd 없이 SSH 접속 파이프라인을 실증한다.
// 비밀번호/키 인증을 받고, shell 채널에서 입력을 에코하는 최소 서버. 호스트키는 테스트용 ed25519.
// F7: sftp 서브시스템 지원(임시 디렉토리를 원격 루트로 노출) — list/download/upload/취소 실증.
import { Server, utils } from 'ssh2'
import type { Connection, ServerChannel } from 'ssh2'
import type { AddressInfo } from 'node:net'
import { serveSftp } from './sftp-harness'

const SFTP_NO_SUCH_FILE = utils.sftp.STATUS_CODE.NO_SUCH_FILE

// 테스트용 서버 호스트키 생성(ed25519). 매 인스턴스 새로 발급 → 지문도 매번 다름.
//
// ssh2 의 ed25519 생성기는 드물게 **자기 파서가 거부하는** PEM 을 내놓는다. 그러면 하네스가
// `new Server({hostKeys})` 에서 "Malformed OpenSSH private key" 로 죽어 관계없는 테스트가 붉어진다
// (W1 때는 워커 동시 실행 탓으로 보고 스위트를 단일 fork 로 격리했지만, 단일 fork 안에서도 재현된다 —
// 원인은 동시성이 아니라 생성기다). 만든 즉시 같은 파서로 검증하고 거부되면 다시 만든다.
export function genHostKey(): string {
  for (let i = 0; i < 8; i++) {
    const pem = utils.generateKeyPairSync('ed25519').private
    if (!(utils.parseKey(pem) instanceof Error)) return pem
  }
  throw new Error('ed25519 호스트키 생성 실패 — ssh2 파서가 8회 연속 거부했다')
}

export type Harness = {
  port: number
  hostKeyPem: string
  password: string
  close: () => Promise<void>
  /**
   * **이미 붙어 있는 연결을 끊는다.** `close()` 는 새 연결만 막고 살아 있는 연결은 그대로 두므로
   * (Node 의 기본 동작) "쓰던 중에 끊겼다"를 만들 수 없다 — 그 상황이 필요한 검사는 이걸 쓴다.
   * 서버는 계속 살아 있어 재접속 검사를 이어서 할 수 있다.
   */
  dropAll: () => void
}

// 비밀번호 인증 SSH 서버를 임시 포트에 띄운다. shell 채널은 받은 입력을 그대로 에코한다.
// F7: sftpRoot 를 주면 sftp 서브시스템이 그 디렉토리를 원격 파일시스템으로 노출한다.
export async function startPasswordServer(opts?: {
  password?: string
  hostKeyPem?: string
  sftpRoot?: string
  // F7: shell 이 `cd <path>` 입력을 받으면 그 경로로 OSC7 을 방출한다(터미널→트리 자동 이동 실증용).
  emitOsc7OnCd?: boolean
  // FB-0007①: 실제 bash 의 PROMPT_COMMAND 훅을 흉내낸다 — SHELL_INTEGRATION.ssh 주입(마커: "PROMPT_COMMAND")
  // 이 오기 전에는 OSC7 을 절대 안 내고(주입 전 버그 상태 재현), 온 뒤로는 cd 여부와 무관하게 매 줄(Enter)
  // 끝마다 OSC7 을 낸다(PROMPT_COMMAND 는 프롬프트를 그릴 때마다 도는 훅이다 — emitOsc7OnCd 처럼 cd 만
  // 특수 취급하지 않는다, 그래야 "SshBackend 의 주입이 실제로 셸을 깨웠다"를 증명한다).
  simulateBashPrompt?: boolean
  // T1: 같은 포트로 서버를 되살릴 때만 지정한다(복원 재시도 시나리오 — knownHosts 키가 host:port 라
  // 포트가 바뀌면 재접속이 "처음 보는 호스트키"가 된다). 기본은 0(임의 포트).
  port?: number
  // W1: exec 채널(텔레메트리 폴링 명령 · tail 스트림). 주지 않으면 exec 요청을 받지 않는다
  // — 기존 테스트 동작은 그대로다. 핸들러가 스트림 종료(exit/end)까지 책임진다.
  execHandler?: (command: string, stream: ServerChannel) => void
  // T2: shell 채널로 실제로 들어온 raw 입력 관측(Tab·ESC 가 앱에 먹히지 않고 셸까지 갔는지).
  // 에코 동작은 그대로다 — 보기만 한다.
  onShellData?: (data: string) => void
  // W2 F8: direct-tcpip(로컬 포워딩) 채널. 주지 않으면 요청을 거절한다 — 기존 테스트 동작 불변.
  // 핸들러가 채널의 수명을 책임진다(에코 서버 흉내 등).
  tcpipHandler?: (info: { destIP: string; destPort: number }, channel: ServerChannel) => void
  // 백로그 M-9 대체(remoteCwd): 셸을 안 건드리는 CWD 추적 실증용 리눅스 흉내.
  //   · exec 로 온 셸 PID 질의에 pid 로 답한다
  //   · shell 입력의 `cd <path>` 로 가상 cwd 를 옮긴다(OSC7 은 안 낸다 — 그게 요점이다)
  //   · sftp READLINK `/proc/<pid>/cwd` 로 그 cwd 를 돌려준다
  // procMissing: /proc 이 없는 서버(비리눅스) — READLINK 를 거절해 "조용히 포기"를 검증한다.
  procCwd?: { pid: number; initial?: string; procMissing?: boolean }
}): Promise<Harness> {
  const password = opts?.password ?? 'testpw123'
  const hostKeyPem = opts?.hostKeyPem ?? genHostKey()
  const sftpRoot = opts?.sftpRoot
  const emitOsc7OnCd = opts?.emitOsc7OnCd === true
  const proc = opts?.procCwd
  // 커넥션 하나가 셸·exec·sftp 채널을 공유한다 — 실제 sshd 와 같은 구조라야 이 기능이 성립한다.
  let procCwdNow = proc?.initial ?? '/home/tester'

  // 살아 있는 연결. dropAll() 이 이걸 끊는다.
  const live = new Set<Connection>()

  const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
    live.add(client)
    client.on('close', () => live.delete(client))
    client.on('error', () => live.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === password) ctx.accept()
      else if (ctx.method === 'none') ctx.reject(['password'])
      else ctx.reject(['password'])
    })
    client.on('ready', () => {
      // W2 F8: 클라이언트가 연 direct-tcpip 채널(포워딩 목적지). 핸들러가 없으면 거절한다.
      client.on('tcpip', (acceptTcp, rejectTcp, info) => {
        if (!opts?.tcpipHandler) {
          rejectTcp()
          return
        }
        opts.tcpipHandler({ destIP: info.destIP, destPort: info.destPort }, acceptTcp())
      })
      client.on('session', (accept) => {
        const session = accept()
        // ssh2 서버의 pty/shell 이벤트는 accept 함수를 직접 넘긴다(객체 아님).
        session.on('pty', (acceptPty) => {
          if (acceptPty) acceptPty()
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          // 접속 즉시 한글 배너 출력(한글 무결 검증용).
          stream.write('A.R.A 원격 셸 준비 완료\r\n')
          // FB-0007①: bash 흉내 상태 — 주입 마커를 보기 전엔 injected=false(버그 재현), 본 뒤로는 true.
          let cwd = '/home/tester'
          let injected = false
          let lineBuf = ''
          // 입력 에코(터미널 라운드트립).
          stream.on('data', (d: Buffer) => {
            const text = d.toString('utf8')
            opts?.onShellData?.(text)
            stream.write(d)
            // remoteCwd 실증: cd 로 가상 cwd 만 옮기고 OSC7 은 내지 않는다(추적은 /proc 쪽이 한다).
            if (proc) {
              const m = /cd\s+([^\r\n;]+)/.exec(text)
              if (m) {
                const arg = m[1].trim().replace(/^["']|["']$/g, '')
                procCwdNow = arg.startsWith('/') ? arg : `${procCwdNow}/${arg}`.replace(/\/+/g, '/')
              }
            }
            // F7: `cd <path>` 입력 시 그 경로로 OSC7 방출(셸이 방출하는 것과 동일 형식).
            if (emitOsc7OnCd) {
              const m = /cd\s+([^\r\n]+)/.exec(text)
              if (m) {
                const path = m[1].trim().replace(/^["']|["']$/g, '')
                stream.write(`\x1b]7;file://dev-server${path}\x1b\\`)
              }
              return
            }
            if (opts?.simulateBashPrompt) {
              if (text.includes('PROMPT_COMMAND')) injected = true
              lineBuf += text
              let idx: number
              // eslint-disable-next-line no-cond-assign
              while ((idx = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, idx)
                lineBuf = lineBuf.slice(idx + 1)
                const m = /(?:^|[;\r])\s*cd\s+([^\r\n;]+)/.exec(line)
                if (m) {
                  const arg = m[1].trim().replace(/^["']|["']$/g, '')
                  cwd = arg.startsWith('/') ? arg : `${cwd}/${arg}`.replace(/\/+/g, '/')
                }
                // PROMPT_COMMAND 는 매 프롬프트(=매 줄 이후)마다 돈다 — cd 가 있었든 없었든 방출.
                if (injected) stream.write(`\x1b]7;file://dev-server${cwd}\x1b\\`)
              }
            }
          })
        })
        // W1: exec 명령(ss/netstat//proc 수집 · tail -F). 같은 커넥션의 새 채널로 온다.
        if (opts?.execHandler || proc) {
          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec()
            // 셸 PID 질의는 하네스가 직접 답한다(테스트가 매번 흉내 낼 필요 없게).
            if (proc && info.command.includes('$PPID')) {
              stream.write(`${proc.pid}\n`)
              stream.exit(0)
              stream.end()
              return
            }
            if (!opts?.execHandler) {
              stream.exit(127)
              stream.end()
              return
            }
            opts.execHandler(info.command, stream)
          })
        }
        // F7: 동일 커넥션의 sftp 서브시스템 — 임시 디렉토리를 원격 파일시스템으로 매핑.
        if (sftpRoot || proc) {
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp()
            if (proc) {
              sftp.on('READLINK', (reqid: number, p: string) => {
                if (proc.procMissing || p !== `/proc/${proc.pid}/cwd`) {
                  sftp.status(reqid, SFTP_NO_SUCH_FILE)
                  return
                }
                const attrs = { mode: 0o120777, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }
                sftp.name(reqid, [{ filename: procCwdNow, longname: procCwdNow, attrs }])
              })
            }
            if (sftpRoot) serveSftp(sftp, sftpRoot)
          })
        }
      })
    })
    client.on('error', () => {
      /* 클라이언트 오류(테스트 종료 등) 무시 */
    })
  })

  await new Promise<void>((resolve) => server.listen(opts?.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    hostKeyPem,
    password,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of live) c.end()
        live.clear()
        server.close(() => resolve())
      }),
    dropAll: () => {
      for (const c of live) c.end()
      live.clear()
    }
  }
}
