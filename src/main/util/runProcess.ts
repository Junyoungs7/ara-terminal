import { execFile, spawn, type ChildProcess } from 'node:child_process'

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
}

export type RunResult = {
  /** 종료코드. 숫자가 없는 실패(못 찾음·시간 초과로 죽임)는 1. */
  code: number
  stdout: string
  stderr: string
  error: Error | null
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
        signal: opts.signal
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code
        resolve({
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          error: err
        })
      }
    )
    if (opts.onStdout) child.stdout?.on('data', (d: Buffer | string) => opts.onStdout?.(String(d)))
    if (opts.onStderr) child.stderr?.on('data', (d: Buffer | string) => opts.onStderr?.(String(d)))
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}) // 먼저 끝난 프로세스 — 결과는 콜백이 알린다
      child.stdin?.end(opts.input)
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
