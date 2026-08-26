// F23 MCP 서버 — 실제 MCP 프로토콜 왕복(가짜 클라이언트 하네스, SDK Client/StreamableHTTPClientTransport).
// 실제 외부 AI 클라이언트(Claude Code 등) 연결은 하지 않는다 — 루프백 한정 자체 하네스로만 검증한다.
// 설계 §8 체크리스트 중 "인증·트랜스포트"·"툴 화이트리스트 경계"·"계약·불변식" 항의 어서션 증거.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir, networkInterfaces } from 'node:os'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { request as httpRequest } from 'node:http'
import { createMcpServer, hashToken, MCP_TOKEN_VAULT_KEY, BIND_HOST, MCP_MAX_BODY_BYTES, type TokenVault, type McpServerHandle } from '../src/main/mcp/McpServer'
import { McpApprovalManager, type ApprovalEmit } from '../src/main/mcp/approval'
import { createAuditLog } from '../src/main/mcp/auditLog'
import { createAskUser } from '../src/main/mcp/askUser'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import { ProfileStore } from '../src/main/secrets/ProfileStore'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { SftpService } from '../src/main/sftp/SftpService'
import { createForwardService } from '../src/main/forward/PortForward'
import { connectSsh } from '../src/main/sessions/ssh/SshBackend'
import type { SessionSpec } from '../src/main/sessions/ISessionManager'
import type { ToolCtx } from '../src/main/mcp/tools'
import type { SecretStore } from '../src/main/secrets/SecretStore'
import { MCP_DEFAULT_PORT } from '../src/shared/types'
import type { SshProfile, McpApprovalRequest, Session } from '../src/shared/types'
import { startPasswordServer, type Harness } from './ssh-harness'

const isWin = process.platform === 'win32'

function memSecretStore(): SecretStore {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), has: (k) => m.has(k) }
}
function memTokenVault(): TokenVault {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), has: (k) => m.has(k) }
}

type Rig = {
  dir: string
  sessions: MainSessionManager
  profiles: ProfileStore
  ws: WorkspaceStore
  server: McpServerHandle
  port: number
  token: string
  approval: McpApprovalManager
  // S1(FIX-mcpshell) 회귀 가드용 — 승인 요청 원문(argsSummary 포함)을 순서대로 기록한다.
  approvalRequests: McpApprovalRequest[]
  // 화면으로 나간 "세션이 생겼다" 알림. 이게 비면 사용자에게 탭이 안 보인다(2026-08-26 제보).
  opened: Session[]
  browserUrls: string[]
  cleanup: () => Promise<void>
}

// 승인 요청이 오면 즉시 [승인]한다(자동 승인 하네스) — 이 파일은 프로토콜·화이트리스트·경로 확인을
// 검증하는 것이 목적이고, 승인 상태 머신 자체는 mcp-approval.test.ts 가 이미 단위로 검증했다.
//
// bindPort=0(OS 가 빈 포트를 고른다) — 테스트마다 고정 포트(MCP_DEFAULT_PORT)를 빠르게 재사용하면
// OS 의 TIME_WAIT 타이밍과 경쟁해 산발적으로 실패한다(프로덕션은 앱 생명주기 동안 한 번만 바인드하므로
// 겪지 않는 문제). 고정 포트 자체의 재사용성은 별도의 전용 테스트 하나가 명시적으로 검증한다.
async function makeRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'ev-mcp-http-'))
  const opened: Session[] = []
  // 아라 브라우저에 띄운 주소. 비면 사용자 화면에 아무것도 안 뜬 것이다(2026-08-26 제보).
  const browserUrls: string[] = []
  const sessions = new MainSessionManager({
    data() {},
    exit() {},
    cwd() {},
    opened: (m) => opened.push(m)
  })
  const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
  const profiles = new ProfileStore(ws, memSecretStore())
  const forwards = createForwardService((id) => sessions.sshClient(id))
  const sftp = new SftpService((id) => sessions.sshClient(id), () => {})
  const audit = createAuditLog(join(dir, 'logs'))
  let approvalRef: McpApprovalManager
  const approvalRequests: McpApprovalRequest[] = []
  const emit: ApprovalEmit = {
    approvalRequest: (r) => {
      approvalRequests.push(r)
      approvalRef.respond({ requestId: r.requestId, decision: 'approve' })
    },
    activity: () => {},
    stateChanged: () => {}
  }
  const approval = new McpApprovalManager(emit, audit)
  approvalRef = approval
  const ctx: ToolCtx = {
    sessions,
    profiles,
    ws,
    forwards,
    sftp,
    browser: { open: (u: string) => { browserUrls.push(u); return u.startsWith('http') }, current: () => null, close: () => {} },
    ask: createAskUser({ ask: () => {}, askDone: () => {} }),
    approval,
    downloadsDir: join(dir, 'mcp-downloads'),
    uploadsDir: join(dir, 'mcp-uploads')
  }
  const vault = memTokenVault()
  const server = createMcpServer(ctx, vault, 0)
  const token = 'test-token-' + Math.random().toString(36).slice(2)
  vault.set(MCP_TOKEN_VAULT_KEY, hashToken(token))
  const listened = await server.setEnabled(true)
  expect(listened.ok).toBe(true)

  return {
    dir,
    sessions,
    profiles,
    ws,
    server,
    port: listened.port!,
    token,
    approval,
    approvalRequests,
    opened,
    browserUrls,
    cleanup: async () => {
      await server.stop()
      sessions.destroyAll()
      forwards.stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function makeClient(port: number, bearer?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}
  })
  const client = new Client({ name: 'ev-test-harness', version: '1.0.0' })
  return { client, transport }
}

const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup()
})

describe('인증·트랜스포트(설계 §8 체크리스트 1)', () => {
  it('토큰 없이 접속하면 initialize 핸드셰이크조차 진행되지 않는다(401)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port) // Authorization 헤더 없음
    await expect(client.connect(transport)).rejects.toThrow()
  })

  it('틀린 토큰으로 접속하면 401 로 거부된다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, 'wrong-token-xyz')
    await expect(client.connect(transport)).rejects.toThrow()
  })

  it('올바른 토큰이면 접속되고 툴 목록을 받을 수 있다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    await client.close()
  })

  it('리스너가 127.0.0.1 에만 바인드된다(소스 상수 + 사내망 IP 로는 닿지 않음)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    expect(BIND_HOST).toBe('127.0.0.1')
    const src = readFileSync(new URL('../src/main/mcp/McpServer.ts', import.meta.url), 'utf8')
    for (const call of src.match(/\.listen\([^)]*\)/g) ?? []) expect(call).toContain('BIND_HOST')
    // 사내망(비-loopback) 인터페이스가 있으면 그 주소로는 접속되지 않는지 실측한다.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((ni) => ni && ni.family === 'IPv4' && !ni.internal)?.address
    if (!lan) return // 격리 CI 등 사내망 인터페이스가 없으면 이 실측은 건너뛴다.
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: lan, port: rig.port })
      socket.setTimeout(800, () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    expect(reachable).toBe(false)
  })

  it('두 번째 클라이언트의 새 연결 시도는 거부된다(v1 단일 연결, 설계 §1.6)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const a = makeClient(rig.port, rig.token)
    await a.client.connect(a.transport)

    const b = makeClient(rig.port, rig.token)
    await expect(b.client.connect(b.transport)).rejects.toThrow()

    await a.client.close()
  })

  it('연결이 끊기면 그 자리가 나서 새 클라이언트가 접속할 수 있다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const a = makeClient(rig.port, rig.token)
    await a.client.connect(a.transport)
    // client.close() 는 로컬 정리만 하고 서버에 알리지 않는다 — 명시적 세션 종료(DELETE, MCP 스펙)를
    // 보내야 서버 쪽 슬롯이 실제로 빈다(설정 [MCP]의 "연결 끊기"가 하는 일과 같다).
    await a.transport.terminateSession()
    await a.client.close()

    const b = makeClient(rig.port, rig.token)
    await b.client.connect(b.transport)
    const { tools } = await b.client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    await b.client.close()
  })

  it('stop() 후 프로덕션 고정 포트가 즉시 재사용 가능하다(좀비 리스너 없음, before-quit 회귀 방지)', async () => {
    // 이 테스트만 실제 고정 포트(MCP_DEFAULT_PORT)를 쓴다 — 다른 테스트는 전부 0(임의 포트)이라
    // 이 슬롯을 두고 경쟁할 다른 테스트가 없다(makeRig 주석 참조).
    const dir = mkdtempSync(join(tmpdir(), 'ev-mcp-fixedport-'))
    const sessions = new MainSessionManager({ data() {}, exit() {}, cwd() {} })
    const ws = new WorkspaceStore(join(dir, 'workspace.json'), '0.1.0')
    const ctx: ToolCtx = {
      sessions,
      profiles: new ProfileStore(ws, memSecretStore()),
      ws,
      forwards: createForwardService(() => null),
      ask: createAskUser({ ask: () => {}, askDone: () => {} }),
      browser: { open: () => true, current: () => null, close: () => {} },
      sftp: new SftpService(() => null, () => {}),
      approval: new McpApprovalManager({ approvalRequest() {}, activity() {}, stateChanged() {} }, createAuditLog(join(dir, 'logs'))),
      downloadsDir: join(dir, 'mcp-downloads'),
      uploadsDir: join(dir, 'mcp-uploads')
    }
    const server = createMcpServer(ctx, memTokenVault(), MCP_DEFAULT_PORT)
    try {
      const first = await server.setEnabled(true)
      expect(first).toEqual({ ok: true, port: MCP_DEFAULT_PORT })
      await server.stop()
      const reopened = await server.setEnabled(true)
      expect(reopened).toEqual({ ok: true, port: MCP_DEFAULT_PORT })
    } finally {
      await server.stop()
      sessions.destroyAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // S2(GAP I1): readBody()가 Buffer.concat(chunks)로 상한 없이 버퍼링했다(재현: 수정 전 코드는
  // MCP_MAX_BODY_BYTES 상수·크기 검사 자체가 없었다 — Buffer.concat(chunks)만 있고 total 추적이
  // 없어 body 가 얼마나 크든 그대로 다 받아 JSON.parse 를 시도했다, agent_talk/FIX-mcpshell-done.md
  // 참조). SessionLog.MAX_LINE 과 같은 크기(1MB)로 클램프하고 초과 시 413 으로 즉시 끊는다.
  it('MCP HTTP 요청 본문이 상한(1MB)을 넘으면 413 으로 거부되고, 상한 이내면 정상 처리된다', async () => {
    const rig = await makeRig()
    rigs.push(rig)

    const post = (body: Buffer): Promise<number> =>
      new Promise((resolvePromise, reject) => {
        const req = httpRequest(
          { host: BIND_HOST, port: rig.port, method: 'POST', headers: { Authorization: `Bearer ${rig.token}`, 'content-type': 'application/json' } },
          (res) => {
            res.resume() // 본문은 안 읽어도 되지만 스트림은 흘려보내야 'end' 가 온다.
            res.on('end', () => resolvePromise(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end(body)
      })

    // 상한을 넘는 JSON — 문자열 필드로 부풀린다(진짜 initialize 형태가 아니어도 크기 검사는
    // 바디를 다 받기 전(스트리밍 중)에 걸리므로 JSON 내용은 무관하다).
    const oversized = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { pad: 'a'.repeat(MCP_MAX_BODY_BYTES + 1024) }, id: 1 }))
    expect(oversized.length).toBeGreaterThan(MCP_MAX_BODY_BYTES)
    await expect(post(oversized)).resolves.toBe(413)

    // 상한 이내의(그리고 유효한 initialize 가 아닌) 요청은 정상적으로 애플리케이션 레벨 처리로
    // 넘어간다(400 — "세션이 없습니다" 계열, 즉 크기 때문에 끊긴 게 아니라는 대조).
    const withinLimit = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: {}, id: 1 }))
    expect(withinLimit.length).toBeLessThan(MCP_MAX_BODY_BYTES)
    await expect(post(withinLimit)).resolves.toBe(400)
  })
})

describe('툴 화이트리스트 경계(설계 §8 체크리스트 2)', () => {
  it('노출된 툴 이름이 화이트리스트와 정확히 일치한다(fs:*/profile:*/ai:*/window:*/분할 없음)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        // 2026-08-24 추가(#125): AI 가 **사람에게 되묻는** 도구. 파괴적 조작이 아니고 인자는
        // 질문·선택지 문자열뿐이다. 헤드리스 Claude Code 에는 되묻는 도구가 없어서(실측) 이 자리를
        // 우리가 만든다 — 이게 없으면 AI 가 갈림길에서 **혼자 결정한다.**
        // 2026-08-25 추가(#134): 아라가 **작업대를 지휘한다**. list 는 읽기, send 는 그 세션의
        // 승인 게이트를 그대로 지난다(작업대라고 무르게 하지 않는다). create 는 일부러 없다 —
        // session_create + session_input 으로 이미 되고, 또 만들면 실행 줄 조립이 두 벌로 갈린다.
        // 2026-08-26 추가: **아라 안의 브라우저.** 이게 없어서 아라가 PowerShell 로 엣지를 띄우고
        // 다른 MCP 플러그인(playwright)까지 끌어다 썼다(준영님 제보). 우리 창 안에 웹을 보여 주는
        // 길은 이 도구뿐이고, 스킴은 http/https 로 잠겨 있다.
        'aisession_list',
        'aisession_send',
        'ask_user',
        'browser_open',
        'forward_create',
        'forward_list',
        'forward_stop',
        'session_create',
        'session_destroy',
        'session_input',
        'session_list',
        'session_read',
        'sftp_download',
        'sftp_list',
        'sftp_mkdir',
        'sftp_remove',
        'sftp_rename',
        'sftp_upload',
        'ssh_connect'
      ].sort()
    )
    for (const forbidden of ['profile', 'forgetHostKey', 'fs_list', 'fs_rename', 'window_', 'ai_send', 'split', 'layout'])
      expect(names.join(',')).not.toContain(forbidden)
    await client.close()
  })

  it('session_create/ssh_connect 스키마에 host·port·username·password 필드 자체가 없다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const { tools } = await client.listTools()
    for (const name of ['session_create', 'ssh_connect']) {
      const tool = tools.find((t) => t.name === name)!
      const schema = tool.inputSchema as { properties?: Record<string, unknown> }
      const keys = Object.keys(schema.properties ?? {})
      // S1(FIX-mcpshell): shell 도 host/port/username/password 와 같은 급의 금지 필드다 — 자유 문자열이
      // 검증 없이 node-pty spawn 인자가 됐다(임의 실행파일/인자 실행). 렌더러 UI 도 이 필드를 쓰지 않는다.
      for (const forbidden of ['host', 'port', 'username', 'password', 'shell'])
        expect(keys).not.toContain(forbidden)
    }
    // 참고(보안 리뷰어 확인용): MCP SDK 는 tools/list 응답의 JSON Schema 를 draft-7 로 내리는데,
    // zod v4-mini 의 draft-7 변환기가 additionalProperties:false 를 내려보내지 않는다(SDK 자체의
    // 알려진 특성 — 우리 zod 스키마 정의와 무관, 위에서 실측 확인함). 실제 방어선은 이 파일 밖:
    // zod 의 object().parse() 가 미정의 필드를 조용히 제거하므로(strip, 기본 동작) 핸들러는 스키마에
    // 없는 값을 볼 수 없다 — 바로 아래 테스트가 그 결과를 실증한다.
    await client.close()
  })

  it('스키마 밖 필드(host 등)를 얹어 보내도 핸들러에 전달되지 않는다(zod 파싱이 조용히 제거)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    // profileId 를 안 주고 host 로 대신 채우려는 시도 — profileId 가 없으면 ssh 분기가 성공할 수 없으므로
    // "host 필드가 실제로 반영됐다면 성공했을 것"이라는 대조가 성립한다.
    const res = await client.callTool({
      name: 'session_create',
      // 적대적 입력 — 스키마에 없는 필드를 억지로 얹는다.
      arguments: { type: 'ssh', host: '10.0.0.1', username: 'root', password: 'x' }
    })
    expect(res.isError).toBe(true) // host 가 handler 에 닿았다면 profileId 없이도 뭔가 시도했을 텐데, 그냥 실패한다
    const list = await client.callTool({ name: 'session_list', arguments: {} })
    expect((list.content as { type: string; text: string }[])[0].text).toBe('[]') // 세션이 생기지 않았다
    await client.close()
  })

  /**
   * ★ 2026-08-26 준영님 제보 회귀 — *"KVT 접속했습니다, 터미널 열렸으니 바로 쓰시면 됩니다라고 뜨고
   * 화면에 세션창이 안떠"*.
   *
   * 세션은 진짜로 만들어졌다(session_list 에 나온다). 빠진 것은 **화면에 알리는 한 줄**이었고,
   * 그래서 사람이 볼 수도 닫을 수도 없는 연결이 남았다. AI 가 거짓말을 한 게 아니라 도구 설명문에
   * "화면에 새 탭으로 나타납니다"라고 적혀 있었고 그게 사실이 아니었다.
   *
   * 목록에 있는 것만으로는 부족하다 — **알림이 나갔는가**를 본다.
   */
  it('★ MCP 로 만든 세션은 화면에 알림이 나간다(목록에만 있고 탭이 없으면 유령이다)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    const res = await client.callTool({ name: 'session_create', arguments: { type: 'local' } })
    expect(res.isError).toBeFalsy()
    const { id } = JSON.parse((res.content as { type: string; text: string }[])[0].text) as { id: string }

    expect(rig.opened.map((m) => m.id)).toContain(id)
    // 탭을 그리려면 이름·서버 묶음이 함께 와야 한다(id 만 오면 화면이 무엇을 그릴지 모른다).
    const meta = rig.opened.find((m) => m.id === id)!
    expect(meta.title).toBeTruthy()
    expect(meta.serverKey).toBe('localhost')
    // 소유 창이 없다 = 본창. AI 가 만든 세션은 늘 사람이 보고 있는 창으로 간다.
    expect(meta.winId).toBeUndefined()
    await client.close()
  })

  /**
   * ★ 2026-08-26 준영님 제보 3 — *"8000 포트 브라우저로 띄워줘"* 에 아라가 `forward_create` 까지는
   * 맞게 하고 그다음 **PowerShell `Start-Process`** 로 엣지를 열었다. 다시 시키니 이번엔 다른 MCP
   * 플러그인(playwright)을 찾아 썼다. 우리 창 안에 브라우저가 있는데 **거기 닿는 도구가 없었다.**
   *
   * 도구가 없으면 모델은 밖에서 찾는다 — 세션 알림(#1)·서버 목록(#2)과 같은 뿌리다.
   */
  it('★ browser_open 이 아라 브라우저에 띄운다(로컬 브라우저로 나가지 않는다)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    const res = await client.callTool({ name: 'browser_open', arguments: { url: 'http://localhost:8000' } })
    expect(res.isError).toBeFalsy()
    expect(rig.browserUrls).toEqual(['http://localhost:8000'])

    // http/https 밖은 열지 않는다 — 파일·앱 스킴으로 우리 창을 끌고 갈 수 없다.
    const bad = await client.callTool({ name: 'browser_open', arguments: { url: 'file:///C:/Windows/win.ini' } })
    expect(bad.isError).toBe(true)
    await client.close()
  })

  /**
   * ★ 2026-08-26 — 없는 프로필로 붙으려 하면 **등록된 목록을 함께 돌려준다.**
   *
   * 그전에는 "연결 실패: 프로필을 찾을 수 없습니다"로 끝났고, 아라는 그 다음 수를 찾으려고
   * 우리 workspace.json 을 뒤졌다(준영님 실측). 실패가 길을 알려 주지 않으면 모델은 파일을 연다.
   */
  it('★ 없는 프로필로 ssh_connect 하면 등록된 서버 목록이 실패 메시지에 실려 온다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    rig.profiles.save({
      type: 'ssh', name: 'KVT', host: '10.0.0.9', port: 22,
      username: 'svc', authType: 'password', secret: 'x'
    } as never)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    // 이름을 id 자리에 넣은 그 호출 그대로.
    const res = await client.callTool({ name: 'ssh_connect', arguments: { profileId: 'kvt' } })
    expect(res.isError).toBe(true)
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).toContain('KVT')
    expect(text).toContain(rig.profiles.list()[0].id)
    // 목록은 이름과 id 뿐이다 — 비밀도 호스트도 이 길로 나가지 않는다.
    expect(text).not.toContain('10.0.0.9')
    await client.close()
  })

  // S1(FIX-mcpshell) 회귀 — 재현: session_create 에 shell: 'cmd.exe /c ver' 를 실제로 보내면(수정 전)
  // MCP 승인→PtyBackend 왕복을 그대로 통과해 "ver" 명령이 실행되고 세션 출력에 윈도우 버전 배너가
  // 찍혔다(실측 확인, agent_talk/FIX-mcpshell-done.md 참조). 수정 후 shell 은 zod 파싱 단계에서
  // 조용히 제거되어(위 스키마 부재 테스트) handler 에 닿지 않는다 — 아래는 그 소멸을 여러 형태의
  // 적대적 값(절대경로·상대경로·인자 삽입·유니코드 우회)으로 재확인한다.
  it('session_create 의 shell 에 임의 실행파일·상대경로·인자삽입·유니코드를 넣어도 세션은 항상 기본 셸로만 생성된다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    const evilShells = [
      'cmd.exe /c calc', // 인자 삽입
      '../../evil.exe', // 상대경로 탈출
      isWin ? 'C:\\Windows\\System32\\calc.exe' : '/usr/bin/xcalc', // 임의 절대경로
      'c\u0430lc.exe' // 유니코드 동형(cyrillic а) 우회 시도
    ]
    for (const shell of evilShells) {
      const res = await client.callTool({ name: 'session_create', arguments: { type: 'local', shell } })
      expect(res.isError).toBeFalsy() // 거부가 아니라 "무시" — 기본 셸로 정상 생성된다(값만 안 반영)
      const { id } = JSON.parse((res.content as { type: string; text: string }[])[0].text) as { id: string }
      // meta.shell 이 그대로 undefined 라는 것이 "적대적 값이 spec.shell 에 닿지 않았다"의 직접 증거
      // (MainSessionManager.create() 가 spec.shell 을 그대로 meta.shell 에 싣는다, :63).
      expect(rig.sessions.snapshot().find((s) => s.id === id)?.shell).toBeUndefined()
      rig.sessions.destroy(id)
    }

    if (isWin) {
      // 실측 소멸 확인: 진짜로 "ver" 가 실행되면 뜨는 윈도우 버전 배너가 이제는 나타나지 않는다
      // (재현 당시엔 3초 안에 나타났다 — agent_talk/FIX-mcpshell-done.md 재현 로그 참조).
      const res = await client.callTool({ name: 'session_create', arguments: { type: 'local', shell: 'cmd.exe /c ver' } })
      const { id } = JSON.parse((res.content as { type: string; text: string }[])[0].text) as { id: string }
      await new Promise((r) => setTimeout(r, 1500))
      const text = Buffer.from(rig.sessions.peek(id)).toString('utf8').toLowerCase()
      expect(text).not.toContain('microsoft windows')
      rig.sessions.destroy(id)
    }

    // 정상 경로(렌더러가 실제로 쓰는 값 = shell 필드 자체를 안 보냄)는 계속 동작한다.
    const normal = await client.callTool({ name: 'session_create', arguments: { type: 'local' } })
    expect(normal.isError).toBeFalsy()
    const { id: normalId } = JSON.parse((normal.content as { type: string; text: string }[])[0].text) as { id: string }
    expect(rig.sessions.snapshot().find((s) => s.id === normalId)).toBeTruthy()
    rig.sessions.destroy(normalId)

    await client.close()
  })

  // S1(FIX-mcpshell) — 승인 다이얼로그가 "무엇을 승인하는지" 보여주도록 session_create 의 argsSummary 에
  // 실행대상을 얹었다(agent_talk/FIX-mcpshell-done.md). 실제로 그 필드가 승인 요청에 실리는지 확인한다
  // (Playwright tests/e2e/mcp-approval.spec.ts 의 MCP-14 는 UI 렌더링만 보므로, "진짜 콘텐츠가 그 모양으로
  // 만들어지는지"는 여기서 확정한다).
  it('session_create 의 승인 요청에 실행대상(로컬/SSH)이 노출된다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    await client.callTool({ name: 'session_create', arguments: { type: 'local' } })
    const local = rig.approvalRequests.find((r) => r.tool === 'session_create')
    expect(local?.argsSummary).toContain('실행대상')
    expect(local?.argsSummary).toContain('로컬 기본 셸(플랫폼 자동 선택)')

    await client.callTool({ name: 'session_create', arguments: { type: 'ssh', profileId: 'no-such-profile' } })
    const ssh = rig.approvalRequests.filter((r) => r.tool === 'session_create')[1]
    expect(ssh?.argsSummary).toContain('실행대상')
    expect(ssh?.argsSummary).toContain('SSH 프로필: no-such-profile')

    await client.close()
  })

  it('사람이 화면에서 보고 있지 않은 로컬 파일시스템 브라우징 툴이 없다(fs:* 부재 재확인)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const { tools } = await client.listTools()
    const res = await client.callTool({ name: 'fs_list', arguments: { path: 'C:/' } })
    expect(res.isError).toBe(true) // 존재하지 않는 툴 — 화이트리스트 밖은 등록조차 되지 않았다
    expect(tools.some((t) => t.name.startsWith('fs'))).toBe(false)
    await client.close()
  })
})

describe('session_read — 마스킹(설계 §1.5)', () => {
  // 상한(AI_CONTEXT_LINES) 절단 로직 자체는 capContext() 단위 테스트(tests/ai.test.ts)가 이미 촘촘히
  // 증명했다 — 여기서는 session_read 가 실제 PTY 출력 경로에서 stripAnsi→normalizeCr→capContext→
  // maskSecrets 순서를 실제로 거치는지, 특히 **마스킹이 실제로 걸리는지**만 왕복으로 증명한다
  // (수백 줄 echo 로 절단까지 재현하면 셸 타이밍에 좌우돼 느리고 불안정해진다 — 중복 증명이기도 하다).
  it('비밀 패턴이 실제 PTY 출력에서도 마스킹된다', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const spec: SessionSpec = {
      type: 'local',
      serverKey: 'localhost',
      title: 'mcp-test',
      profileId: null,
      cwd: undefined,
      shell: isWin ? 'cmd.exe' : '/bin/sh'
    }
    const id = await rig.sessions.create(spec)
    rig.sessions.attach(id)
    rig.sessions.write(id, isWin ? 'echo TOKEN=supersecret123\r' : 'echo TOKEN=supersecret123\n')
    const waitFor = async (pred: () => boolean, ms = 6000) => {
      const start = Date.now()
      while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 50))
    }
    await waitFor(() => Buffer.from(rig.sessions.peek(id)).toString('utf8').includes('supersecret123'))

    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const res = await client.callTool({ name: 'session_read', arguments: { sessionId: id } })
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).not.toContain('supersecret123')
    expect(text).toContain('****')
    await client.close()
  })

  it('존재하지 않는 세션은 오류로 거부된다(신뢰 경계 밖 인자 재확인, 설계 §5 M1)', async () => {
    const rig = await makeRig()
    rigs.push(rig)
    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const res = await client.callTool({ name: 'session_read', arguments: { sessionId: 'no-such-session' } })
    expect(res.isError).toBe(true)
    await client.close()
  })
})

describe('SSH 경계 — TOFU·경로 탈출(설계 §8 체크리스트 2)', () => {
  let harness: Harness | null = null
  afterEach(async () => {
    if (harness) await harness.close()
    harness = null
  })

  function pwProfile(id: string, port: number): SshProfile {
    return {
      id,
      type: 'ssh',
      name: 'mcp-harness',
      host: '127.0.0.1',
      port,
      username: 'tester',
      auth: { type: 'password', secretRef: { store: 'vault', key: id } }
    }
  }

  it('ssh_connect 는 미지 호스트키를 자동 수락하지 않는다(TOFU 그대로, hostKeyNew 반환)', async () => {
    harness = await startPasswordServer()
    const rig = await makeRig()
    rigs.push(rig)
    const profile = pwProfile('p1', harness.port)
    rig.profiles.save({
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authType: 'password',
      secret: harness.password
    })

    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)
    const res = await client.callTool({ name: 'ssh_connect', arguments: { profileId: 'p1' } })
    expect(res.isError).toBe(true)
    const text = (res.content as { type: string; text: string }[])[0].text
    expect(text).toContain('호스트키')
    // 차단되었으므로 세션이 생기지 않았다.
    const list = await client.callTool({ name: 'session_list', arguments: {} })
    expect((list.content as { type: string; text: string }[])[0].text).toBe('[]')
    await client.close()
  })

  it('sftp_download 는 mcp-downloads 밖 경로를 거부한다(경로 탈출 다종)', async () => {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'ev-mcp-remote-'))
    writeFileSync(join(remoteRoot, 'secret.txt'), '원격 파일')
    harness = await startPasswordServer({ sftpRoot: remoteRoot })
    const rig = await makeRig()
    rigs.push(rig)

    const connectRes = await connectSsh(pwProfile('p1', harness.port), {
      knownHosts: {},
      secret: harness.password,
      acceptHostKey: true,
      onHostKeyAccepted: () => {}
    })
    if (!connectRes.ok) throw new Error('하네스 접속 실패: ' + connectRes.reason)
    const sessionId = rig.sessions.adopt(connectRes.backend, {
      type: 'ssh',
      profileId: 'p1',
      title: 'harness',
      serverKey: 'mcp-harness',
      cwd: undefined,
      shell: undefined
    })

    const { client, transport } = makeClient(rig.port, rig.token)
    await client.connect(transport)

    const evil = ['../escape.txt', '..\\escape.txt', '/etc/passwd', 'C:\\Windows\\evil.txt', 'a/../../b.txt', './/..//x']
    for (const fileName of evil) {
      const res = await client.callTool({ name: 'sftp_download', arguments: { sessionId, remotePath: 'secret.txt', fileName } })
      expect(res.isError).toBe(true)
    }
    expect(existsSync(join(rig.dir, 'mcp-downloads'))).toBe(false) // 탈출 시도가 디렉토리조차 만들지 않았다

    // 정상 파일명은 통과해서 고정 폴더 안에 저장된다.
    const ok = await client.callTool({ name: 'sftp_download', arguments: { sessionId, remotePath: 'secret.txt', fileName: 'saved.txt' } })
    expect(ok.isError).toBeFalsy()
    expect(existsSync(join(rig.dir, 'mcp-downloads', 'saved.txt'))).toBe(true)

    await client.close()
    connectRes.backend.kill()
  })
})
