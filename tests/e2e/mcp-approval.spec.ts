// F23 MCP 승인 다이얼로그 — 실 MCP 클라이언트 없이도 자동화할 수 있다(팀리드 지시로 재검토).
// mcp:approvalRequest 는 main → renderer push 이벤트일 뿐이라, T1 이 SFTP 파일선택 네이티브 다이얼로그를
// ipcMain 핸들러 교체로 스텁한 것과 같은 결로 main 에서 직접 쏴서 재현할 수 있다(라이브 MCP 서버·클라이언트
// 불필요). 응답(mcp:approvalRespond)은 실 McpApprovalManager 를 거치지 않고 스파이 핸들러로 가로챈다 —
// approval.ts 의 respond() 는 미지 requestId 를 "조용히 무시"하도록 설계돼 있어(타임아웃으로 이미 정리된
// 요청 대비) 실 pending 요청 없이 다이얼로그만 띄워도 앱이 깨지지 않는다. 이 스펙은 "다이얼로그가 실행
// 대상을 보여주는지"·"버튼이 올바른 결정을 보내는지"만 검증한다 — 승인 후 실제 툴 실행 여부는 실 MCP
// 클라이언트가 필요해 여전히 수동(mcp-approval.test.ts 가 프로토콜 레벨에서 커버).
//
// FIX-mcpshell(S1): session_create 의 argsSummary 에 "실행대상"(로컬 기본 셸 / SSH 프로필)이 추가됐다
// (agent_talk/FIX-mcpshell-done.md). MCP-14 는 그 실제 문자열 형태(JSON.stringify 된 argsForLog)를
// 그대로 흘려 넣어 다이얼로그가 이를 보여주는지 확인한다 — "진짜로 그 필드가 만들어지는지"는
// tests/mcp-server.test.ts 의 동명 회귀 테스트가 프로토콜 레벨에서 확정한다(여기는 UI 렌더링만).
import type { ElectronApplication } from '@playwright/test'
import { test, expect, newLocalShell, dialog, dialogConfirm } from './fixtures'

type ApprovalReq = { requestId: string; sessionId: string; tool: string; argsSummary: string; expiresAt: number }
type ApprovalDecision = { requestId: string; decision: string; minutes?: number }

async function pushApprovalRequest(app: ElectronApplication, r: ApprovalReq): Promise<void> {
  await app.evaluate(({ BrowserWindow }, req) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mcp:approvalRequest', req)
  }, r)
}

// mcp:approvalRespond 핸들러를 스파이로 바꿔치기 — 실 승인 매니저 대신 호출 내용만 기록한다.
async function spyRespond(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('mcp:approvalRespond')
    ;(globalThis as unknown as { __mcpRespondCalls: unknown[] }).__mcpRespondCalls = []
    ipcMain.handle('mcp:approvalRespond', (_e, d) => {
      ;(globalThis as unknown as { __mcpRespondCalls: unknown[] }).__mcpRespondCalls.push(d)
      return { ok: true }
    })
  })
}

async function respondCalls(app: ElectronApplication): Promise<ApprovalDecision[]> {
  return app.evaluate(() => (globalThis as unknown as { __mcpRespondCalls: ApprovalDecision[] }).__mcpRespondCalls ?? [])
}

// MCP-14 승인 요청이 오면 세션·동작·내용(실행대상 포함)이 담긴 다이얼로그가 뜬다
test('MCP-14 승인 요청이 오면 세션·동작·실행대상이 담긴 다이얼로그가 뜬다', async ({ ara }) => {
  const { app, page } = ara
  const id = await newLocalShell(page)
  // 실제 tools.ts 의 session_create 가 만드는 argsSummary 형태 그대로(JSON.stringify(argsForLog)).
  const realArgsSummary = JSON.stringify({ type: 'local', 실행대상: '로컬 기본 셸(플랫폼 자동 선택)' })
  await pushApprovalRequest(app, { requestId: 'req-1', sessionId: id, tool: 'session_create', argsSummary: realArgsSummary, expiresAt: Date.now() + 120_000 })
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toContainText('AI가 실행을 요청합니다')
  const rows = await dialog(page).locator('.dlg-detail .dlg-row').allTextContents()
  expect(rows.some((r) => r.includes('session_create'))).toBe(true)
  expect(rows.some((r) => r.includes('실행대상') && r.includes('로컬 기본 셸'))).toBe(true)
})

// MCP-15 [승인] 클릭 시 approve 결정이 전달되고 다이얼로그가 닫힌다
test('MCP-15 승인 클릭 시 approve 결정이 전달되고 다이얼로그가 닫힌다', async ({ ara }) => {
  const { app, page } = ara
  await spyRespond(app)
  await pushApprovalRequest(app, { requestId: 'req-2', sessionId: 'x', tool: 'session_input', argsSummary: 'ls -la', expiresAt: Date.now() + 120_000 })
  await expect(dialog(page)).toBeVisible()
  await dialogConfirm(page)
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => respondCalls(app)).toEqual([{ requestId: 'req-2', decision: 'approve' }])
})

// MCP-16 [거부] 클릭 시 deny 결정이 전달된다
test('MCP-16 거부 클릭 시 deny 결정이 전달된다', async ({ ara }) => {
  const { app, page } = ara
  await spyRespond(app)
  await pushApprovalRequest(app, { requestId: 'req-3', sessionId: 'x', tool: 'session_input', argsSummary: 'rm -rf /tmp/x', expiresAt: Date.now() + 120_000 })
  await expect(dialog(page)).toBeVisible()
  // 거부는 cancelLabel(.btn.sec) — 자동허용도 같은 클래스라 텍스트로 구분한다.
  await dialog(page).locator('button.btn.sec:text-is("거부")').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => respondCalls(app)).toEqual([{ requestId: 'req-3', decision: 'deny' }])
})

// MCP-17 [이 세션 자동 허용] 클릭 시 autoAllow 결정이 전달된다
test('MCP-17 자동 허용 클릭 시 autoAllow 결정이 전달된다', async ({ ara }) => {
  const { app, page } = ara
  await spyRespond(app)
  await pushApprovalRequest(app, { requestId: 'req-4', sessionId: 'x', tool: 'session_input', argsSummary: 'ls', expiresAt: Date.now() + 120_000 })
  await expect(dialog(page)).toBeVisible()
  await dialog(page).locator('button.btn.sec:text-is("이 세션 자동 허용(10분)")').click()
  await expect(dialog(page)).toHaveCount(0)
  const calls = await respondCalls(app)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ requestId: 'req-4', decision: 'autoAllow' })
  expect(typeof calls[0].minutes).toBe('number')
})

// MCP-20 겹친 승인 요청은 순서대로 하나씩 뜨고 유실되지 않는다
test('MCP-20 겹친 승인 요청이 순서대로 하나씩 뜨고 유실되지 않는다', async ({ ara }) => {
  const { app, page } = ara
  await spyRespond(app)
  await pushApprovalRequest(app, { requestId: 'req-5', sessionId: 'x', tool: 'session_input', argsSummary: 'first-cmd', expiresAt: Date.now() + 120_000 })
  await pushApprovalRequest(app, { requestId: 'req-6', sessionId: 'x', tool: 'session_input', argsSummary: 'second-cmd', expiresAt: Date.now() + 120_000 })
  await expect(dialog(page)).toContainText('first-cmd')
  await dialogConfirm(page)
  await expect(dialog(page)).toContainText('second-cmd')
  await dialogConfirm(page)
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => respondCalls(app)).toEqual([
    { requestId: 'req-5', decision: 'approve' },
    { requestId: 'req-6', decision: 'approve' }
  ])
})
