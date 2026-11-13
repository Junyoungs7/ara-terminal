import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * 제품(`src/main`)이 프로세스를 띄우는 **단 하나의 길**(셸이 필요한 ClaudeCliEngine 만 예외 —
 * `tests/spawnBoundary.test.ts` 래칫이 지킨다). Orca `@orca/process-host` 의 runProcess
 * (orcaRef 7a7f46f8a3)를 따랐다 — 그쪽의 트리 종료·출력 머리/꼬리 자르기는 아직 쓸 자리가 없어 뺐다.
 *
 * 규칙(호출측이 고를 수 없다):
 *  · **셸을 거치지 않는다** — `execFile` 에 인자를 배열째 넘기므로 인용이라는 개념 자체가 없다.
 *    신뢰 경계 밖의 값은 인자 배열이나 env 로만 넘긴다(명령 문자열에 끼워 넣지 않는다).
 *  · 창을 안 띄운다(windowsHide) · 시간 상한이 늘 있다 · 출력 상한이 늘 있다.
 *    Node 는 `maxBuffer: undefined` 를 **무제한**으로 읽는다 — 그래서 기본값을 여기서 직접 채운다.
 *  · env 는 process.env 위에 **덧붙인다**(통째로 바꾸면 PATH·SystemRoot 가 빠져 실행이 깨진다).
 *
 * 거절하지 않는다. 실패(못 찾음·시간 초과·0 아닌 종료)는 `error` 와 `code` 로 돌려준다.
 */
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BUFFER = 1024 * 1024

export type RunOptions = {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBuffer?: number
  /** 취소(M2 워크트리 생성 — 서브모듈·LFS 가 느릴 수 있다). 끊기면 error.name === 'AbortError'. */
  signal?: AbortSignal
  /** stderr 를 오는 대로 받는다(git 진행 막대). 결과의 stderr 에도 그대로 모인다. */
  onStderr?: (chunk: string) => void
  /** stdout 을 오는 대로 받는다(M6 R2 rg --json 스트리밍 — 결과를 줄 단위로 읽다가 상한에서 signal 로 끊는다). 결과의 stdout 에도 모인다(maxBuffer 안). */
  onStdout?: (chunk: string) => void
  /** stdin 으로 넣고 닫을 글(M5 — 모델 목록·이름 짓기: 사용자 글은 인자가 아니라 stdin 으로). 없으면 예전 그대로. */
  input?: string
  /** M14 R1 사전 점검 — `cmd /d /s /c "<한 줄>"` 을 Node shell:true 와 같게 인용 없이 넘긴다(Windows 만 뜻이 있다). */
  windowsVerbatimArguments?: boolean
  /** 3차 R2-B 결과에 날 바이트(stdoutBytes)도 싣는다. */
  raw?: boolean
  /** 2.2.24 계정 로그인 — 도는 동안 stdin 에 줄을 넣고(CLI 의 'Paste code here') 트리째 끝낼 pid 를 받는다. stdin 은 열어 둔다(input 과 같이 쓰지 않는다). */
  onSpawn?: (c: { pid: number | undefined; write: (s: string) => void }) => void
}

export type RunResult = {
  /** 종료코드. 숫자가 없는 실패(못 찾음·시간 초과로 죽임)는 1. */
  code: number
  stdout: string
  stderr: string
  error: Error | null
  /** 3차 R2-B 날 바이트(그림 비교의 git cat-file blob — 글로 풀면 깨진다). 로컬 runProcess 가 raw 일 때만 채운다. */
  stdoutBytes?: Buffer
}

let cp949: TextDecoder | null | undefined
/**
 * 출력 바이트 → 글. UTF-8 이 아니면(Windows 의 cmd·where 등은 콘솔 코드 페이지 = 한국어 Windows 는 CP949 로 낸다)
 * Windows 에서만 CP949(WHATWG euc-kr)로 **깨짐 없이** 읽힐 때 그것으로. 둘 다 아니면(UTF-8 과 CP949 가 섞인 git diff 등) 예전처럼 UTF-8.
 */
export function decodeOutput(b: Buffer, win = process.platform === 'win32'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    if (win) {
      if (cp949 === undefined) {
        try {
          cp949 = new TextDecoder('euc-kr', { fatal: true })
        } catch {
          cp949 = null // ICU 데이터에 없음 — UTF-8 로
        }
      }
      try {
        if (cp949) return cp949.decode(b)
      } catch {
        /* CP949 도 아님 */
      }
    }
    return b.toString('utf8')
  }
}

export function runProcess(file: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
        signal: opts.signal,
        encoding: 'buffer'
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
          error: err,
          ...(opts.raw ? { stdoutBytes: stdout } : {})
        })
      }
    )
    // 흘려 받기는 UTF-8 그대로(git 진행·rg --json) — 조각 경계에서 글자가 갈리지 않게 StringDecoder 로.
    const live = (s: NodeJS.ReadableStream | null, cb: (chunk: string) => void): void => {
      const d = new StringDecoder('utf8')
      s?.on('data', (b: Buffer) => cb(d.write(b)))
    }
    if (opts.onStdout) live(child.stdout, (c) => opts.onStdout?.(c))
    if (opts.onStderr) live(child.stderr, (c) => opts.onStderr?.(c))
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}) // 먼저 끝난 프로세스 — 결과는 콜백이 알린다
      child.stdin?.end(opts.input)
    } else if (opts.onSpawn) {
      child.stdin?.on('error', () => {})
      opts.onSpawn({ pid: child.pid, write: (s) => void child.stdin?.write(s) })
    }
  })
}

/**
 * M4 DM-01: 앱보다 오래 사는 프로세스(로컬 터미널 데몬)를 띄운다 — 셸 없이·창 없이·앱과 떼어(detached).
 * runProcess 와 같은 규칙(셸 안 거침·인자 배열·windowsHide)이되 끝을 기다리지 않는다: stdout/stderr 만 관으로 주고,
 * 준비를 확인한 쪽이 관을 끊고 `unref()` 해서 놓는다. env 는 덧붙이지 않고 **통째로** 받는다(데몬은 앱의 환경 전체를 물려받아야 한다).
 */
export function spawnDetached(file: string, args: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(file, [...args], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}
