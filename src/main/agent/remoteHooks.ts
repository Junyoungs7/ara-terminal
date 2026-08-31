// F1b 원격 훅 — **원격에 아무것도 설치하지 않고** 그 서버의 Claude Code 가 우리에게 말하게 한다.
//
// 훅은 *실행 호스트의* 127.0.0.1 로 POST 한다(docs/orca-analysis.md §3). 그래서 원격이면 거기
// 받는 사람이 있어야 하고, Orca 는 그 자리에 릴레이 데몬을 배포한다. 우리는 데몬이 필요 없다 —
// 이미 있는 두 조각의 조합이다:
//
//   [원격] claude 훅 → 127.0.0.1:<원격포트> ──ssh 역터널(forwardIn)──→ [내 PC] 훅 서버
//   [원격] ~/.claude/settings.json ←──────────── SFTP 로 병합(mergeHooks 는 순수 함수)
//
// `PortForward.ts` 가 `forwardOut`(내 PC → 원격)이라면 여기는 그 반대 방향이다. 두 파일의 보안
// 불변식은 같다: **바인드 주소는 양쪽 다 127.0.0.1 하나뿐**이고(원격의 LAN 에도, 내 PC 의 LAN 에도
// 열리지 않는다), 흘러가는 바이트는 어디에도 남기지 않는다.
//
// ⚠️ **설치는 AI 를 띄울 때가 아니라 SSH 세션이 붙을 때**다. 그래야 사용자가 직접 친 `claude` 도
// 잡힌다 — 훅은 누가 띄웠는지 안 따지고, 아라가 자기가 띄운 것만 아는 것이 원래 문제였다.
//
// 한계(감지 못 하는 게 맞다): 이 세션 안에서 다시 `ssh 다른서버` 로 들어가 거기서 돌리면 env 도
// 터널도 안 따라간다. **그 터널은 그 서버 것이 아니다.**
import { createConnection } from 'node:net'
import { posix } from 'node:path'
import type { Client, SFTPWrapper } from 'ssh2'
import type { AgentHookInstall } from '@shared/agentStatus'
import type { HookSink } from './AgentHookServer'
import { HOOK_PANE_ENV, HOOK_PORT_ENV, hookTtyFile, planHooks } from './claudeHooks'
// 역터널의 두 끝. `PortForward` 의 불변식 상수를 그대로 쓴다 — 같은 규칙을 두 벌로 적지 않는다
// (REMOTE_HOST = 원격이 리슨할 주소, LOCAL_BIND = 우리 훅 서버가 앉아 있는 주소).
import { LOCAL_BIND, REMOTE_HOST } from '../forward/PortForward'

/** 원격 설정 파일의 홈 기준 경로. 원격은 언제나 POSIX 다(remoteCwd·SftpService 와 같은 전제). */
const SETTINGS_REL = ['.claude', 'settings.json'] as const

/**
 * 원격 설정 파일 크기 상한. `settings.json` 은 수 KB 짜리다 — 이보다 크면 우리가 아는 그 파일이
 * 아니고, 통째로 메모리에 들고 올 이유도 없다(심볼릭 링크로 거대한 파일을 가리켜 둔 경우 포함).
 */
const SETTINGS_MAX_BYTES = 1024 * 1024

/**
 * `forwardIn` 응답 상한. sshd 는 언제나 답하지만, **답이 안 오면 탭이 영영 안 열린다** —
 * 이 준비는 셸을 열기 전에 끝나야 하는 일이라 상한이 곧 안전판이다(상한에 닿으면 훅 없이 연다).
 */
const FORWARD_TIMEOUT_MS = 3000

export type RemoteHookPrep = {
  /** 그 세션 셸에 실어 보낼 env. 훅 명령이 이 둘을 **먼저** 읽는다(로컬과 같은 한 줄이다). */
  env: Record<string, string>
  /** 원격 설정 병합의 결과. 셸을 막지 않으려고 뒤에서 도는 일이라 약속으로 돌려준다(검사·로깅용). */
  installed: Promise<AgentHookInstall>
  /**
   * #162 **env 를 안 받아 주는 서버를 위한 두 번째 길.** 셸의 tty(`/dev/pts/3`)를 알게 되면
   * 같은 두 값을 `~/.claude/ara-tty-3` 에 적는다 — 훅은 env 가 비었을 때 그 파일을 읽는다.
   *
   * 왜 나중인가: tty 는 **셸이 열려야** 생긴다. env 는 셸 요청에 실어야 해서 그전에 정해야 하고,
   * 이건 그 뒤라 두 시점이 갈린다(부르는 쪽은 `SshBackend` 의 셸 PID 조회 자리다).
   * 셸이 뜨자마자 몇 밀리초 안이라 사용자가 `claude` 를 치기 전에 끝난다.
   */
  publish: (tty: string) => void
}

/**
 * SSH 세션이 붙을 때 한 번. 역터널을 열고, 원격 설정을 병합하고, 셸에 넣을 env 를 돌려준다.
 *
 * **아무것도 던지지 않는다.** 상태 표시가 접속을 막으면 안 된다 — 못 하면 `null` 이고, 그 세션은
 * 그냥 훅이 없는 세션이다(상태는 `unverifiable` 로 남는다. 옛 60초 규칙으로 되돌아가지 않는다).
 */
export async function prepareRemoteHooks(
  client: Client,
  sink: HookSink,
  paneId: string,
  /** 화면에 그대로 뜨는 서버 이름(#162 §부수). 프로필 이름, 없으면 host. */
  server = ''
): Promise<RemoteHookPrep | null> {
  const localPort = sink.port()
  // 우리 훅 서버가 안 떴으면 원격에 심어 봐야 갈 곳이 없다 — 남의 설정 파일을 헛되이 고치지 않는다.
  if (localPort <= 0) return null

  const remotePort = await openTunnel(client)
  // 터널이 안 열리면(AllowTcpForwarding no 등) **설치도 하지 않는다.** 받을 수 없는데 남의 파일을
  // 고치는 것은 부작용만 남기는 일이다.
  if (remotePort <= 0) return null
  pipeHookConnections(client, remotePort, localPort)

  // 설치는 셸을 기다리게 하지 않는다: 사용자가 `claude` 를 치는 것은 한참 뒤고, 느린 링크에서
  // SFTP 왕복 몇 번이 탭 열리는 시간이 되면 그게 더 나쁜 거래다.
  const installed = installRemoteHooks(client, sink, paneId)
  void installed.then((install) => sink.report(server, { install }))

  return {
    env: { [HOOK_PORT_ENV]: String(remotePort), [HOOK_PANE_ENV]: paneId },
    installed,
    publish(tty) {
      void publishTtyFile(client, installed, tty, `${remotePort} ${paneId}`).then((ok) =>
        sink.report(server, { fallback: ok })
      )
    }
  }
}

/**
 * tty 폴백 파일 하나를 쓴다. **설치가 된 서버에만** 쓴다 — `~/.claude` 가 없는 서버(=Claude Code 가
 * 없는 서버)에 폴더도 파일도 만들지 않는다는 규율은 여기도 같다.
 *
 * 지우지 않는다: 끊기는 커넥션으로 SFTP 를 다시 여는 값보다 남는 값이 싸다. 남아도 해롭지 않다 —
 * 죽은 포트를 가리키는 파일은 curl 이 즉시 거절당하고 `exit 0` 이며, 같은 tty 를 다시 쓰는 세션은
 * 이 파일을 **덮어쓴다**(그래서 오래된 값이 살아 돌아오지 않는다).
 *
 * ⚠️ `tty` 는 **원격이 준 문자열**이다(그쪽 readlink 의 답). `hookTtyFile` 이 마지막 슬래시 뒤만
 * 남기므로 `../../etc/…` 같은 답으로도 `~/.claude` 밖을 못 나간다 — 이름을 basename 으로 짓는 것은
 * 훅 쪽 확장과 맞추기 위해서이기도 하고, 그 자체가 경로 탈출 방지이기도 하다.
 */
async function publishTtyFile(
  client: Client,
  installed: Promise<AgentHookInstall>,
  tty: string,
  line: string
): Promise<boolean> {
  const install = await installed
  const name = hookTtyFile(tty)
  if (!install.ok || !name) return false
  let sftp: SFTPWrapper | null = null
  try {
    sftp = await openSftp(client)
    await writeFile(sftp, posix.join(posix.dirname(install.path), name), `${line}\n`)
    return true
  } catch {
    // 쓰기 실패는 설치 실패와 같은 급이 아니다 — env 가 오는 서버라면 그대로 잘 돈다.
    return false
  } finally {
    sftp?.end()
  }
}

/** 역터널 하나를 연다. 원격의 127.0.0.1 에 임의 포트로 리슨시킨다(포트는 sshd 가 고른다). */
function openTunnel(client: Client): Promise<number> {
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(0), FORWARD_TIMEOUT_MS)
    const done = (port: number): void => {
      clearTimeout(timer)
      resolve(port)
    }
    try {
      client.forwardIn(REMOTE_HOST, 0, (err, port) => done(err || !port ? 0 : port))
    } catch {
      // 끊긴 커넥션에서 ssh2 는 콜백이 아니라 **동기로 던진다**(PortForward·SshBackend 와 같은 이유).
      done(0)
    }
  })
}

/**
 * 터널로 들어온 연결을 우리 훅 서버로 잇는다. **HTTP 를 해석하지 않는다** — 그대로 흘려보내고
 * 판정은 같은 `AgentHookServer` 가 한다(원격용 수신 경로를 따로 만들지 않는다).
 */
function pipeHookConnections(client: Client, remotePort: number, localPort: number): void {
  client.on('tcp connection', (info, accept, reject) => {
    // 우리 터널이 아닌 것은 받지 않는다(이 커넥션에 다른 forwardIn 이 생길 경우의 방어).
    if (info.destPort !== remotePort) {
      reject()
      return
    }
    const channel = accept()
    const socket = createConnection(localPort, LOCAL_BIND)
    const close = (): void => {
      socket.destroy()
      channel.destroy()
    }
    socket.on('error', close)
    channel.on('error', close)
    socket.pipe(channel)
    channel.pipe(socket)
  })
}

/**
 * 원격 `~/.claude/settings.json` 병합. **판단은 `planHooks` 가 하고 여기는 읽고 쓰기만 한다** —
 * 로컬과 판단이 갈리면 원격만 남의 설정을 지우는 날이 온다.
 *
 * 성공하면 그 파일에서 되찾은(또는 새로 만든) 토큰을 서버에 등록한다. 그래서 **토큰은 호스트마다
 * 다르다** — 그 호스트의 파일에 있는 값이 곧 그 호스트의 열쇠다.
 */
async function installRemoteHooks(client: Client, sink: HookSink, owner: string): Promise<AgentHookInstall> {
  let sftp: SFTPWrapper
  try {
    sftp = await openSftp(client)
  } catch (e) {
    return { ok: false, reason: 'write', message: `원격 SFTP 를 열 수 없습니다: ${String(e)}` }
  }
  let path = ''
  try {
    const home = await realpath(sftp, '.')
    if (!home) return { ok: false, reason: 'noHome', message: '원격 홈 디렉터리를 찾지 못했습니다.' }
    const dir = posix.join(home, SETTINGS_REL[0])
    path = posix.join(dir, SETTINGS_REL[1])

    // ⚠️ `~/.claude` 가 없는 서버에는 **아무것도 만들지 않는다.** 그건 Claude Code 가 없는 서버이고,
    // 거기 훅을 심는 것은 아무도 안 읽는 파일을 남의 프로덕션 서버에 남기는 일이다. 우리가 붙는
    // 서버가 수십 대인데 그중 claude 를 쓰는 곳은 몇 대뿐이다 — 발자국을 이득이 있는 곳에만 남긴다.
    // (나중에 깔면 claude 가 이 폴더를 만들고, 그다음 접속에서 심긴다.)
    if (!(await exists(sftp, dir))) {
      return { ok: false, reason: 'skipped', message: `${dir} 가 없습니다 — Claude Code 가 없는 서버로 봅니다.` }
    }

    const current = await readSettings(sftp, path)
    if (!current.ok) return { ok: false, reason: 'parse', message: `${path} 를 읽을 수 없습니다: ${current.message}` }

    const plan = planHooks(current.text)
    if (!plan.ok) return { ok: false, reason: 'parse', message: `${path} 를 읽을 수 없습니다: ${plan.message}` }
    if (plan.next !== null) {
      // 로컬의 `writeJsonAtomic` 이 남기는 `.bak` 과 같은 자리다. SFTP 에는 덮어쓰는 rename 이 없어
      // 원자적 교체를 흉내 낼 수 없으니, **되돌릴 사본을 먼저 남기고** 쓴다. 남의 서버의 설정
      // 파일이라 이 한 번의 왕복이 특히 값지다(첫 설치 때만 일어난다 — 그 뒤로는 파일이 같다).
      if (current.text !== null) await writeFile(sftp, `${path}.bak`, current.text)
      await writeFile(sftp, path, JSON.stringify(plan.next, null, 2))
    }
    sink.setToken(owner, plan.token)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, reason: 'write', message: `${path || '원격 설정'} 에 쓸 수 없습니다: ${String(e)}` }
  } finally {
    sftp.end()
  }
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    try {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    } catch (e) {
      reject(e as Error)
    }
  })
}

/** 원격 홈. `.` 의 실제 경로가 로그인 디렉터리다(SftpService.list 가 쓰는 것과 같은 호출). */
function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve) => sftp.realpath(path, (err, p) => resolve(err ? '' : p)))
}

/** 없는 파일은 첫 설치(`text: null`)고, 못 읽는 파일은 사유를 그대로 올린다. */
function readSettings(
  sftp: SFTPWrapper,
  path: string
): Promise<{ ok: true; text: string | null } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    sftp.stat(path, (statErr, st) => {
      if (statErr) return resolve({ ok: true, text: null }) // 없다 = 첫 설치(정상)
      if (st && st.size > SETTINGS_MAX_BYTES) {
        return resolve({ ok: false, message: `설정 파일이 너무 큽니다(${st.size} 바이트).` })
      }
      sftp.readFile(path, (err, buf) => {
        if (err) return resolve({ ok: false, message: String(err) })
        resolve({ ok: true, text: buf.toString('utf8') })
      })
    })
  })
}

function writeFile(sftp: SFTPWrapper, path: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, Buffer.from(text, 'utf8'), (err) => (err ? reject(err) : resolve()))
  })
}

function exists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => sftp.stat(path, (err) => resolve(!err)))
}
