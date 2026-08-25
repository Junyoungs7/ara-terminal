/**
 * A 엔진 — **이 PC 의 Claude Code 를 상주 프로세스로**(#123).
 *
 * 준영님 안: "각자의 클로드 코드 계정을 헤드리스로." 그래서 우리가 API 키를 들고 있지 않고,
 * 사용자가 이미 로그인해 둔 그 설치본을 그대로 띄운다(2026-08-24 실측: 구독 로그인이 그대로 통했다).
 *
 * **왜 상주인가**: 기동에 약 20초가 든다(훅·플러그인·CLAUDE.md 로딩). 질문마다 새로 띄우면
 * 매 턴 20초다. 스트리밍 입력 모드는 문서가 "preferred" 라고 부르는 길이고, 첫 질문에서 한 번만
 * 치른 뒤로는 stdin 한 줄이면 된다.
 *
 * 이 파일이 지키는 것 셋:
 *  ① **사람이 친 글자는 argv 에 없다** — 전부 stdin(설계 §3.2). 인용·인코딩 사고와 `ps` 노출을 함께 막는다.
 *  ② **조용히 되살리지 않는다** — 프로세스가 죽으면 화면에 그대로 알린다. 몰래 다시 띄우면
 *     같은 질문이 두 번 청구된다.
 *  ③ **고아를 남기지 않는다** — dispose() 가 유일한 출구이고, 앱 종료가 반드시 지난다(#64 규율).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  buildClaudeArgs,
  interruptLine,
  parseStreamJson,
  permissionModeLine,
  permissionReplyLine,
  userMessageLine,
  type AiEngine,
  type AiEngineEvent,
  type ClaudeArgsOpts
} from '@shared/aiEngine'

/** 프로세스에서 우리가 쓰는 부분만. 테스트가 가짜를 끼울 수 있게 좁게 잡는다. */
export type EngineProc = {
  stdout: { on(ev: 'data', fn: (c: Buffer | string) => void): unknown }
  stderr: { on(ev: 'data', fn: (c: Buffer | string) => void): unknown }
  stdin: { write(s: string): unknown; end(): unknown }
  kill(sig?: NodeJS.Signals): unknown
  on(ev: 'exit' | 'error', fn: (a?: unknown) => void): unknown
}

export type ClaudeEngineOpts = ClaudeArgsOpts & {
  /** 어느 폴더에서 돌 것인가(설계 §3.3 — 지금 보고 있는 세션의 폴더). */
  cwd: string
  /** 실행 파일. 기본은 PATH 의 `claude`. */
  bin?: string
  /** 테스트용 주입. 없으면 진짜로 띄운다. */
  spawnProc?: (bin: string, args: string[], cwd: string) => EngineProc
}

/**
 * 인터럽트를 보낸 뒤 이만큼 기다려도 턴이 안 끝나면 프로세스를 내린다.
 * control 요청은 CLI 가 받아 줘야 듣는 물건이라 **안 들을 수도 있다** — 그때 사용자는
 * "중지를 눌렀는데 아무 일도 없다"를 겪는다. 마지막 수단을 남겨 둔다.
 */
const INTERRUPT_GRACE_MS = 4000

/**
 * 윈도우에서 `claude` 는 `.cmd` 라 **셸을 거쳐야** 실행된다(2026-08-24 실측).
 * 그래서 인자를 배열이 아니라 한 줄로 붙이는데, 그 줄에 들어가는 것은 **우리가 만든 값뿐**이다
 * (경로·플래그). 사람이 친 글자는 stdin 으로만 간다 — 이 규칙이 인용 문제를 통째로 없앤다.
 */
export function quoteArg(a: string): string {
  return /^[A-Za-z0-9._:\\/@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`
}

function realSpawn(bin: string, args: string[], cwd: string): EngineProc {
  const line = [bin, ...args].map(quoteArg).join(' ')
  return spawn(line, { cwd, shell: true, windowsHide: true }) as unknown as EngineProc
}

export function createClaudeEngine(opts: ClaudeEngineOpts): AiEngine {
  const listeners = new Set<(e: AiEngineEvent) => void>()
  const emit = (e: AiEngineEvent): void => {
    for (const fn of [...listeners]) fn(e)
  }

  const args = buildClaudeArgs(opts)
  const proc = (opts.spawnProc ?? realSpawn)(opts.bin ?? 'claude', args, opts.cwd)

  let alive = true
  let killTimer: NodeJS.Timeout | null = null
  // stdout 은 줄 단위로 오지 않는다 — 조각을 모아 개행에서만 자른다.
  let buf = ''
  // stderr 는 진단용이라 **마지막 몇 줄만** 들고 있는다(무한정 쌓지 않는다).
  let errTail = ''

  proc.stdout.on('data', (c) => {
    buf += String(c)
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      for (const e of parseStreamJson(line)) emit(e)
      nl = buf.indexOf('\n')
    }
    // 개행 없이 한없이 길어지는 줄은 버린다(신뢰 경계 밖 — 힙을 지킨다).
    if (buf.length > 4_000_000) buf = ''
  })

  proc.stderr.on('data', (c) => {
    errTail = (errTail + String(c)).slice(-2000)
  })

  proc.on('error', (err) => {
    alive = false
    // 제일 흔한 실패가 "claude 가 없다" 이고, 그건 사용자가 고칠 수 있는 일이다.
    emit({ t: 'error', message: String((err as { message?: unknown } | undefined)?.message ?? err ?? '') })
    emit({ t: 'exit', code: null })
  })

  proc.on('exit', (code) => {
    alive = false
    if (killTimer) clearTimeout(killTimer)
    killTimer = null
    // 비정상 종료면 stderr 꼬리를 함께 준다 — 이게 없으면 "그냥 죽었다"만 남는다.
    if (code !== 0 && errTail.trim() !== '') emit({ t: 'error', message: errTail.trim() })
    emit({ t: 'exit', code: typeof code === 'number' ? code : null })
  })

  const write = (s: string): void => {
    if (!alive) return
    try {
      proc.stdin.write(s)
    } catch {
      /* 이미 닫힌 파이프 — exit 이 곧 온다 */
    }
  }

  return {
    send: (text) => write(userMessageLine(text)),

    respondPermission: (requestId, allow) => write(permissionReplyLine(requestId, allow)),

    setMode: (mode) => write(permissionModeLine(randomUUID(), mode)),

    interrupt: () => {
      if (!alive) return
      write(interruptLine(randomUUID()))
      // control 요청을 CLI 가 안 들을 수도 있다 — 유예 뒤에는 내린다.
      if (killTimer) clearTimeout(killTimer)
      killTimer = setTimeout(() => {
        if (alive) proc.kill()
      }, INTERRUPT_GRACE_MS)
      killTimer.unref?.()
    },

    dispose: () => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = null
      listeners.clear()
      if (!alive) return
      alive = false
      try {
        proc.stdin.end()
      } catch {
        /* 이미 닫혔다 */
      }
      proc.kill()
    },

    onEvent: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
