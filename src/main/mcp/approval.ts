// F23 승인 게이트 — 세션별 상태 머신(readOnly/approval/autoAllow) + 레이트리밋 + 감사 기록(fail-closed).
// runTool() 이 모든 MCP 툴 호출의 단일 진입점이다(설계 §4.3) — 인가 판정 → 감사 기록 → (허용 시) 실행
// 순서가 고정이다: 감사 기록을 실행보다 앞에 둬야 "기록 실패 = 실행 거부"가 실제로 성립한다(실행 뒤에
// 로그가 실패하면 이미 벌어진 일을 되돌릴 수 없다 — 그래서 로그를 먼저 확정한다).
import { randomUUID } from 'node:crypto'
import {
  MCP_AUTO_ALLOW_MINUTES,
  MCP_AUTO_ALLOW_MAX_MINUTES,
  MCP_RATE_LIMIT_PER_MIN,
  MCP_APPROVAL_TIMEOUT_MS,
  type McpApprovalRequest,
  type McpApprovalDecision,
  type McpSessionMode,
  type McpSessionState,
  type McpActivity
} from '@shared/types'
import type { AuditLog, AuditOutcome } from './auditLog'

// session_create/ssh_connect 처럼 아직 존재하지 않는 세션을 만드는 툴의 승인 요청 표시용 예약 id.
// list()에서 제외한다 — 렌더러 세션 목록에 유령 항목을 만들지 않는다.
export const NEW_SESSION = '(new)'

export type ToolClass = 'readOnly' | 'sessionInput' | 'writeAlways'
/** 누가 불렀나. 'ara' = 아라 채팅(API 엔진 게이트 · 아라 전용 토큰으로 붙은 MCP 연결), 그 밖은 'external'. */
export type Caller = 'ara' | 'external'
/** 사람이 그 세션에 친 뒤 아라의 자동 입력을 멈추는 시간. */
export const HUMAN_PAUSE_MS = 10_000

const DEFAULT_MODE: McpSessionMode = 'approval'
const RATE_WINDOW_MS = 60_000

type Rate = { windowStart: number; count: number }
type SessionEntry = { mode: McpSessionMode; autoAllowUntil: number | null; rate: Rate }
type Pending = { sessionId: string; timer: NodeJS.Timeout; resolve: (d: 'approved' | 'denied' | 'timeout') => void }

export type ApprovalEmit = {
  approvalRequest: (r: McpApprovalRequest) => void
  activity: (a: McpActivity) => void
  // 세션 모드가 바뀔 때(만료·강등·킬스위치·명시적 설정) 호출 — 렌더러가 mcp:getState 로 다시 읽어간다.
  stateChanged: () => void
}

function denyMessage(outcome: AuditOutcome): string {
  switch (outcome) {
    case 'denied':
      return '요청이 거부되었습니다.'
    case 'timeout':
      return '승인 대기 시간이 초과되어 거부되었습니다.'
    case 'rateLimited':
      return '요청이 너무 많아 제한되었습니다. 잠시 후 다시 시도하세요.'
    default:
      return '요청이 거부되었습니다.'
  }
}

export class McpApprovalManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly pending = new Map<string, Pending>()
  private activitySeq = 0
  // D2: 인계 후에도 session_create/ssh_connect(sessionId=null)는 계속 승인을 요구했다 — 승인 피로
  // 공격(다이얼로그 폭탄)에 그대로 노출된다. 인계 중에는 이 툴들을 다이얼로그 없이 즉시 거부한다.
  // 해제는 사용자가 UI에서 명시적으로 조종을 재개할 때만(resumeControl) — 조용히 풀리지 않는다.
  private handedBack = false
  /**
   * 아라 채팅 v2(2026-10-20 준영님 결정): **지금 보는 세션**(렌더러가 알린 활성 탭)에 대한 session_input 은
   * 묻지 않는다 — 단 **아라 채팅이 부른 것**(caller='ara')에만. 외부 MCP 클라이언트는 그대로 묻는다.
   */
  private araTarget: () => string | null = () => null
  // 사람이 그 세션에 친 마지막 시각. 친 직후 잠시는 자동 실행을 멈춘다(손이 핸들을 잡았다).
  private readonly humanAt = new Map<string, number>()

  // approvalTimeoutMs: 테스트 seam(ARA_AI_FAKE 와 같은 관행) — 2분 실시간 대기 없이 타임아웃 경로를
  // 검증하기 위함이다. 프로덕션 호출자는 넘기지 않는다(항상 MCP_APPROVAL_TIMEOUT_MS).
  constructor(
    private readonly emit: ApprovalEmit,
    private readonly audit: AuditLog,
    private readonly approvalTimeoutMs: number = MCP_APPROVAL_TIMEOUT_MS
  ) {}

  private entry(sessionId: string): SessionEntry {
    let e = this.sessions.get(sessionId)
    if (!e) {
      e = { mode: DEFAULT_MODE, autoAllowUntil: null, rate: { windowStart: Date.now(), count: 0 } }
      this.sessions.set(sessionId, e)
    }
    return e
  }

  // 현재 모드(자동허용 만료 확인 포함 — 조회 자체가 만료를 확정하는 부수효과를 가진다).
  modeOf(sessionId: string): McpSessionMode {
    const e = this.entry(sessionId)
    if (e.mode === 'autoAllow' && e.autoAllowUntil !== null && Date.now() > e.autoAllowUntil) {
      e.mode = 'approval'
      e.autoAllowUntil = null
      this.emit.stateChanged()
    }
    return e.mode
  }

  // 렌더러의 세션 목록(McpState.sessions) — session_create/ssh_connect 용 예약 id 는 실제 세션이 아니므로 뺀다.
  list(): McpSessionState[] {
    return [...this.sessions.entries()]
      .filter(([id]) => id !== NEW_SESSION)
      .map(([sessionId, e]) => ({
        sessionId,
        mode: this.modeOf(sessionId),
        ...(e.autoAllowUntil !== null ? { autoAllowUntil: e.autoAllowUntil } : {})
      }))
  }

  // 레이트리밋(모드 무관, 설계 §2.3-1 — 자동 허용도 무제한 연사는 못 한다). 초과 시 강제 강등.
  private checkRate(key: string): boolean {
    const e = this.entry(key)
    const now = Date.now()
    if (now - e.rate.windowStart >= RATE_WINDOW_MS) {
      e.rate.windowStart = now
      e.rate.count = 0
    }
    e.rate.count += 1
    if (e.rate.count > MCP_RATE_LIMIT_PER_MIN) {
      if (e.mode === 'autoAllow') {
        e.mode = 'approval'
        e.autoAllowUntil = null
        this.emit.stateChanged()
      }
      return false
    }
    return true
  }

  // 사람이 타이핑하면(registerSessionIpc의 session:input) 그 세션의 autoAllow 를 즉시 해제한다(설계 §3.3).
  // "손이 핸들을 잡으면 오토파일럿이 풀린다" — 조용히 재개되지 않는다(사람이 다시 켜야 한다).
  onHumanInput(sessionId: string): void {
    this.humanAt.set(sessionId, Date.now())
    const e = this.sessions.get(sessionId)
    if (!e || e.mode !== 'autoAllow') return
    e.mode = 'approval'
    e.autoAllowUntil = null
    this.emit.stateChanged()
  }

  // 킬 스위치 — 인계(설계 §2.4). 전 세션 즉시 readOnly + 대기 중 승인 요청은 즉시 거부.
  // 연결 끊기·서버 중단(kill=true)은 이 클래스 밖(McpServer)의 몫이다 — 여긴 세션 상태만 안다.
  handback(): void {
    this.handedBack = true // D2: 이후 session_create/ssh_connect 도 즉시 거부(authorize() 참조).
    for (const e of this.sessions.values()) {
      e.mode = 'readOnly'
      e.autoAllowUntil = null
    }
    for (const [requestId, p] of [...this.pending.entries()]) {
      clearTimeout(p.timer)
      this.pending.delete(requestId)
      p.resolve('denied')
    }
    this.emit.stateChanged()
  }

  isHandedBack(): boolean {
    return this.handedBack
  }

  // S3(GAP #6): 세션이 끝나면(session_destroy·탭 닫기) 그 세션의 승인 상태도 같이 지운다.
  // 안 지우면 상태바 인디케이터(mcp:getState → sessions)에 이미 닫힌 세션이 유령으로 계속 남는다.
  // registerSessionIpc 의 onExit 훅(F8 포워딩 정리와 같은 자리)에서 호출한다.
  forget(sessionId: string): void {
    this.humanAt.delete(sessionId)
    if (this.sessions.delete(sessionId)) this.emit.stateChanged()
  }

  /** 지금 보는 세션 id 를 알려 주는 함수(registerAraIpc 가 렌더러 보고를 들고 있다). */
  setAraTarget(fn: () => string | null): void {
    this.araTarget = fn
  }

  /** 아라 채팅이 지금 보는 세션에 치는 것인가 — 묻지 않고 실행할 유일한 갈래. */
  private isAraTargetInput(sessionId: string, tool: string, caller: Caller): boolean {
    if (caller !== 'ara' || tool !== 'session_input') return false
    if (sessionId !== this.araTarget()) return false
    const h = this.humanAt.get(sessionId)
    return h === undefined || Date.now() - h >= HUMAN_PAUSE_MS
  }

  // D2: 인계 해제 — 사용자가 UI에서 명시적으로 눌러야만 호출된다(mcp:resumeControl). 개별 세션의
  // readOnly 모드는 그대로 둔다 — "조종 재개"는 새 세션 생성만 다시 허용하는 것이고, 기존 세션을
  // 다시 쓰기 가능하게 만드는 것은 별개 결정(사용자가 세션별로 직접 바꾼다).
  resumeControl(): void {
    this.handedBack = false
    this.emit.stateChanged()
  }

  setMode(sessionId: string, mode: McpSessionMode, minutes?: number): void {
    const e = this.entry(sessionId)
    e.mode = mode
    // D3: minutes 는 렌더러(신뢰 경계 밖) 값이라 상한 없이는 무기한 자동허용이 표현 가능해진다.
    // 하한은 일부러 안 둔다 — 음수·0 은 "이미 만료"를 표현할 뿐 위험이 늘지 않는다(테스트 seam).
    const clamped = Math.min(minutes ?? MCP_AUTO_ALLOW_MINUTES, MCP_AUTO_ALLOW_MAX_MINUTES)
    e.autoAllowUntil = mode === 'autoAllow' ? Date.now() + clamped * 60_000 : null
    this.emit.stateChanged()
  }

  // 승인 다이얼로그 응답(mcp:approvalRespond IPC 전용 — MCP 툴 표면에는 이 채널이 없다. AI 는 자기
  // 요청에 스스로 답할 수 없다). 미지 requestId 는 조용히 무시(타임아웃으로 이미 정리됐을 수 있다).
  respond(d: McpApprovalDecision): void {
    const p = this.pending.get(d.requestId)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(d.requestId)
    if (d.decision === 'autoAllow') {
      this.setMode(p.sessionId, 'autoAllow', d.minutes)
      p.resolve('approved') // 이번 호출 자체도 승인된 것으로 취급(디자인 §2.2 세 번째 버튼)
    } else {
      p.resolve(d.decision === 'approve' ? 'approved' : 'denied')
    }
  }

  private requestApproval(sessionId: string, tool: string, argsSummary: string): Promise<'approved' | 'denied' | 'timeout'> {
    const requestId = randomUUID()
    const expiresAt = Date.now() + this.approvalTimeoutMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve('timeout')
      }, this.approvalTimeoutMs)
      this.pending.set(requestId, { sessionId, timer, resolve })
      this.emit.approvalRequest({ requestId, sessionId, tool, argsSummary, expiresAt })
    })
  }

  // sessionId=null 은 아직 존재하지 않는 세션을 만드는 툴(session_create/ssh_connect) — 모드 검사 없이
  // 항상 승인을 요구한다(참조할 기존 세션이 없다). 그 외에는 세션의 현재 모드로 판정한다.
  private async authorize(
    sessionId: string | null,
    tool: string,
    cls: ToolClass,
    argsSummary: string,
    caller: Caller
  ): Promise<{ allow: boolean; outcome: AuditOutcome }> {
    if (!this.checkRate(sessionId ?? NEW_SESSION)) return { allow: false, outcome: 'rateLimited' }
    if (cls === 'readOnly') return { allow: true, outcome: 'auto' }
    if (sessionId !== null) {
      const mode = this.modeOf(sessionId)
      if (mode === 'readOnly') return { allow: false, outcome: 'denied' }
      if (cls === 'sessionInput' && mode === 'autoAllow') return { allow: true, outcome: 'auto' }
      if (this.isAraTargetInput(sessionId, tool, caller)) return { allow: true, outcome: 'auto' }
      // D2: sessionId===null(session_create/ssh_connect)만 인계의 보호를 벗어나 있었다 — 기존 세션은
      // 이미 handback() 이 readOnly 로 만들어 위 분기에서 걸린다.
    } else if (this.handedBack) {
      return { allow: false, outcome: 'denied' } // 다이얼로그 없이 즉시 거부(승인 피로 공격 차단)
    }
    const decision = await this.requestApproval(sessionId ?? NEW_SESSION, tool, argsSummary)
    return decision === 'approved' ? { allow: true, outcome: 'approved' } : { allow: false, outcome: decision }
  }

  // 단일 진입점. exec 는 인가된 경우에만 호출된다. 반환값은 MCP 툴 결과로 바로 옮길 수 있는 판별 유니온.
  async runTool<T>(
    sessionId: string | null,
    tool: string,
    cls: ToolClass,
    argsSummary: string,
    exec: () => Promise<T>,
    caller: Caller = 'external'
  ): Promise<{ ok: true; result: T } | { ok: false; message: string }> {
    const authz = await this.authorize(sessionId, tool, cls, argsSummary, caller)
    const mode = this.sessions.get(sessionId ?? NEW_SESSION)?.mode ?? DEFAULT_MODE

    let auditFailed = false
    try {
      this.audit.write({
        at: Date.now(),
        sessionId: sessionId ?? NEW_SESSION,
        tool,
        args: argsSummary,
        mode,
        outcome: authz.outcome,
        resultSummary: authz.allow ? `실행: ${tool}` : denyMessage(authz.outcome)
      })
    } catch {
      // fail-closed(설계 §4.3-2): 기록이 실패하면 아직 실행 전이므로 실행하지 않는다.
      auditFailed = true
    }
    this.emit.activity({ seq: (this.activitySeq += 1), at: Date.now(), sessionId: sessionId ?? NEW_SESSION, tool, outcome: authz.outcome })

    if (auditFailed) return { ok: false, message: '감사 로그 기록에 실패하여 요청을 거부했습니다.' }
    if (!authz.allow) return { ok: false, message: denyMessage(authz.outcome) }
    try {
      return { ok: true, result: await exec() }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
}
