// M14 R1 AU-01 사전 점검 — Orca src/main/automations/precheck-runner.ts 의 로컬 갈래.
// 명령은 사용자가 적은 셸 한 줄이라 셸로 돌린다(Windows cmd /d /s /c, 그 밖 /bin/sh -c) — 띄우기는 runProcess 래퍼만.
// ponytail: 시간 초과 때 runProcess(execFile timeout)가 셸만 끊는다 — 손자 프로세스 트리 종료(Orca taskkill /t)는 필요해지면.
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '@shared/automations/automation-precheck'
import type { AutomationPrecheck, AutomationPrecheckResult } from '@shared/automations/automations-types'
import { runProcess } from '../util/runProcess'

const tail = (s: string): { content: string; truncated: boolean } =>
  s.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS ? { content: s, truncated: false } : { content: s.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS), truncated: true }

export async function runLocalPrecheck(precheck: AutomationPrecheck, cwd: string): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const win = process.platform === 'win32'
  const r = await runProcess(win ? process.env['ComSpec'] || 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', `"${precheck.command}"`] : ['-c', precheck.command], {
    cwd,
    windowsVerbatimArguments: win,
    timeoutMs: precheck.timeoutSeconds * 1000
  })
  const killed = Boolean((r.error as { killed?: boolean } | null)?.killed)
  const out = tail(r.stdout)
  const err = tail(r.stderr)
  const notFound = (r.error as { code?: unknown } | null)?.code === 'ENOENT'
  const completedAt = Date.now()
  return {
    command: precheck.command,
    exitCode: killed || notFound ? null : r.code,
    timedOut: killed,
    durationMs: completedAt - startedAt,
    stdout: out.content,
    stderr: err.content,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    error: killed ? `Precheck timed out after ${precheck.timeoutSeconds}s.` : notFound ? (r.error?.message ?? 'not found') : null,
    startedAt,
    completedAt
  }
}
