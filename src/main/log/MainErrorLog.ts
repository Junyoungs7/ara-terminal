// main 프로세스 오류 파일 로그 — 실행 중인 앱의 stderr 는 사용자 눈에 닿지 않는다.
// 준영님이 "오류 창이 뜬다"고 하셔도 스택이 어디에도 남지 않아 무엇이 던졌는지 가릴 수가 없었다
// (FIX-shutdown §4). 그래서 SessionLog 와 **같은 logs 디렉토리**에 한 항목씩 append 한다 —
// 새 로거·새 설정·새 보존 정책을 만들지 않는다.
//
// 기록 전 반드시 마스킹한다: F12 와 같은 선이다(비밀은 파일에 잠깐도 닿지 않는다).
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { maskSecrets } from '@shared/maskSecrets'

export const MAIN_ERROR_LOG_NAME = 'main-error.log'
// 상한. 넘으면 잘라 낸다 — 회전 세대를 두지 않는다(다음 재발을 잡는 게 목적이라 최신 쪽이 중요하다).
export const MAIN_ERROR_LOG_MAX_BYTES = 1024 * 1024
export const TRUNCATED_NOTICE = '(상한 도달 — 이전 기록을 잘라 냈습니다)'

export function mainErrorLogPath(): string {
  return join(app.getPath('userData'), 'logs', MAIN_ERROR_LOG_NAME)
}

// 한 항목 = 타임스탬프 + 발생 지점 + 스택. 뒤에 빈 줄을 둬 항목 경계를 눈으로 가를 수 있게 한다.
export function formatMainError(scope: string, err: unknown, now = new Date()): string {
  const body = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)
  return `[${now.toISOString()}] ${scope}\n${maskSecrets(body)}\n\n`
}

// 절대 던지지 않는다 — 오류를 남기려다 새 오류를 만들면 안 된다.
// stderr 에도 그대로 쓴다(개발 중 버그를 파일 뒤로 숨기지 않는다 — index.ts 안전망 주석과 같은 이유).
export function logMainError(scope: string, err: unknown): void {
  const entry = formatMainError(scope, err)
  process.stderr.write(`[main] ${entry}`)
  try {
    const path = mainErrorLogPath()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const size = existsSync(path) ? statSync(path).size : 0
    if (size + Buffer.byteLength(entry) > MAIN_ERROR_LOG_MAX_BYTES) {
      writeFileSync(path, `[${new Date().toISOString()}] ${TRUNCATED_NOTICE}\n\n`)
    }
    appendFileSync(path, entry)
  } catch {
    /* 디스크 가득·권한 등 — 기록 실패로 앱을 죽이지 않는다 */
  }
}
