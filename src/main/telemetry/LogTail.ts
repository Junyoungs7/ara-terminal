// 원격 로그 실시간 확인 (W1 F13). SFTP 트리에서 고른 파일을 `tail -n 0 -F` 로 흘려보낸다 — 읽기 전용.
//
// 왜 -n 0 인가: 시작 시점의 과거는 뷰어가 **SFTP 로 직접**(파일 뒤에서부터 창 단위) 읽는다.
// tail 이 앞부분을 같이 뱉으면 그 창과 겹쳐 같은 줄이 두 번 보인다. 여기선 "지금부터 새로 붙는 줄"만
// 담당한다. 순서는 tail 먼저 → 창 읽기라, 그 사이에 쓰인 줄은 (유실이 아니라) 중복으로 나타난다.
//
// 원격 프로세스 정리: exec 을 pty 로 연다. 채널을 닫으면 sshd 가 세션 프로세스 그룹에 SIGHUP 을 보내
// tail 이 함께 죽는다. pty 없이 열면 tail 은 다음 출력 때까지 살아남아 서버에 남는다(로그가 안 늘면 영영).
import type { Client, ClientChannel } from 'ssh2'
import type { LogTailData, LogTailExit } from '@shared/ipc'

const TAIL_LINES = 0

// 경로는 렌더러(사용자가 트리에서 고른 파일)에서 온다 — 원격 셸에 그대로 넘기지 않고 작은따옴표로 감싼다.
export function shQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

export type LogTailService = {
  // 스트림 시작. 실패해도 id 는 발급하고 logtail:exit 로 사유를 보낸다(호출측 코드 경로 하나).
  start(sessionId: string, path: string): string
  stop(id: string): void
  stopAll(): void
  activeCount(): number
}

type Tail = { stream: ClientChannel | null; stopped: boolean }

export function createLogTailService(
  getClient: (sessionId: string) => Client | null,
  onData: (d: LogTailData) => void,
  onExit: (d: LogTailExit) => void
): LogTailService {
  const tails = new Map<string, Tail>()
  let seq = 0

  function stop(id: string): void {
    const rec = tails.get(id)
    if (!rec) return
    rec.stopped = true
    tails.delete(id)
    rec.stream?.close()
  }

  return {
    start(sessionId, path) {
      const id = `lt${++seq}`
      const client = getClient(sessionId)
      if (!client) {
        // 로컬 세션·종료된 세션. 동기 throw 대신 exit 이벤트로 알린다.
        setImmediate(() => onExit({ id, error: 'SSH 세션에서만 로그를 볼 수 있습니다.' }))
        return id
      }
      const rec: Tail = { stream: null, stopped: false }
      tails.set(id, rec)
      client.exec(`tail -n ${TAIL_LINES} -F -- ${shQuote(path)}`, { pty: true }, (err, stream) => {
        if (err) {
          tails.delete(id)
          onExit({ id, error: err.message })
          return
        }
        if (rec.stopped) {
          stream.close() // exec 응답 전에 닫혔다
          return
        }
        rec.stream = stream
        // pty 라 줄 끝이 CRLF 로 온다. 뷰어는 평문을 그리므로 여기서 정리한다.
        const push = (c: Buffer): void => onData({ id, chunk: c.toString('utf8').replace(/\r\n/g, '\n') })
        stream.on('data', push)
        // tail 의 오류("cannot open …")도 사용자가 봐야 할 내용이다 — 같은 스트림으로 보낸다.
        stream.stderr.on('data', push)
        stream.on('close', () => {
          const wasStopped = !tails.has(id)
          tails.delete(id)
          if (!wasStopped) onExit({ id }) // 사용자가 닫은 게 아니라 원격이 끝난 경우만 알린다
        })
        stream.on('error', (e: Error) => {
          tails.delete(id)
          onExit({ id, error: e.message })
        })
      })
      return id
    },
    stop,
    stopAll() {
      for (const id of [...tails.keys()]) stop(id)
    },
    activeCount: () => tails.size
  }
}
