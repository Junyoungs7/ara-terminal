// F23 MCP IPC 핸들러 — mcp:* 채널(설계 §6). 렌더러는 상태를 보고 승인 UI를 그리는 것뿐이다 — MCP
// 프로토콜 자체(HTTP 리스너·SDK)는 여기서 만지지 않는다. SDK import 는 main/mcp/McpServer.ts 안에만
// 있다(렌더러가 SDK·리스너를 직접 만지지 않는다는 계약을 소스 스캔으로 확인할 수 있는 형태).
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { McpState } from '@shared/types'
import { McpApprovalManager, type ApprovalEmit } from '../mcp/approval'
import { createAuditLog } from '../mcp/auditLog'
import { createMcpServer, issueRawToken, hashToken, MCP_TOKEN_VAULT_KEY, type TokenVault, type McpServerHandle } from '../mcp/McpServer'
import type { ToolCtx } from '../mcp/tools'
import { pushSend } from '../util/windowPush'

export type McpRuntime = { server: McpServerHandle; approval: McpApprovalManager }

// deps: MCP 툴이 직접 호출할 기존 서비스 객체들(approval 은 여기서 만들어 채운다).
// vault: 토큰 해시 저장(SafeStorageSecretStore 재사용 — 새 vault 를 만들지 않는다).
// retentionDays: F12 와 같은 보존 설정 공유(설계 §4.1 — MCP 전용 정책을 새로 만들지 않는다).
export function registerMcpIpc(
  deps: Omit<ToolCtx, 'approval'>,
  vault: TokenVault,
  logDir: string,
  retentionDays: () => number,
  getWebContents: () => WebContents | null
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
  const ctx: ToolCtx = { ...deps, approval }
  const server = createMcpServer(ctx, vault)

  handle('mcp:getState', () => state())
  handle('mcp:setEnabled', ({ enabled }) => server.setEnabled(enabled))
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

  return { server, approval }
}
