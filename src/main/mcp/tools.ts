// F23 MCP 툴 화이트리스트 — main 이 이미 갖고 있는 서비스 객체를 직접 호출한다(IPC 왕복을 흉내내지
// 않는다). 각 핸들러는 기존 IPC 핸들러가 부르는 그 함수를 그대로 부르는 세 번째 호출자다(F16 패턴).
//
// 스키마는 zod 객체로 짠다 — z.object() 의 JSON Schema 변환은 기본이 additionalProperties:false 다
// (보안 체크리스트: host/port/username/password 필드 자체가 표현 불가능해야 한다). .passthrough() 를
// 쓰지 않는다 — 그러면 이 불변식이 깨진다.
//
// 명시적으로 뺀 것(설계 §1.3) — 툴 자체를 안 만드는 것으로 표현 불가능하게 한다:
// profile:*(vault 자격증명 CRUD) · ssh:forgetHostKey(TOFU 우회) · ai:*(챗봇 자체 조종) · window:* ·
// fs:*(로컬 파일시스템 전체 브라우징) · 레이아웃/분할(workspace:save 레이스 — 설계 §1.4).
import { randomUUID } from 'node:crypto'
import { aiSessionsOf } from '@shared/aiSession'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { maskSecrets } from '@shared/maskSecrets'
import type { SshConnectResult } from '@shared/ipc'
import { stripAnsi, normalizeCr, newStripState } from '../log/SessionLog'
import { capContext } from '../ai/prompt'
import { invalidName } from '../fs/LocalFs'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { ProfileStore } from '../secrets/ProfileStore'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'
import type { ForwardService } from '../forward/PortForward'
import type { SftpService } from '../sftp/SftpService'
import { connectByProfile } from '../ipc/registerSshIpc'
import { McpApprovalManager, type ToolClass } from './approval'
import type { AskUserManager } from './askUser'

export type ToolCtx = {
  sessions: MainSessionManager
  profiles: ProfileStore
  ws: WorkspaceStore
  forwards: ForwardService
  sftp: SftpService
  approval: McpApprovalManager
  downloadsDir: string // userData/mcp-downloads — AI는 이 밖에 저장할 수 없다(설계 §7 오케 확정 7).
  uploadsDir: string // userData/mcp-uploads — 업로드 소스도 여기 안으로 한정.
  /** AI 가 사람에게 되묻는 길(#125). 헤드리스에는 그 도구가 없어서 우리가 만든다 — askUser.ts 참고. */
  ask: AskUserManager
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] })
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

// 파일명 조각을 고정 디렉토리 안으로 한정(설계 §1.3 sftp_download/upload 행). invalidName 으로
// 경로 구분자·상위 참조를 막고(R7 재사용), SessionLog.ts 의 이중 확인 패턴(resolve 비교)을 더한다.
function confinedPath(dir: string, fileName: string): string | null {
  if (invalidName(fileName)) return null
  const path = join(dir, fileName.trim())
  if (resolve(dirname(path)) !== resolve(dir)) return null
  return path
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function sshFailureText(res: Exclude<SshConnectResult, { ok: true }>): string {
  switch (res.reason) {
    case 'hostKeyNew':
      return `호스트키를 처음 봅니다(${res.algorithm} ${res.fingerprint}). AI는 지문을 대신 확인할 수 없습니다 — 사람이 연결 관리자에서 직접 확인한 뒤 접속해야 합니다.`
    case 'hostKeyMismatch':
      return `호스트키가 이전과 다릅니다(MITM 가능성) — 접속을 차단했습니다. 사람이 직접 확인해야 합니다.`
    case 'orphanSecret':
      return '저장된 비밀을 찾을 수 없습니다. 사람이 프로필을 다시 인증해야 합니다.'
    case 'auth':
      return `인증 실패: ${res.message}`
    case 'network':
      return `연결 실패: ${res.message}`
  }
}

// 단일 진입점(approval.runTool)을 감싸는 얇은 래퍼 — argsSummary 마스킹 + 결과를 ToolResult 로 변환.
async function gated(
  approval: McpApprovalManager,
  sessionId: string | null,
  tool: string,
  cls: ToolClass,
  argsForLog: Record<string, unknown>,
  exec: () => Promise<ToolResult>
): Promise<ToolResult> {
  const argsSummary = maskSecrets(JSON.stringify(argsForLog))
  const r = await approval.runTool(sessionId, tool, cls, argsSummary, exec)
  return r.ok ? r.result : fail(r.message)
}

export function registerMcpTools(server: McpServer, ctx: ToolCtx): void {
  const g = (
    sessionId: string | null,
    tool: string,
    cls: ToolClass,
    args: Record<string, unknown>,
    exec: () => Promise<ToolResult>
  ) => gated(ctx.approval, sessionId, tool, cls, args, exec)

  // ── 사람에게 되묻기 ────────────────────────────────────────────────────────
  // 설명문이 곧 사용 설명서다: 모델은 이 글을 읽고 "언제 이 도구를 쓸지"를 정한다.
  // 그래서 **언제 써야 하는지**를 또박또박 적는다(추측하지 말고 물어라).
  server.registerTool(
    'ask_user',
    {
      description:
        '사람에게 직접 물어봅니다. **추측하면 안 되는 갈림길에서 이 도구를 쓰세요** — 예: 어느 서버/폴더를 쓸지, ' +
        '되돌리기 어려운 일을 진행할지, 여러 방법 중 무엇을 고를지, 계획을 이대로 실행할지. ' +
        'options 를 주면 사람이 그중에서 고르고(화면이 버튼으로 그립니다), 안 주면 자유롭게 씁니다. ' +
        '사람이 답할 때까지 이 호출은 기다리며, 시간이 지나면 답을 못 받았다고 알려 줍니다. ' +
        '이 도구가 없다고 가정해 임의로 결정하지 마세요.',
      inputSchema: {
        question: z.string(),
        options: z.array(z.string()).optional(),
        multi: z.boolean().optional()
      }
    },
    async ({ question, options, multi }) =>
      // readOnly 로 둔다 — 이건 파괴적 조작이 아니라 사람과의 대화다. 승인 다이얼로그를 또 띄우면
      // "물어보려고 물어보는" 두 겹이 된다. 대신 감사 로그에는 활동으로 남는다.
      g(null, 'ask_user', 'readOnly', { question, options, multi }, async () => {
        const answer = await ctx.ask.ask({ question, ...(options ? { options } : {}), ...(multi === undefined ? {} : { multi }) })
        if (answer === null) return fail('사람이 답하지 않았습니다(시간 초과 또는 대기 중인 질문이 너무 많음).')
        return ok(answer)
      })
  )

  /**
   * #134 아라가 작업대를 **지휘한다**.
   *
   * 설계 §11 이 "만들지는 않되 막지도 않는다"로 남겨 둔 자리다. #128~#133 으로 두 전제가
   * 갖춰져서(작업대에 id 가 있고, 명령을 넣는 길이 이미 있다) 이제 도구 둘이면 성립한다:
   *   *"세 세션 다 테스트 돌리고 실패한 것만 알려 줘"*
   *
   * **`aisession_create` 는 안 만든다.** 모델은 `session_create` + `session_input` 로 이미 만들 수
   * 있고, 여기에 또 만들면 실행 줄 조립이 두 벌로 갈린다(렌더러의 runAiCliNow 가 원본이다).
   * 새로 필요한 것은 "무엇이 작업대인가"를 아는 일과 거기에 말을 거는 일뿐이다.
   */
  server.registerTool(
    'aisession_list',
    {
      description:
        '사용자가 만들어 둔 **AI 작업대** 목록입니다(서버·폴더·엔진). 터미널 세션 목록(session_list)과 다릅니다 — ' +
        '이쪽은 "AI CLI 를 띄워 둔 자리"고, 지금 살아 있는 것에는 sessionId 가 붙습니다. ' +
        'sessionId 가 있는 것에만 aisession_send 로 말을 걸 수 있습니다.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      g(null, 'aisession_list', 'readOnly', {}, async () => {
        const live = ctx.sessions.snapshot()
        const rows = aiSessionsOf(ctx.ws.get().aiSessions).map((b) => ({
          id: b.id,
          title: b.title,
          kind: b.kind,
          cwd: b.cwd,
          engine: b.engine,
          ...(b.worktree ? { branch: b.worktree.branch } : {}),
          // 살아 있는 터미널 찾기 — 폴더가 같은 그 서버(또는 로컬) 세션이다.
          sessionId:
            live.find((s) => s.cwd === b.cwd && (b.kind === 'remote' ? s.type === 'ssh' : s.type === 'local'))?.id ?? null
        }))
        return ok(JSON.stringify(rows))
      })
  )

  server.registerTool(
    'aisession_send',
    {
      description:
        '살아 있는 AI 작업대에 지시를 보냅니다(그 터미널에 사람이 타이핑하는 것과 같습니다). ' +
        'aisession_list 가 준 id 를 쓰세요. 줄바꿈은 우리가 붙입니다 — 보낸 즉시 실행됩니다.',
      inputSchema: { id: z.string(), text: z.string() }
    },
    async ({ id, text }) => {
      const bench = aiSessionsOf(ctx.ws.get().aiSessions).find((b) => b.id === id)
      if (!bench) return fail('그런 작업대가 없습니다.')
      const live = ctx.sessions
        .snapshot()
        .find((s) => s.cwd === bench.cwd && (bench.kind === 'remote' ? s.type === 'ssh' : s.type === 'local'))
      if (!live) return fail('그 작업대는 지금 떠 있지 않습니다(사람이 사이드바 [AI] 에서 열어야 합니다).')
      // 승인 게이트는 **그 세션 것**으로 지난다 — 작업대라고 해서 무르게 하지 않는다.
      return g(live.id, 'aisession_send', 'sessionInput', { id, text }, async () => {
        ctx.sessions.write(live.id, `${text}
`)
        return ok('전송함')
      })
    }
  )

  server.registerTool(
    'session_list',
    { description: '열려 있는 터미널 세션 목록(로컬·SSH)을 반환합니다.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      g(null, 'session_list', 'readOnly', {}, async () =>
        ok(JSON.stringify(ctx.sessions.snapshot().map((s) => ({ id: s.id, type: s.type, title: s.title, serverKey: s.serverKey, cwd: s.cwd ?? null }))))
      )
  )

  server.registerTool(
    'session_read',
    {
      description: '세션의 최근 터미널 출력을 읽습니다(사용자가 화면에서 보고 있는 것과 같은 내용).',
      inputSchema: { sessionId: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId }) =>
      g(sessionId, 'session_read', 'readOnly', { sessionId }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const raw = Buffer.from(ctx.sessions.peek(sessionId)).toString('utf8')
        const text = normalizeCr(stripAnsi(raw, newStripState()))
        return ok(capContext(maskSecrets(text))) // D1: 마스킹을 먼저(절단 경계에서 비밀이 새는 것을 막는다)
      })
  )

  server.registerTool(
    'session_create',
    {
      description: '새 터미널 세션을 만듭니다(로컬 셸 또는 등록된 프로필의 SSH). 화면에 새 탭으로 나타납니다.',
      inputSchema: {
        type: z.enum(['local', 'ssh']),
        profileId: z.string().optional(),
        cwd: z.string().optional()
      }
      // S1: shell(자유 문자열)을 여기서 뺐다 — 렌더러 UI 도 이 필드를 절대 채우지 않고(항상 undefined),
      // 검증 없이 그대로 node-pty spawn 인자가 돼 임의 실행파일/인자를 실행할 수 있었다. 로컬 세션은
      // 항상 PtyBackend.resolveShell() 의 플랫폼 기본 셸로만 뜬다 — AI 는 실행파일을 고를 수 없다.
    },
    async (args) => {
      // S1: 승인 다이얼로그가 "무엇을 승인하는지" 보여주도록 실행 대상을 argsSummary 에 명시한다.
      const target = args.type === 'ssh' ? `SSH 프로필: ${args.profileId ?? '(미지정)'}` : '로컬 기본 셸(플랫폼 자동 선택)'
      return g(null, 'session_create', 'writeAlways', { ...args, 실행대상: target }, async () => {
        if (args.type === 'ssh') {
          if (!args.profileId) return fail('SSH 세션은 profileId 가 필요합니다.')
          const res = await connectByProfile(ctx.profiles, ctx.ws, ctx.sessions, args.profileId, false)
          if (!res.ok) return fail(sshFailureText(res))
          return ok(JSON.stringify({ id: res.id, title: res.title }))
        }
        const title = ctx.sessions.nextTitle('셸')
        const id = await ctx.sessions.create({
          type: 'local',
          profileId: null,
          cwd: args.cwd,
          serverKey: 'localhost',
          title,
          manualTitle: false
        })
        return ok(JSON.stringify({ id, title }))
      })
    }
  )

  server.registerTool(
    'session_input',
    {
      description: '터미널에 문자를 입력합니다(사람이 타이핑하는 것과 같은 채널 — 화면에 그대로 나타납니다).',
      inputSchema: { sessionId: z.string(), data: z.string() }
    },
    async ({ sessionId, data }) =>
      g(sessionId, 'session_input', 'sessionInput', { sessionId, data }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        ctx.sessions.write(sessionId, data)
        return ok('전송함')
      })
  )

  server.registerTool(
    'session_destroy',
    { description: '세션을 종료합니다(탭을 닫는 것과 같습니다).', inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) =>
      g(sessionId, 'session_destroy', 'writeAlways', { sessionId }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        ctx.sessions.destroy(sessionId)
        return ok('종료함')
      })
  )

  server.registerTool(
    'ssh_connect',
    {
      description:
        '등록된 프로필로 SSH 접속합니다. 화면에 새 탭으로 나타나고 사용자가 바로 쓸 수 있습니다. ' +
        'profileId 로만 지정합니다 — 호스트·자격증명은 이 툴로 전달할 수 없습니다.',
      inputSchema: { profileId: z.string() }
    },
    async ({ profileId }) =>
      g(null, 'ssh_connect', 'writeAlways', { profileId }, async () => {
        const res = await connectByProfile(ctx.profiles, ctx.ws, ctx.sessions, profileId, false)
        if (!res.ok) return fail(sshFailureText(res))
        return ok(JSON.stringify({ id: res.id, title: res.title }))
      })
  )

  server.registerTool(
    'sftp_list',
    {
      description: '활성 SSH 세션의 원격 디렉토리를 나열합니다.',
      inputSchema: { sessionId: z.string(), path: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId, path }) =>
      g(sessionId, 'sftp_list', 'readOnly', { sessionId, path }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.list(sessionId, path)
        return res.ok ? ok(JSON.stringify(res)) : fail(res.message)
      })
  )

  server.registerTool(
    'sftp_download',
    {
      description: '원격 파일을 내려받습니다. 저장 위치는 고정 폴더(mcp-downloads) 안으로 한정되고, fileName 에는 경로 구분자를 쓸 수 없습니다.',
      inputSchema: { sessionId: z.string(), remotePath: z.string(), fileName: z.string() }
    },
    async ({ sessionId, remotePath, fileName }) =>
      g(sessionId, 'sftp_download', 'writeAlways', { sessionId, remotePath, fileName }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const localPath = confinedPath(ctx.downloadsDir, fileName)
        if (!localPath) return fail('파일 이름이 올바르지 않습니다(경로 구분자·상위 참조 금지).')
        ensureDir(ctx.downloadsDir)
        const res = await ctx.sftp.download(sessionId, randomUUID(), remotePath, localPath, 0)
        return res.ok ? ok(`다운로드 완료: mcp-downloads/${fileName}`) : fail(res.message)
      })
  )

  server.registerTool(
    'sftp_upload',
    {
      description: '고정 폴더(mcp-uploads) 안의 파일을 원격으로 올립니다. 임의 로컬 경로는 지정할 수 없습니다.',
      inputSchema: { sessionId: z.string(), localFileName: z.string(), remoteDir: z.string() }
    },
    async ({ sessionId, localFileName, remoteDir }) =>
      g(sessionId, 'sftp_upload', 'writeAlways', { sessionId, localFileName, remoteDir }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const localPath = confinedPath(ctx.uploadsDir, localFileName)
        if (!localPath) return fail('파일 이름이 올바르지 않습니다(경로 구분자·상위 참조 금지).')
        if (!existsSync(localPath)) return fail(`업로드할 파일이 없습니다: mcp-uploads/${localFileName}`)
        const res = await ctx.sftp.upload(sessionId, randomUUID(), localPath, remoteDir)
        return res.ok ? ok('업로드 완료') : fail(res.message)
      })
  )

  server.registerTool(
    'sftp_mkdir',
    { description: '원격에 폴더를 만듭니다.', inputSchema: { sessionId: z.string(), dir: z.string(), name: z.string() } },
    async ({ sessionId, dir, name }) =>
      g(sessionId, 'sftp_mkdir', 'writeAlways', { sessionId, dir, name }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.mkdir(sessionId, dir, name)
        return res.ok ? ok('생성함') : fail(res.message)
      })
  )

  server.registerTool(
    'sftp_rename',
    { description: '원격 파일·폴더 이름을 바꿉니다.', inputSchema: { sessionId: z.string(), path: z.string(), name: z.string() } },
    async ({ sessionId, path, name }) =>
      g(sessionId, 'sftp_rename', 'writeAlways', { sessionId, path, name }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.rename(sessionId, path, name)
        return res.ok ? ok('변경함') : fail(res.message)
      })
  )

  server.registerTool(
    'sftp_remove',
    { description: '원격 파일·폴더를 삭제합니다(폴더는 재귀 삭제).', inputSchema: { sessionId: z.string(), paths: z.array(z.string()) } },
    async ({ sessionId, paths }) =>
      g(sessionId, 'sftp_remove', 'writeAlways', { sessionId, paths }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.remove(sessionId, randomUUID(), paths)
        return res.ok ? ok('삭제함') : fail(res.message)
      })
  )

  server.registerTool(
    'forward_list',
    { description: '활성 포트 포워딩 목록을 반환합니다.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => g(null, 'forward_list', 'readOnly', {}, async () => ok(JSON.stringify(ctx.forwards.list())))
  )

  server.registerTool(
    'forward_create',
    {
      description: '원격 127.0.0.1:remotePort 를 내 PC 로 연결합니다(로컬 바인드·원격 목적지 모두 127.0.0.1 고정).',
      inputSchema: { sessionId: z.string(), remotePort: z.number() }
    },
    async ({ sessionId, remotePort }) =>
      g(sessionId, 'forward_create', 'writeAlways', { sessionId, remotePort }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.forwards.create(sessionId, remotePort)
        return res.ok ? ok(JSON.stringify(res.forward)) : fail(res.message)
      })
  )

  server.registerTool(
    'forward_stop',
    { description: '포트 포워딩을 중지합니다.', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) =>
      g(null, 'forward_stop', 'readOnly', { id }, async () => {
        ctx.forwards.stop(id)
        return ok('중지함')
      })
  )
}
