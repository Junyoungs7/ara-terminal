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
  modelLine,
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
 * 윈도우 인자 인코딩 — **한 줄을 파서 둘이 읽는다**(#152).
 *
 * `claude` 는 npm 이 깐 `.cmd` 셔임이고(`where claude` → `claude.cmd`), `.cmd` 는 cmd.exe 없이
 * 못 뜬다(Node 는 CVE-2024-27980 이후 EINVAL 로 거절한다 — 2026-08-30 실측). 그래서 같은 명령줄을
 * **cmd.exe 가 먼저, CommandLineToArgvW(CRT)가 나중에** 읽는데 둘이 다르게 읽는다:
 *  · CRT 는 `\"` 를 리터럴 따옴표로 본다. cmd 는 백슬래시를 모르고 **따옴표 개수만 센다.**
 *  → `\"` 하나가 cmd 의 따옴표 짝을 뒤집고, 그 뒤의 `& | < >` 가 데이터가 아니라 연산자가 된다.
 *
 * 2026-08-30 실측(윈도우 11 + 진짜 npm 셔임) — 옛 인코딩이 보낸 것과 도착한 것:
 *   ["a b", 'c"d', "e%F%g", "h&i", "j^k"] → ["a b", 'c"d', "e%F%g", "h"]
 *   `&` 가 인자를 자르고 그 뒤를 **명령으로 실행했다.** `%USERNAME%` 은 값으로 펴져서 도착했다.
 *
 * 규칙 넷, 하나씩 같은 방식으로 확인했다:
 *  ① 내장 따옴표는 `\"` 가 아니라 `""` — 둘 다 CRT 는 리터럴로 읽지만 `""` 만 cmd 의 개수를 짝수로 남긴다.
 *  ② `%` 는 **인용 밖으로** 빼서 `"^%"` — 인용 안에서는 캐럿이 이스케이프가 아니라 글자라
 *     `e^%F^%g` 가 캐럿째 도착한다(실측). 밖에서만 `^` 가 확장을 막는다.
 *  ③ 인용을 닫기 전 백슬래시 런은 두 배로 — 안 그러면 그 백슬래시가 닫는 따옴표를 먹는다
 *     (`C:\Users\%USERNAME%\` 가 깨지는 자리).
 *  ④ CR/LF·NUL 은 인코딩하지 않고 **거부한다.** cmd 는 따옴표 상태와 무관하게 raw 개행에서 명령을
 *     끝낸다 — 이스케이프가 없다. 조용히 잘린 명령을 실행하느니 크게 실패한다.
 *
 * 사람이 친 글자가 argv 에 없다는 규칙은 그대로다(질문은 stdin 으로만 간다). 이 인코딩이 필요한
 * 이유는 그 규칙이 깨질 날이 아니라 **우리가 만드는 값에 이미 위험한 글자가 있어서**다 — 윈도우
 * 계정 이름에는 `&` 와 `%` 가 들어갈 수 있고, 그 이름이 곧 `--mcp-config` 경로다.
 */
export function encodeWinArg(a: string): string {
  if (/[\r\n\0]/.test(a)) throw new Error(`윈도우 명령줄에 개행·NUL 을 담을 수 없다: ${JSON.stringify(a)}`)
  let out = '"'
  let bs = 0 // 아직 안 뱉은 백슬래시 개수
  for (const ch of a) {
    if (ch === '\\') {
      bs++
      continue
    }
    // 따옴표 앞·인용을 닫기 전의 백슬래시는 두 배로(③)
    if (ch === '"') {
      out += '\\'.repeat(bs * 2) + '""'
      bs = 0
      continue
    }
    if (ch === '%') {
      out += '\\'.repeat(bs * 2) + '"^%"'
      bs = 0
      continue
    }
    out += '\\'.repeat(bs) + ch
    bs = 0
  }
  return out + '\\'.repeat(bs * 2) + '"'
}

/**
 * cmd.exe 에 넘길 argv. `shell: true` 는 인자를 **공백으로 잇기만** 하고 인용은 호출자에게 미루므로
 * 우리가 직접 cmd 를 부른다 — 그래야 이 플래그들을 우리가 고른다:
 *  `/d` AutoRun 레지스트리 명령 무시 · `/v:off` 지연 확장 끔(`!` 이 글자로 남는다) ·
 *  `/s` 바깥 따옴표를 **정확히 한 겹** 벗김 · `/c` 실행하고 끝.
 */
export function cmdExeArgs(bin: string, args: string[]): string[] {
  return ['/d', '/v:off', '/s', '/c', `"${[binToken(bin), ...args.map(encodeWinArg)].join(' ')}"`]
}

/**
 * 실행 파일 이름은 **모양이 안전하면 인용하지 않는다.** npm 셔임은 `%~dp0` 로 자기 옆의
 * `claude.exe` 를 찾는데(이 PC 의 `claude.cmd` 가 그렇다), `"claude"` 로 인용해 부르면 `%0` 에
 * 따옴표가 그대로 들어가 `%~dp0` 가 **셔임 폴더가 아니라 현재 폴더**로 펴진다 — CLI 가 통째로
 * 안 뜬다(2026-08-30 실측). 인용이 필요한 모양(공백 든 전체 경로)은 인용해도 `%~dp0` 가 맞게
 * 나온다(같은 실측) — 그래서 위험한 글자가 있을 때만 인코딩한다.
 */
function binToken(bin: string): string {
  return /^[A-Za-z0-9._:\\/@-]+$/.test(bin) ? bin : encodeWinArg(bin)
}

function realSpawn(bin: string, args: string[], cwd: string): EngineProc {
  // 윈도우가 아니면 셸을 아예 안 거친다 — 인용도 인코딩도 필요 없다. (sh 는 큰따옴표 안에서도
  // `$(...)` 를 펴기 때문에 셸을 끼우는 것 자체가 위험이었다 — 2026-08-30 실측.)
  const p =
    process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', cmdExeArgs(bin, args), {
          cwd,
          // 우리가 만든 줄을 libuv 가 CommandLineToArgvW 규칙으로 다시 인용하지 못하게 한다.
          windowsVerbatimArguments: true,
          windowsHide: true
        })
      : spawn(bin, args, { cwd })
  return p as unknown as EngineProc
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

    setModel: (model) => write(modelLine(randomUUID(), model)),

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
