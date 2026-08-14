// F26 서버 콘솔 — 원격 명령 실행 서비스. RemoteTelemetry.ts 를 그대로 본떴다(폴링 주기·busy 가드·
// 세션이 죽으면 자동 정리가 전부 같다). TmuxSessions.ts 는 이 파일의 exec 한 번(once)에 해당한다.
//
// 텔레메트리와 딱 하나가 다르다: 저쪽은 명령이 파일 안에 하드코딩돼 있고, 여기는 **렌더러가 고른 id** 로
// 정해진다. 그래서 이 파일의 유일한 규칙은 이것이다 —
//
//   buildCommand(id, args) 를 통과하지 않은 문자열은 exec 에 닿지 않는다.
//
// 렌더러가 보낼 수 있는 것은 id 와 인자뿐이고 명령 문자열 조립은 shared/remoteCatalog.ts 가 한다.
// 표에 없는 id · 검증에 걸린 인자는 null 로 돌아오고, 그러면 **아무것도 실행하지 않는다**. 이 선이
// 무너지면 SSH 세션이 임의 원격 실행 채널이 된다(F23 이 MCP session_create 의 shell 자유 문자열을
// 보안 결함으로 판정해 들어낸 것과 같은 규칙).
//
// sudo 는 붙이지 않는다 — exec 채널에는 tty 가 없어 비밀번호 프롬프트가 막히고 조용히 실패한다.
// 권한이 없으면 stderr 를 그대로 올려 보내는 편이 정직하다(아래 exec 이 stderr 를 버리지 않는 이유).
import type { Client } from 'ssh2'
import { buildCommand, type CmdId } from '@shared/remoteCatalog'

// 폴링 주기 — 텔레메트리와 같은 2.5초(사람이 표를 보고 있을 때 "멈춘 것 같지 않은" 최저 빈도).
const POLL_MS = 2500
// 한 바퀴 상한. 응답 없는 서버가 폴러를 영구히 붙잡지 못하게 한다.
const EXEC_TIMEOUT_MS = 10000

// 성공은 종료코드와 출력을 함께 준다 — 쓰기 명령(kill·systemctl)은 "돌긴 돌았는데 권한이 없었다"를
// 코드로만 알 수 있고, 그 사유는 출력에 있다. 선례: SftpService.copyRemote().
export type RunFailReason = 'badArgs' | 'noSession' | 'timeout' | 'exec'

export type RunResult = { ok: true; out: string; code: number } | { ok: false; reason: RunFailReason }

export type RemoteConsoleService = {
  run(sessionId: string, id: CmdId, args: unknown): Promise<RunResult>
  /** 주기 실행 → emit. 읽기 전용 명령만 받는다(아래 watch 주석 참고). */
  watch(sessionId: string, id: CmdId, args: unknown): void
  unwatch(sessionId: string, id: CmdId): void
  stopAll(): void
  /** 테스트용: 현재 폴링 중인 구독 수. */
  activeCount(): number
}

type Sub = { timer: NodeJS.Timeout; busy: boolean; sessionId: string; cmdId: CmdId; args: unknown }

// 구독 단위는 (세션, 명령) 한 쌍이다 — 한 서버에서 프로세스와 서비스를 동시에 보고 있어도 폴러가 섞이지 않는다.
const keyOf = (sessionId: string, cmdId: CmdId): string => `${sessionId}::${cmdId}`

export function createRemoteConsoleService(
  // getClient: 세션 id → ssh2 Client(로컬·종료된 세션은 null → 폴링 자동 중지).
  getClient: (sessionId: string) => Client | null,
  emit: (e: { sessionId: string; cmdId: CmdId; out: string; code?: number; err?: string }) => void,
  intervalMs: number = POLL_MS
): RemoteConsoleService {
  const subs = new Map<string, Sub>()

  // 실행 경로는 이 함수 하나다 — run 도 watch 의 한 바퀴도 여기를 지난다(검증을 두 번 적지 않는다).
  async function once(sessionId: string, id: CmdId, args: unknown): Promise<RunResult> {
    const built = buildCommand(id, args)
    if (!built) return { ok: false, reason: 'badArgs' }
    const client = getClient(sessionId)
    if (!client) return { ok: false, reason: 'noSession' }
    return exec(client, built.cmd)
  }

  function unwatch(sessionId: string, id: CmdId): void {
    const key = keyOf(sessionId, id)
    const sub = subs.get(key)
    if (!sub) return
    clearInterval(sub.timer)
    subs.delete(key)
  }

  async function tick(key: string): Promise<void> {
    const sub = subs.get(key)
    if (!sub || sub.busy) return // 이전 바퀴가 아직 안 끝났으면 건너뛴다(채널 중첩 금지)
    if (!getClient(sub.sessionId)) {
      unwatch(sub.sessionId, sub.cmdId) // 세션이 닫혔다 — 폴러도 함께 정리
      return
    }
    sub.busy = true
    const r = await once(sub.sessionId, sub.cmdId, sub.args)
    sub.busy = false
    // 폴링 중에 구독이 해지됐으면 늦게 온 결과를 흘리지 않는다.
    if (!subs.has(key)) return
    // #68(2026-08-14): 실패도 올려 보낸다. 예전엔 여기서 조용히 버렸고("표는 마지막 성공 내용을
    // 그대로 들고 있는다"), 그 결과 **첫 바퀴가 실패하면 화면이 "불러오는 중"에서 영영 멈췄다** —
    // 권한 부족·명령 없음·연결 끊김이 전부 로딩으로 보였다(#57 과 같은 종류).
    // 표를 유지할지 오류를 띄울지는 행 수를 아는 렌더러가 정한다. 종료코드도 함께 보낸다:
    // 카탈로그의 일부 스크립트는 정상 출력을 내면서도 0 이 아닐 수 있어 코드만으로 판정하면 안 된다.
    if (!r.ok) {
      emit({ sessionId: sub.sessionId, cmdId: sub.cmdId, out: '', err: r.reason })
      return
    }
    emit({ sessionId: sub.sessionId, cmdId: sub.cmdId, out: r.out, code: r.code })
  }

  return {
    run: (sessionId, id, args) => once(sessionId, id, args),

    watch(sessionId, id, args) {
      const built = buildCommand(id, args)
      // 인자가 틀렸으면 폴러를 만들지 않는다(2.5초마다 badArgs 를 돌릴 이유가 없다).
      // write 명령도 거절한다 — "2.5초마다 kill 을 보내는 구독"은 존재해서는 안 되는 물건이다.
      if (!built || built.write) return
      const key = keyOf(sessionId, id)
      if (!subs.has(key)) {
        subs.set(key, {
          timer: setInterval(() => void tick(key), intervalMs),
          busy: false,
          sessionId,
          cmdId: id,
          args
        })
      }
      void tick(key) // 첫 화면을 주기만큼 기다리지 않게 + 새로고침 버튼 경로(telemetry.start 와 같다)
    },

    unwatch,

    stopAll() {
      for (const s of [...subs.values()]) unwatch(s.sessionId, s.cmdId)
    },

    activeCount: () => subs.size
  }
}

// 명령 한 번. stdout 과 stderr 를 **한 버퍼에** 모은다 — 카탈로그의 쓰기 명령은 이미 `2>&1` 로 합쳐
// 오지만, 합치지 않는 명령이 나중에 늘어도 "권한이 없습니다"가 화면에서 사라지지 않게 한다.
function exec(client: Client, cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    client.exec(cmd, (err, stream) => {
      if (err || !stream) {
        resolve({ ok: false, reason: 'exec' })
        return
      }
      let out = ''
      let timer: NodeJS.Timeout | null = null
      let settled = false
      const finish = (r: RunResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(r)
      }
      timer = setTimeout(() => {
        stream.close()
        finish({ ok: false, reason: 'timeout' })
      }, EXEC_TIMEOUT_MS)
      const add = (c: Buffer): void => {
        out += c.toString('utf8')
      }
      stream.on('data', add)
      stream.stderr.on('data', add)
      // exit-status 를 안 보내는 서버·하네스도 있다 — 그 경우는 0(성공)으로 본다(SftpService 와 같은 가정).
      stream.on('close', (code: number) => finish({ ok: true, out, code: typeof code === 'number' ? code : 0 }))
      stream.on('error', () => finish({ ok: false, reason: 'exec' }))
    })
  })
}
