// FB-monitor(F19 후속): 트리 우클릭 tmux 서브메뉴에 띄울 "현재 연결된 세션 목록" 파서.
// `tmux ls 2>&1` 출력(성공/미설치/서버 없음이 한 스트림에 섞여 온다) → 구조화된 상태.
// main(ssh2 exec)과 렌더러(서브메뉴 렌더) 양쪽이 이 타입을 쓰므로 shared 에 둔다 — 순수 함수, ssh2 의존 없음.

export type TmuxListStatus = 'ok' | 'notInstalled' | 'noServer' | 'error'

export type TmuxListResult = {
  status: TmuxListStatus
  // status !== 'ok' 면 항상 빈 배열.
  sessions: string[]
}

// 세션 한 줄: `이름: N windows (created ...) [WxH]` (attach 중이면 끝에 "(attached)" 가 붙기도 한다).
// 이름 자체엔 tmux 가 ':' 를 허용하지 않으므로 첫 콜론으로 잘라도 안전하다.
const SESSION_LINE = /^([^:]+):\s/

export function parseTmuxLs(combinedOutput: string): TmuxListResult {
  const text = combinedOutput.trim()
  if (!text) return { status: 'noServer', sessions: [] }
  if (/no server running|No such file or directory/i.test(text)) return { status: 'noServer', sessions: [] }
  if (/tmux/i.test(text) && /command not found|: not found/i.test(text)) return { status: 'notInstalled', sessions: [] }

  const sessions = text
    .split('\n')
    .map((l) => SESSION_LINE.exec(l.trim())?.[1])
    .filter((name): name is string => !!name)

  return sessions.length > 0 ? { status: 'ok', sessions } : { status: 'error', sessions: [] }
}
