// F23 MCP 감사 로그 — F12 SessionLog 와 같은 디렉토리(userData/logs)·같은 보존 정책(retentionDays)을
// 공유한다(설계 §4.1). 새 디렉토리·새 보존 설정을 만들지 않는다. append-only JSONL, 날짜별 파일 —
// 스윕이 SessionLog.sweep() 과 같은 패턴(파일명 정규식 + mtime 컷오프)으로 파일 단위로 지운다.
//
// fail-closed(설계 §4.3): write() 는 실패하면 예외를 삼키지 않고 그대로 던진다 — 호출측(approval.ts의
// 단일 진입점)이 이걸 "감사 기록 실패 = 실행 거부"로 처리한다. 여기서 catch 하면 그 계약이 깨진다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { maskSecrets } from '@shared/maskSecrets'
import type { McpSessionMode } from '@shared/types'

export type AuditOutcome = 'auto' | 'approved' | 'denied' | 'timeout' | 'rateLimited'

export type AuditRecord = {
  seq: number
  at: number
  sessionId: string
  tool: string
  args: string
  mode: McpSessionMode
  outcome: AuditOutcome
  resultSummary: string
}

// 스윕이 지울 수 있는 파일 이름(SessionLog.LOG_NAME_RE 와 같은 역할 — 우리가 만든 것만 지운다).
export const AUDIT_NAME_RE = /^mcp-actions_\d{8}\.jsonl$/
const DAY_MS = 24 * 60 * 60 * 1000

function dateStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export type AuditLog = {
  // 기록 — seq/args/resultSummary 마스킹은 여기서 채운다. 쓰기 실패 시 던진다(fail-closed).
  write(rec: { at: number; sessionId: string; tool: string; args: string; mode: McpSessionMode; outcome: AuditOutcome; resultSummary: string }): void
  // 보존 스윕. 삭제한 파일 수를 돌려준다(테스트용) — F12 SessionLogService.sweep() 과 같은 계약.
  sweep(retentionDays: number): number
  dir: string
}

export function createAuditLog(dir: string): AuditLog {
  let seq = 0

  function ensureDir(): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  return {
    dir,

    write(rec) {
      ensureDir()
      seq += 1
      const full: AuditRecord = {
        seq,
        at: rec.at,
        sessionId: rec.sessionId,
        tool: rec.tool,
        mode: rec.mode,
        outcome: rec.outcome,
        // 기록 직전 마스킹(F12·F16 과 같은 자리, 같은 함수) — 원문이 파일에 잠깐도 닿지 않는다.
        args: maskSecrets(rec.args),
        resultSummary: maskSecrets(rec.resultSummary)
      }
      const path = join(dir, `mcp-actions_${dateStamp(new Date(full.at))}.jsonl`)
      appendFileSync(path, JSON.stringify(full) + '\n', 'utf8')
    },

    sweep(retentionDays) {
      if (!retentionDays || retentionDays <= 0) return 0 // 0 = 무제한(F12 와 같은 값 의미)
      ensureDir()
      const cutoff = Date.now() - retentionDays * DAY_MS
      let removed = 0
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return 0
      }
      for (const name of names) {
        if (!AUDIT_NAME_RE.test(name)) continue
        const path = join(dir, name)
        try {
          const st = statSync(path)
          if (!st.isFile() || st.mtimeMs >= cutoff) continue
          unlinkSync(path)
          removed++
        } catch {
          /* 다른 프로세스가 잡고 있음 등 — 다음 기동에 다시 시도한다 */
        }
      }
      return removed
    }
  }
}
