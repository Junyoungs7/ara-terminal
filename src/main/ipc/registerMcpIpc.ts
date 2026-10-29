// F23 MCP IPC 핸들러 — mcp:* 채널(설계 §6). 렌더러는 상태를 보고 승인 UI를 그리는 것뿐이다 — MCP
// 프로토콜 자체(HTTP 리스너·SDK)는 여기서 만지지 않는다. SDK import 는 main/mcp/McpServer.ts 안에만
// 있다(렌더러가 SDK·리스너를 직접 만지지 않는다는 계약을 소스 스캔으로 확인할 수 있는 형태).
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { McpState } from '@shared/types'
import { McpApprovalManager, type ApprovalEmit } from '../mcp/approval'
import { createAuditLog } from '../mcp/auditLog'
import { createAskUser, type AskRequest, type AskUserManager } from '../mcp/askUser'
import { createMcpServer, issueRawToken, hashToken, MCP_TOKEN_VAULT_KEY, type TokenVault, type McpServerHandle } from '../mcp/McpServer'
import { buildAraTools, type AraToolGate, type ToolCtx } from '../mcp/tools'
import { pushSend } from '../util/windowPush'

export type McpRuntime = {
  server: McpServerHandle
  approval: McpApprovalManager
  ask: AskUserManager
  /** 도구 게이트(2026-08-26). API 엔진이 이걸 그대로 쓴다 — 문·검증·승인이 한 벌이다. */
  gate: AraToolGate
}

// deps: MCP 툴이 직접 호출할 기존 서비스 객체들(approval 은 여기서 만들어 채운다).
// vault: 토큰 해시 저장(SafeStorageSecretStore 재사용 — 새 vault 를 만들지 않는다).
// retentionDays: F12 와 같은 보존 설정 공유(설계 §4.1 — MCP 전용 정책을 새로 만들지 않는다).
export function registerMcpIpc(
  // ask 도 여기서 만든다(#125) — 화면으로 올리는 길이 이 파일에 있으니 주인도 여기가 맞다.
  deps: Omit<ToolCtx, 'approval' | 'ask'>,
  vault: TokenVault,
  logDir: string,
  retentionDays: () => number,
  getWebContents: () => WebContents | null,
  /**
   * 바인드 포트. 안 주면 프로덕션 고정 포트(외부 클라이언트 설정이 바뀌지 않게).
   *
   * **e2e 는 0(임의 포트)을 준다**: 서버가 기본으로 켜지게 된 뒤로(2026-08-26) 테스트 워커들이
   * 앱을 여러 개 동시에 띄우면 전부 같은 고정 포트를 잡으려 해서 하나만 성공한다. 프로덕션은
   * 앱이 하나라 겪지 않는 문제다.
   */
  bindPort?: number,
  /** 2.0 앱 잠금 — 잠긴 동안 외부 도구 요청을 막나(McpServer.createMcpServer 의 isBlocked). */
  isBlocked?: () => boolean
): McpRuntime {
  const push = (channel: string, payload: unknown): void => pushSend(getWebContents(), channel, payload)

  const audit = createAuditLog(logDir)
  audit.sweep(retentionDays())

  const state = (): McpState => ({
    enabled: server.isEnabled(),
    port: server.port(),
    hasToken: vault.has(MCP_TOKEN_VAULT_KEY),
    connected: server.connectedCount(),
    sessions: approval.list(),
    handedBack: approval.isHandedBack()
  })

  const emit: ApprovalEmit = {
    approvalRequest: (r) => push('mcp:approvalRequest', r),
    activity: (a) => push('mcp:activity', a),
    stateChanged: () => push('mcp:stateChanged', state())
  }
  const approval = new McpApprovalManager(emit, audit)
  // AI 가 사람에게 되묻는 길. 헤드리스 Claude Code 에는 그 도구가 없어서 우리가 만든다(설계 §3.4c).
  const ask = createAskUser({
    ask: (r: AskRequest) => push('mcp:ask', r),
    askDone: (askId: string) => push('mcp:askDone', { askId })
  })
  const ctx: ToolCtx = { ...deps, approval, ask }
  // 게이트를 여기서 한 번 만든다 — API 엔진이 쓴다(MCP 서버는 연결마다 같은 표로 따로 만든다).
  // 이 게이트를 부르는 것은 아라 채팅(API 엔진)뿐이라 caller 는 늘 'ara' 다.
  const gate = buildAraTools(ctx, () => 'ara')
  const server = createMcpServer(ctx, vault, bindPort, isBlocked)

  handle('mcp:getState', () => state())
  // 켜고 끄는 것을 **저장한다**(2026-08-26). 기본이 켬이 됐으므로, 끈 선택을 기억하지 않으면
  // 재시작마다 되살아난다. 여기서 저장하는 이유는 이 채널이 유일한 토글 경로이기 때문이다.
  handle('mcp:setEnabled', async ({ enabled }) => {
    const r = await server.setEnabled(enabled)
    deps.ws.setMcpEnabled(enabled)
    return r
  })
  // 새 토큰 발급 = 구 토큰 즉시 무효(vault 의 단일 키를 덮어쓰므로 별도 무효화 로직이 필요 없다).
  handle('mcp:issueToken', () => {
    const token = issueRawToken()
    vault.set(MCP_TOKEN_VAULT_KEY, hashToken(token))
    return { token }
  })
  handle('mcp:disconnectClient', () => {
    server.disconnectClient()
    return { ok: true } as const
  })
  handle('mcp:setSessionMode', ({ sessionId, mode, minutes }) => {
    approval.setMode(sessionId, mode, minutes)
    return { ok: true } as const
  })
  // 인계(kill=false)/중단(kill=true, 설계 §2.4). 인계는 세션 상태만 바꾸고, 중단은 서버까지 끈다.
  handle('mcp:handback', ({ kill }) => {
    approval.handback()
    if (kill) void server.stop()
    return { ok: true } as const
  })
  handle('mcp:resumeControl', () => {
    approval.resumeControl()
    return { ok: true } as const
  })
  handle('mcp:approvalRespond', (d) => {
    approval.respond(d)
    return { ok: true } as const
  })
  // 되묻기 답. 없는 id 는 매니저가 조용히 버린다(늦게 온 답).
  handle('mcp:askAnswer', ({ askId, text }) => {
    ask.answer(askId, text)
    return { ok: true } as const
  })
  handle('mcp:askPending', () => ({ items: ask.pending() }))

  return { server, approval, ask, gate }
}
