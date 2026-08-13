// FB-monitor: 트리 우클릭 tmux 서브메뉴용 1회성 조회. RemoteTelemetry.collect() 와 같은 모양의
// 읽기 전용 exec 하나(폴링 아님 — 메뉴를 열 때만 부른다). stderr 를 stdout 에 합쳐서(2>&1) "명령을
// 찾을 수 없음"/"서버 없음" 문구까지 한 스트림으로 받아야 parseTmuxLs 가 구분할 수 있다.
import type { Client } from 'ssh2'
import { parseTmuxLs, type TmuxListResult } from '@shared/tmuxList'

const TMUX_LS_TIMEOUT_MS = 6000
const TMUX_LS_CMD = 'tmux ls 2>&1'

export function fetchTmuxSessions(client: Client): Promise<TmuxListResult> {
  return new Promise((resolve) => {
    client.exec(TMUX_LS_CMD, (err, stream) => {
      if (err) {
        resolve({ status: 'error', sessions: [] })
        return
      }
      let out = ''
      const timer = setTimeout(() => {
        stream.close()
        resolve(parseTmuxLs(out))
      }, TMUX_LS_TIMEOUT_MS)
      const done = (): void => {
        clearTimeout(timer)
        resolve(parseTmuxLs(out))
      }
      stream.on('data', (c: Buffer) => {
        out += c.toString('utf8')
      })
      stream.on('close', done)
      stream.on('error', () => done())
    })
  })
}
