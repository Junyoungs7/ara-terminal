// F27 AI CLI 시작의 "실행 쪽" — 문자열 조립은 shared/aiCli.ts 가 하고, 여기는 그 한 줄을 실제로
// 밀어 넣기까지 필요한 세 가지 시중을 든다: 폴더 만들기 · 셸이 준비되기를 기다리기 · 결과 판정.
//
// 이 파일의 존재 이유는 두 번째다. **타이밍이 이 기능의 유일한 까다로운 지점이다** —
// 프롬프트가 그려지기 전에 밀어 넣으면 배너·초기화 출력에 섞여 삼켜진다. 그렇다고 setTimeout 으로
// 눈대중을 하면 느린 서버에서 조용히 실패한다(빠른 서버에서는 늘 통과하므로 알아채지도 못한다).
//
// 그래서 있는 신호를 쓴다:
//   · `session:cwd` 1회 — SSH 라면 SshBackend 가 원격 셸 프로세스를 찾아 /proc/<pid>/cwd 를 읽었다는
//     뜻이다(remoteCwd.ts). "셸이 살아 있고 tty 를 잡았다"의 증거다.
//   · `session:data` 가 멎음 — 배너·MOTD·프롬프트가 다 그려졌다. SshBackend 도 같은 판정을 쓴다
//     (출력이 멎으면 CWD_SETTLE_MS 뒤 cwd 를 읽는다).
// 둘 중 어느 것도 못 받는 서버(= /proc 이 없고 배너도 없는 조용한 셸)를 위해 상한을 둔다 —
// 영영 기다리는 것보다 늦게라도 보내는 편이 낫다.
import { t } from '../i18n'
import type { FileOpResult } from '@shared/ipc'

/** 출력이 이만큼 멎으면 프롬프트가 다 그려진 것으로 본다. */
const SETTLE_MS = 400
/** 아무 신호도 못 받아도 여기까지만 기다린다. */
const MAX_WAIT_MS = 8000

export type ReadyReason = 'settled' | 'timeout'

/**
 * 셸이 명령 한 줄을 받을 준비가 됐을 때 resolve. 실패하지 않는다 —
 * 못 기다렸으면 'timeout' 을 돌려주고 호출측은 그래도 보낸다(안 보내면 아무 일도 안 일어난다).
 */
export function waitShellReady(
  sessionId: string,
  settleMs: number = SETTLE_MS,
  maxWaitMs: number = MAX_WAIT_MS
): Promise<ReadyReason> {
  return new Promise((resolve) => {
    const offs: (() => void)[] = []
    let settle: ReturnType<typeof setTimeout> | null = null
    let done = false

    const finish = (reason: ReadyReason): void => {
      if (done) return
      done = true
      if (settle) clearTimeout(settle)
      clearTimeout(hard)
      offs.forEach((off) => off())
      resolve(reason)
    }
    // 신호가 올 때마다 다시 잰다 — 출력이 계속 흐르는 동안에는(배너가 긴 서버) 기다린다.
    const arm = (): void => {
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => finish('settled'), settleMs)
    }

    const hard = setTimeout(() => finish('timeout'), maxWaitMs)
    const onCwd = window.ev?.session.onCwd(sessionId, arm)
    const onData = window.ev?.session.onData(sessionId, arm)
    if (onCwd) offs.push(onCwd)
    if (onData) offs.push(onData)
  })
}

/**
 * `~/x` 를 원격 절대 경로로. SFTP 는 물결표를 모른다(셸이 펼치는 문법이다) — 홈은 `sftp:list('.')`
 * 가 realpath 로 알려 준다. 상대 경로는 셸의 현재 위치를 알아야 풀 수 있어 여기서는 다루지 않는다.
 */
async function resolveRemoteDir(sessionId: string, path: string): Promise<string | null> {
  if (path.startsWith('/')) return path
  if (path !== '~' && !path.startsWith('~/')) return null
  const home = await window.ev.sftp.list(sessionId, '.')
  if (!home.ok) return null
  if (path === '~') return home.path
  const rest = path.slice(2)
  return rest === '' ? home.path : `${home.path.replace(/\/+$/, '')}/${rest}`
}

/**
 * 없으면 만든다. `sftp:mkdir` 은 한 단계밖에 못 만들어서(이름에 구분자를 못 넣는 계약) 위에서부터
 * 한 단씩 훑고, 없는 단만 만든다. 어느 단에서든 실패하면 **거기서 멈추고 그 사유를 돌려준다** —
 * 조용히 넘어가면 뒤이어 실행될 `cd` 가 실패해 사용자는 "왜 아무 일도 안 일어났지"만 남는다.
 */
export async function ensureRemoteDir(sessionId: string, path: string): Promise<FileOpResult> {
  const abs = await resolveRemoteDir(sessionId, path)
  if (abs === null) return { ok: false, message: t('aicli.err.relPath') }
  let cur = ''
  for (const seg of abs.split('/').filter(Boolean)) {
    const next = `${cur}/${seg}`
    const listed = await window.ev.sftp.list(sessionId, next)
    if (!listed.ok) {
      const made = await window.ev.sftp.mkdir(sessionId, cur === '' ? '/' : cur, seg)
      if (!made.ok) return made
    }
    cur = next
  }
  return { ok: true }
}

/**
 * 이 서버에 그 CLI 가 있나. 카탈로그의 `which.cli`(= `command -v <bin>`) 한 번.
 * 종료코드와 출력을 **둘 다** 본다 — 셸에 따라 없는데도 0 으로 끝나는 경우가 있다.
 */
export async function cliInstalled(sessionId: string, bin: string): Promise<boolean> {
  const r = await window.ev.remote.run(sessionId, 'which.cli', { bin })
  return r.ok && r.code === 0 && r.out.trim() !== ''
}
