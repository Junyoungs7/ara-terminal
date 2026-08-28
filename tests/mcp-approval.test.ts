// F23 승인 게이트 단위 테스트 — HTTP·MCP SDK 없이 McpApprovalManager/createAuditLog 만 검증한다.
// 설계 §8 체크리스트 중 "승인·자동허용·레이트리밋"·"감사 추적" 항을 여기서 어서션으로 증명한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// tools.ts 는 fs/LocalFs 를 거쳐 electron 의 shell 을 잡는다. 여기서 보는 것은 승인 등급뿐이라
// 껍데기로 세운다(tests/secrets.test.ts 와 같은 방식).
vi.mock('electron', () => ({ shell: { openPath: () => {} }, app: { getPath: () => tmpdir() } }))
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpApprovalManager, NEW_SESSION, type ApprovalEmit } from '../src/main/mcp/approval'
import { createAuditLog, type AuditLog, type AuditRecord } from '../src/main/mcp/auditLog'
import { MCP_RATE_LIMIT_PER_MIN, MCP_AUTO_ALLOW_MAX_MINUTES } from '../src/shared/types'
import type { McpApprovalRequest, McpActivity } from '../src/shared/types'
import { buildAraTools, type ToolCtx } from '../src/main/mcp/tools'

function collector() {
  const approvalRequests: McpApprovalRequest[] = []
  const activity: McpActivity[] = []
  let stateChangedCount = 0
  const emit: ApprovalEmit = {
    approvalRequest: (r) => approvalRequests.push(r),
    activity: (a) => activity.push(a),
    stateChanged: () => (stateChangedCount += 1)
  }
  return { emit, approvalRequests, activity, get stateChangedCount() { return stateChangedCount } }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ev-mcp-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function readAuditLines(d: string): AuditRecord[] {
  const files = readdirSync(d).filter((f) => f.endsWith('.jsonl'))
  return files.flatMap((f) => readFileSync(join(d, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditRecord))
}

describe('McpApprovalManager — 3모드 × 툴 분류 매트릭스', () => {
  it('readOnly 클래스는 모드와 무관하게 즉시 허용된다(승인 다이얼로그 없음)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'readOnly')
    const r = await mgr.runTool('s1', 'session_read', 'readOnly', '{}', async () => 'ok')
    expect(r).toEqual({ ok: true, result: 'ok' })
    expect(c.approvalRequests).toHaveLength(0)
  })

  it('writeAlways 클래스는 readOnly 모드에서 승인 요청 없이 즉시 거부된다(킬 스위치 중 새 쓰기 시도)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'readOnly')
    const r = await mgr.runTool('s1', 'session_destroy', 'writeAlways', '{}', async () => 'never')
    expect(r.ok).toBe(false)
    expect(c.approvalRequests).toHaveLength(0) // 대기 없이 즉시 거부
  })

  it('sessionInput 클래스는 autoAllow 에서 승인 없이 자동 실행된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 10)
    const r = await mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'typed')
    expect(r).toEqual({ ok: true, result: 'typed' })
    expect(c.approvalRequests).toHaveLength(0)
  })

  it('writeAlways 클래스는 autoAllow 에서도 매번 승인을 요구한다(설계 §2.3-5)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 10)
    const p = mgr.runTool('s1', 'session_destroy', 'writeAlways', '{}', async () => 'destroyed')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1)
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'approve' })
    const r = await p
    expect(r).toEqual({ ok: true, result: 'destroyed' })
  })

  it('approval 모드의 session_input 은 승인 대기 후 [승인]으로 실행된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit) // 기본 approval
    const p = mgr.runTool('s1', 'session_input', 'sessionInput', '{"data":"ls"}', async () => 'ran')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1)
    expect(c.approvalRequests[0].sessionId).toBe('s1')
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'approve' })
    expect(await p).toEqual({ ok: true, result: 'ran' })
  })

  it('[거부]를 누르면 실행되지 않는다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    let executed = false
    const p = mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => {
      executed = true
      return 'x'
    })
    await new Promise((r) => setTimeout(r, 10))
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'deny' })
    const r = await p
    expect(r.ok).toBe(false)
    expect(executed).toBe(false)
  })

  it('타임아웃되면 거부로 처리되고 실행되지 않는다(무기한 대기 없음)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit, 30) // 테스트 seam: 30ms 타임아웃
    let executed = false
    const r = await mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => {
      executed = true
      return 'x'
    })
    expect(r.ok).toBe(false)
    expect(executed).toBe(false)
    const records = readAuditLines(dir)
    expect(records.at(-1)?.outcome).toBe('timeout')
  })

  it('[이 세션 자동 허용]을 누르면 그 호출도 승인되고 세션이 autoAllow 로 전환된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    const p = mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'first')
    await new Promise((r) => setTimeout(r, 10))
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'autoAllow', minutes: 10 })
    expect(await p).toEqual({ ok: true, result: 'first' })
    // 다음 session_input 은 다이얼로그 없이 자동 실행된다.
    const r2 = await mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'second')
    expect(r2).toEqual({ ok: true, result: 'second' })
    expect(c.approvalRequests).toHaveLength(1) // 두 번째 호출은 다이얼로그를 새로 띄우지 않았다
  })
})

describe('McpApprovalManager — 자동허용 만료', () => {
  it('만료 시각이 지나면 조용히 approval 로 복귀한다(무기한 자동허용 없음)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', -1) // 이미 만료된 시각(음수 분)으로 즉시 재현
    expect(mgr.modeOf('s1')).toBe('approval')
    const list = mgr.list()
    expect(list.find((s) => s.sessionId === 's1')?.mode).toBe('approval')
  })

  // D3(F23 보안 리뷰) 회귀 — minutes 에 상한이 없으면 무기한 autoAllow 가 표현 가능해진다.
  it('D3: minutes=Infinity/MAX_SAFE_INTEGER 도 상한(MCP_AUTO_ALLOW_MAX_MINUTES)으로 클램프된다', () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    const maxUntil = Date.now() + MCP_AUTO_ALLOW_MAX_MINUTES * 60_000 + 1000 // 여유 1초
    mgr.setMode('s1', 'autoAllow', Infinity)
    mgr.setMode('s2', 'autoAllow', Number.MAX_SAFE_INTEGER)
    for (const id of ['s1', 's2']) {
      const s = mgr.list().find((x) => x.sessionId === id)
      expect(s?.autoAllowUntil).toBeDefined()
      expect(s!.autoAllowUntil!).toBeLessThanOrEqual(maxUntil)
      expect(Number.isFinite(s!.autoAllowUntil)).toBe(true) // 무기한이 아니다
    }
  })
})

describe('McpApprovalManager — 사람 입력 감지(설계 §3.3)', () => {
  it('사람이 타이핑하면(onHumanInput) autoAllow 가 즉시 해제되고 다시 켜야 한다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 10)
    expect(mgr.modeOf('s1')).toBe('autoAllow')
    mgr.onHumanInput('s1')
    expect(mgr.modeOf('s1')).toBe('approval')
    // 조용히 재개되지 않는다 — session_input 이 다시 다이얼로그를 띄운다.
    const p = mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'x')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1)
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'deny' })
    await p
  })

  it('approval/readOnly 모드에서는 사람 입력이 아무 것도 바꾸지 않는다(무해한 no-op)', () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.onHumanInput('never-touched') // 존재하지 않는 세션 — 유령 항목을 만들지 않는다
    expect(mgr.list().find((s) => s.sessionId === 'never-touched')).toBeUndefined()
  })
})

describe('McpApprovalManager — 레이트리밋(모드 무관, 설계 §2.3-1)', () => {
  it(`분당 ${MCP_RATE_LIMIT_PER_MIN}회를 넘으면 rateLimited 로 거부되고 autoAllow 가 강제로 강등된다`, async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 10)
    for (let i = 0; i < MCP_RATE_LIMIT_PER_MIN; i++) {
      const r = await mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'ok')
      expect(r.ok).toBe(true)
    }
    expect(mgr.modeOf('s1')).toBe('autoAllow') // 아직 상한 안 넘음
    const over = await mgr.runTool('s1', 'session_input', 'sessionInput', '{}', async () => 'never')
    expect(over.ok).toBe(false)
    expect(mgr.modeOf('s1')).toBe('approval') // 초과 즉시 강등
  })

  it('읽기 전용 툴도 레이트리밋을 피해가지 못한다(무제한 연사 방지)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    for (let i = 0; i < MCP_RATE_LIMIT_PER_MIN; i++) {
      await mgr.runTool('s2', 'session_list', 'readOnly', '{}', async () => 'ok')
    }
    const over = await mgr.runTool('s2', 'session_list', 'readOnly', '{}', async () => 'never')
    expect(over.ok).toBe(false)
  })
})

describe('McpApprovalManager — 킬 스위치(인계, 설계 §2.4)', () => {
  it('인계하면 전 세션이 즉시 readOnly 로 전환되고 대기 중 승인 요청은 즉시 거부된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 10)
    const p = mgr.runTool('s2', 'session_destroy', 'writeAlways', '{}', async () => 'never')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1) // s2 의 승인 요청이 떠 있다

    mgr.handback()

    expect(mgr.modeOf('s1')).toBe('readOnly')
    expect(mgr.modeOf('s2')).toBe('readOnly')
    const r = await p // 대기 중이던 s2 요청도 즉시 거부됨
    expect(r.ok).toBe(false)
  })

  it('인계 후에도 session_list 같은 읽기는 계속 된다(AI는 계속 읽을 수 있다)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'approval')
    mgr.handback()
    const r = await mgr.runTool('s1', 'session_list', 'readOnly', '{}', async () => ['a'])
    expect(r).toEqual({ ok: true, result: ['a'] })
  })

  // D2(F23 보안 리뷰) 회귀 — 인계 직후에도 session_create/ssh_connect(sessionId=null)는 계속
  // 승인을 요구해 승인 피로 공격(다이얼로그 폭탄)에 노출됐고, 실수로 승인되면 새 세션이 인계의
  // 보호 범위(readOnly) 밖(기본값 approval)에서 시작했다. 전역 handedBack 플래그로 다이얼로그
  // 자체를 없앤다.
  it('D2: 인계 후 session_create N회 시도 -> 다이얼로그 0개, 전부 거부로 감사 기록', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.handback()
    const results = await Promise.all(
      Array.from({ length: 25 }, () => mgr.runTool(null, 'session_create', 'writeAlways', '{}', async () => 'created'))
    )
    expect(c.approvalRequests).toHaveLength(0) // 다이얼로그 폭탄 없음
    expect(results.every((r) => r.ok === false)).toBe(true) // 전부 거부 — 세션 미생성
    const records = readAuditLines(dir)
    expect(records).toHaveLength(25)
    // 처음 20회는 handedBack 즉시거부('denied'), 나머지는 레이트리밋('rateLimited') — 어느 쪽이든
    // 승인('approved'/'auto')은 단 하나도 없다(다이얼로그가 아예 없었으므로 당연하다).
    expect(records.every((r) => r.outcome === 'denied' || r.outcome === 'rateLimited')).toBe(true)
  })

  it('D2: 인계 해제(resumeControl)는 사용자가 명시적으로 호출할 때만 되고, 이후엔 정상 승인 흐름으로 돌아온다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.handback()
    expect(mgr.isHandedBack()).toBe(true)
    const blocked = await mgr.runTool(null, 'ssh_connect', 'writeAlways', '{}', async () => 'never')
    expect(blocked.ok).toBe(false)
    expect(c.approvalRequests).toHaveLength(0)

    mgr.resumeControl()
    expect(mgr.isHandedBack()).toBe(false)
    const p = mgr.runTool(null, 'session_create', 'writeAlways', '{}', async () => 'created')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1) // 해제 후에는 다시 정상적으로 다이얼로그가 뜬다
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'approve' })
    expect(await p).toEqual({ ok: true, result: 'created' })
  })
})

describe('McpApprovalManager — 감사 fail-closed(설계 §4.3-2, D3급 결함 회귀 테스트)', () => {
  it('감사 로그 쓰기가 실패하면 승인 여부와 무관하게 실행되지 않는다', async () => {
    const c = collector()
    const failingAudit: AuditLog = {
      dir,
      write: () => {
        throw new Error('디스크 풀 시뮬레이션')
      },
      sweep: () => 0
    }
    const mgr = new McpApprovalManager(c.emit, failingAudit)
    let executed = false
    // readOnly 라 정상이면 즉시 허용됐을 호출도 감사 실패 시 거부되어야 한다.
    const r = await mgr.runTool('s1', 'session_list', 'readOnly', '{}', async () => {
      executed = true
      return 'x'
    })
    expect(r.ok).toBe(false)
    expect(executed).toBe(false) // fail-closed — 로그 실패 시 실행 전이므로 실행하지 않는다
  })

  it('감사 기록이 정상이면 성공·거부·타임아웃 모든 경로가 정확히 한 번씩 기록된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    await mgr.runTool('s1', 'session_list', 'readOnly', '{}', async () => 'a') // auto
    mgr.setMode('s1', 'readOnly')
    await mgr.runTool('s1', 'session_destroy', 'writeAlways', '{}', async () => 'b') // denied(readOnly)
    const records = readAuditLines(dir)
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.outcome).sort()).toEqual(['auto', 'denied'])
    // seq 단조 증가(갭 탐지 가능, 설계 §4.1).
    expect(records[1].seq).toBe(records[0].seq + 1)
  })

  it('args/resultSummary 가 기록 직전 마스킹된다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    await mgr.runTool('s1', 'session_input', 'readOnly', JSON.stringify({ sessionId: 's1', data: 'export TOKEN=supersecret123' }), async () => 'ok')
    const raw = readAuditLines(dir).map((r) => JSON.stringify(r)).join('\n')
    expect(raw).not.toContain('supersecret123')
    expect(raw).toContain('****')
  })
})

describe('McpApprovalManager — 세션 없는 툴(session_create/ssh_connect)', () => {
  it('NEW_SESSION 예약 id 는 세션 목록(list)에 나타나지 않는다(유령 세션 방지)', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    const p = mgr.runTool(null, 'session_create', 'writeAlways', '{}', async () => 'created')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.approvalRequests).toHaveLength(1)
    expect(c.approvalRequests[0].sessionId).toBe(NEW_SESSION)
    expect(mgr.list().some((s) => s.sessionId === NEW_SESSION)).toBe(false)
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'approve' })
    expect(await p).toEqual({ ok: true, result: 'created' })
  })
})

describe('createAuditLog — 보존 스윕', () => {
  it('retentionDays=0(무제한)이면 아무것도 지우지 않는다', () => {
    const audit = createAuditLog(dir)
    audit.write({ at: Date.now(), sessionId: 's1', tool: 't', args: '{}', mode: 'approval', outcome: 'auto', resultSummary: 'x' })
    expect(audit.sweep(0)).toBe(0)
    expect(readAuditLines(dir)).toHaveLength(1)
  })
})

// S3(GAP #6/FIX-mcpshell) — 세션이 종료돼도 sessions Map 이 절대 지워지지 않아 상태바 인디케이터에
// 유령 세션이 영구히 남았다(재현: registerSessionIpc 의 onExit 훅에 forget() 호출이 없던 코드로
// session_destroy 후 mgr.list() 를 확인하면 항목이 그대로 남아 있었다 — agent_talk/FIX-mcpshell-done.md
// 참조). forget() 은 기존 stopSession 류 훅(F8 포워딩 정리)과 같은 자리에서 호출된다(main/index.ts).
describe('McpApprovalManager.forget — 세션 종료 시 유령 세션 정리(S3)', () => {
  it('세션 종료 훅에서 forget() 을 부르면 그 세션이 list() 에서 사라진다', async () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 5) // session_input 등으로 상태가 만들어진 상황을 흉내
    expect(mgr.list().some((s) => s.sessionId === 's1')).toBe(true)

    mgr.forget('s1')

    expect(mgr.list().some((s) => s.sessionId === 's1')).toBe(false)
  })

  it('forget() 이후 같은 sessionId 가 재사용되면 이전 autoAllow 잔재 없이 기본 모드(approval)로 새로 시작한다', () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.setMode('s1', 'autoAllow', 5)
    mgr.forget('s1')
    expect(mgr.modeOf('s1')).toBe('approval')
  })

  it('존재하지 않는 sessionId 에 forget() 을 불러도 안전하고 stateChanged 를 쏘지 않는다', () => {
    const c = collector()
    const audit = createAuditLog(dir)
    const mgr = new McpApprovalManager(c.emit, audit)
    mgr.forget('never-existed')
    expect(c.stateChangedCount).toBe(0)
  })
})

/**
 * ★ 2026-08-28 배포 전 감사 — **server_run 의 sudo 가 승인을 통째로 건너뛰었다.**
 *
 * 등급을 `COMMANDS[cmdId]?.write === true` 로만 정했는데, `args` 는 `z.record(...unknown)` 이라
 * `{sudo:true}` 가 그대로 통과한다. 그런데 sudo 로 감싸는 셋(ctr.list·k8s.list·app.trace)은
 * **읽기 명령이라 `write` 가 없다** → `readOnly` → 자동 허용. 즉 아라가 다이얼로그 없이
 * 원격 root 실행을 할 수 있었다.
 *
 * 여기서 보는 것은 **등급 계산이 아니라 그 결과**다: readOnly 모드(킬 스위치)에서
 * writeAlways 는 승인 요청 없이 즉시 거부된다 — 그 거부가 곧 "승인 대상으로 분류됐다"는 증거다.
 */
describe('server_run 등급 — 권한 올리기는 승인을 받는다', () => {
  const buildGate = (mgr: McpApprovalManager, ran: string[]) =>
    buildAraTools({
      approval: mgr,
      sessions: { has: () => true },
      // 실행까지 간 호출만 여기에 쌓인다 — 거부되면 exec 자체가 안 돌아간다.
      remote: {
        run: async (_s: string, id: string) => {
          ran.push(id)
          return { ok: true as const, out: '', code: 0 }
        }
      }
    } as unknown as ToolCtx)

  it('★ {sudo:true} 면 write 플래그가 없는 ctr.list 도 승인 대상이다 — 킬 스위치가 막는다', async () => {
    const c = collector()
    const mgr = new McpApprovalManager(c.emit, createAuditLog(dir))
    const ran: string[] = []
    const gate = buildGate(mgr, ran)
    mgr.setMode('s1', 'readOnly') // 사람이 "쓰기 금지" 로 내려 둔 상태

    const denied = await gate.call('server_run', { sessionId: 's1', cmdId: 'ctr.list', args: { sudo: true } })
    expect(denied.isError).toBe(true)
    expect(ran).toEqual([]) // 원격에 나가지도 않았다
    expect(c.approvalRequests).toHaveLength(0) // readOnly 모드는 대기 없이 즉시 거부한다

    // 같은 명령이라도 권한 올리기가 아니면 읽기다 — 고치면서 평범한 조회를 막지 않았다.
    const plain = await gate.call('server_run', { sessionId: 's1', cmdId: 'ctr.list' })
    expect(plain.isError).toBeUndefined()
    expect(ran).toEqual(['ctr.list'])
  })

  it('★ 기본(approval) 모드에서는 사람에게 승인 창이 뜬다 — 예전엔 조용히 실행됐다', async () => {
    const c = collector()
    const mgr = new McpApprovalManager(c.emit, createAuditLog(dir))
    const ran: string[] = []
    const gate = buildGate(mgr, ran)

    const pending = gate.call('server_run', { sessionId: 's1', cmdId: 'app.trace', args: { port: 8000, sudo: true } })
    await vi.waitFor(() => expect(c.approvalRequests).toHaveLength(1))
    expect(c.approvalRequests[0].tool).toBe('server_run')
    mgr.respond({ requestId: c.approvalRequests[0].requestId, decision: 'approve' })
    await pending
    expect(ran).toEqual(['app.trace']) // 사람이 승인한 뒤에야 나간다
  })
})
