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
import type { BrowserService } from '../browser/BrowserTabs'
import type { RemoteConsoleService } from '../remote/RemoteConsoleService'
import type { SessionLogService } from '../log/SessionLog'
import type { HistoryStore } from '../history/HistoryStore'
import { COMMANDS, type CmdId } from '@shared/remoteCatalog'
import { GROUPS as G, groupLines, type ToolGroup as TG } from '@shared/araTools'
import { readFileWindow } from '../log/readSessionLog'
import { fetchTmuxSessions } from '../telemetry/TmuxSessions'
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
  /**
   * 내장 브라우저(2026-08-26). **없어서 아라가 로컬 브라우저를 띄웠다** — 준영님이 "8000 포트를
   * 브라우저로 띄워달라" 했더니 `forward_create` 까지는 맞게 하고 그다음 PowerShell 로
   * `Start-Process http://127.0.0.1:8000` 을 불러 엣지를 열었다. 다시 시키니 이번엔 다른 MCP
   * 플러그인(playwright)을 찾아 썼다. 우리 화면 안에 브라우저가 있는데 거기 닿는 길이 없었다.
   */
  browser: BrowserService
  /** F26 서버 콘솔의 고정 명령 표. 화면만 쓰던 것을 아라에게도 연다(2026-08-26). */
  remote: RemoteConsoleService
  /** 세션 기록(F12). 늦은 바인딩 — 로거는 userData 경로를 알아야 만들 수 있다. */
  sessionLog: () => SessionLogService | null
  /** 사람이 쳤던 명령(F11). "저번에 쓰던 그 명령" 을 찾는 길. */
  history: HistoryStore
  /**
   * 화면 아래 패널을 열어 준다(2026-08-26 준영님 제안). 결과가 수백 줄일 때 아라가 그걸 글로
   * 옮겨 적는 대신 **원래 그걸 보라고 만든 화면**을 열어 주는 길이다. 없는 패널이면 false.
   */
  showPanel: (panel: string) => boolean
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

/**
 * "그런 프로필 없다"에 **등록된 목록을 함께 실어 보낸다**(2026-08-26).
 *
 * 준영님이 잡은 장면: 아라가 `ssh_connect('kvt')` — 이름을 id 자리에 넣어 실패하자, 우리
 * `workspace.json` 을 glob·grep 해 UUID 를 찾아내 다시 붙었다. 다섯 번 헛돌았고 설정 파일이
 * 통째로 모델 컨텍스트에 들어갔다. 실패가 **다음 수를 알려 주지 않으면** 모델은 파일을 뒤진다.
 *
 * 이름·id 만 준다. 호스트·사용자·비밀은 이 툴이 다루는 것이 아니다(설계 §1.3 이 `profile:*` 를
 * 뺀 이유는 자격증명 CRUD 이지, 어느 서버가 있는지를 숨기는 것이 아니다 — 그건 사용자가 등록한
 * 이름이고 화면 사이드바에 이미 떠 있다).
 */
function unknownProfileText(profiles: ProfileStore): string {
  const list = profiles.list().filter((p) => p.type === 'ssh')
  if (list.length === 0) return '등록된 서버가 없습니다. 사용자가 연결 관리자에서 먼저 등록해야 합니다.'
  const rows = list.map((p) => `${p.name} = ${p.id}`).join('\n')
  return `그 서버를 찾을 수 없습니다. **이름이 아니라 id 로** 지정하세요. 등록된 서버:\n${rows}`
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

/**
 * 도구 묶음(2026-08-26 준영님 지시).
 *
 * *"우리 도구가 많다보니까 전체 도구를 그냥 주는것보다 그룹화해서 먼저 그룹에서 선택,
 * 그리고 그 그룹에서 도구 선택할 수 있게 비슷한 도구끼리 모아놓자."*
 *
 * 28개를 통째로 물리면 모델이 매번 그 스키마를 다 읽는다. 그래서 **밖으로 나가는 도구는 둘뿐**이고
 * (`ara_tools`·`ara_call`) 진짜 도구는 이 표 안에 산다. 잘못 고르면 `ara_tools` 를 다시 부르면 된다 —
 * 되돌아갈 자리가 있어야 사람도 모델도 헤매지 않는다.
 */
// 묶음 표는 shared 에 있다 — 말투 글(araPersona)도 같은 표를 읽어야 지도가 안 어긋난다.
export { GROUPS, type ToolGroup } from '@shared/araTools'

type ToolDef = {
  group: TG
  description: string
  /** 인자 스키마. `ara_call` 이 이걸로 검증한 뒤에야 핸들러가 돈다(zod 경계는 그대로다). */
  schema: z.ZodTypeAny
  /** 사람 눈으로 읽는 인자 요약 — ara_tools 가 이걸 준다. */
  argsHint: string
  readOnly: boolean
  run: (args: Record<string, unknown>) => Promise<ToolResult>
}

/**
 * 밖으로 나가는 문 둘(2026-08-26). **MCP 와 API 엔진이 같은 문을 쓴다** — 도구 실행·승인 게이트·
 * 감사 로그가 한 벌이어야 "어느 엔진으로 했든 같은 규칙" 이 성립한다.
 */
export type AraToolGate = {
  /** `ara_tools` — 묶음 목록 / 그 묶음의 도구와 인자. */
  tools(group?: string): string
  /** `ara_call` — 실제 실행. 인자 검증·승인·감사를 모두 지난다. */
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>
  /** 프로바이더에 넘길 스키마(function calling). **둘뿐이라 손으로 쓴다** — 28개였다면 못 했다. */
  readonly doors: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
}

export function buildAraTools(ctx: ToolCtx): AraToolGate {
  const TOOLS = new Map<string, ToolDef>()

  /**
   * 표에 한 줄 얹는다. 예전 `server.registerTool` 과 **같은 모양**을 유지한다 — 핸들러 안의 승인
   * 게이트(`g(...)`)도 그대로다. 바뀐 것은 "어디에 등록되나"뿐이라 도구 하나하나의 사고 이력이
   * 담긴 주석이 제자리에 남는다.
   */
  const T = <S extends z.ZodRawShape>(
    name: string,
    group: TG,
    spec: { description: string; inputSchema: S; annotations?: { readOnlyHint?: boolean } },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
  ): void => {
    const shape = spec.inputSchema
    const keys = Object.keys(shape)
    TOOLS.set(name, {
      group,
      description: spec.description,
      schema: z.object(shape),
      argsHint: keys.length === 0 ? '(없음)' : keys.join(', '),
      readOnly: spec.annotations?.readOnlyHint === true,
      run: run as (args: Record<string, unknown>) => Promise<ToolResult>
    })
  }

  const g = (
    sessionId: string | null,
    tool: string,
    cls: ToolClass,
    args: Record<string, unknown>,
    exec: () => Promise<ToolResult>
  ) => gated(ctx.approval, sessionId, tool, cls, args, exec)

  // ssh_connect 와 session_create(type:'ssh') 가 같은 문을 쓴다. **없는 프로필을 먼저 거른다** —
  // 그래야 "찾을 수 없다"에 등록된 목록을 실어 보낼 수 있다(그 안내가 없으면 모델이 파일을 뒤진다).
  const connectProfile = async (profileId: string): Promise<ToolResult> => {
    if (!ctx.profiles.get(profileId)) return fail(unknownProfileText(ctx.profiles))
    const res = await connectByProfile(ctx.profiles, ctx.ws, ctx.sessions, profileId, false)
    return res.ok ? ok(JSON.stringify({ id: res.id, title: res.title })) : fail(sshFailureText(res))
  }

  // ── 사람에게 되묻기 ────────────────────────────────────────────────────────
  // 설명문이 곧 사용 설명서다: 모델은 이 글을 읽고 "언제 이 도구를 쓸지"를 정한다.
  // 그래서 **언제 써야 하는지**를 또박또박 적는다(추측하지 말고 물어라).
  T(
    'ask_user',
    'ask',
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
  T(
    'aisession_list',
    'ai',
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

  T(
    'aisession_send',
    'ai',
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

  T(
    'session_list',
    'session',
    {
      // 아라가 이걸 "서버 목록"으로 착각해 먼저 불렀다(2026-08-26 감사 로그 첫 줄). 빈 배열을 받고
      // 그때부터 헤맸다 — **아닌 것을 아니라고 적는 것**이 이 한 줄의 일이다.
      description:
        '**지금 열려 있는 탭** 목록입니다(로컬 셸·SSH). 사용자가 화면에서 보고 있는 탭 그대로입니다. ' +
        '등록된 서버 목록이 **아닙니다** — 접속할 서버는 시스템 프롬프트의 "등록된 서버" 표에 있습니다. ' +
        '비어 있으면 아직 아무 탭도 안 열린 것이고, 접속이 필요하면 ssh_connect 를 쓰면 됩니다.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      g(null, 'session_list', 'readOnly', {}, async () =>
        ok(JSON.stringify(ctx.sessions.snapshot().map((s) => ({ id: s.id, type: s.type, title: s.title, serverKey: s.serverKey, cwd: s.cwd ?? null }))))
      )
  )

  T(
    'session_read',
    'session',
    {
      description:
        '그 탭의 최근 터미널 출력을 읽습니다(사용자가 화면에서 보고 있는 것과 같은 내용). ' +
        '명령을 보낸 뒤 결과를 보려면 session_input 다음에 잠깐 두고 이걸 부르세요 — ' +
        '길면 앞이 잘립니다(최근 것부터 남습니다).',
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

  T(
    'session_create',
    'session',
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
          return await connectProfile(args.profileId)
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

  T(
    'session_input',
    'session',
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

  T(
    'session_destroy',
    'session',
    { description: '세션을 종료합니다(탭을 닫는 것과 같습니다).', inputSchema: { sessionId: z.string() } },
    async ({ sessionId }) =>
      g(sessionId, 'session_destroy', 'writeAlways', { sessionId }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        ctx.sessions.destroy(sessionId)
        return ok('종료함')
      })
  )

  T(
    'ssh_connect',
    'session',
    {
      description:
        '등록된 프로필로 SSH 접속합니다. 화면에 새 탭으로 나타나고 사용자가 바로 쓸 수 있습니다. ' +
        'profileId 로만 지정합니다 — 호스트·자격증명은 이 툴로 전달할 수 없습니다.',
      inputSchema: { profileId: z.string() }
    },
    async ({ profileId }) =>
      g(null, 'ssh_connect', 'writeAlways', { profileId }, () => connectProfile(profileId))
  )

  T(
    'sftp_list',
    'file',
    {
      description:
        '원격 폴더의 파일 목록입니다. sessionId 는 session_list 가 준 SSH 탭의 id 입니다 — '  +
        '사용자가 사이드바 [파일] 트리에서 보는 것과 같은 내용입니다.',
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

  T(
    'sftp_download',
    'file',
    {
      description:
        '원격 파일을 내 PC 로 내려받습니다. 저장 위치는 고정 폴더(mcp-downloads) 안으로 한정되고, ' +
        'fileName 에는 경로 구분자를 쓸 수 없습니다 — 임의 경로에 쓸 수 없다는 뜻입니다. ' +
        '**내용을 읽어서 사용자에게 설명하려는 것이라면 내려받지 마세요** — 그건 파일을 옮기는 도구입니다.',
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

  T(
    'sftp_upload',
    'file',
    {
      description:
        '고정 폴더(mcp-uploads) 안의 파일을 원격으로 올립니다. 임의 로컬 경로는 지정할 수 없습니다 — ' +
        '사용자가 그 폴더에 넣어 둔 것만 올라갑니다. 올린 뒤 사이드바 [파일] 트리를 새로 고치면 보입니다.',
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

  T(
    'sftp_mkdir',
    'file',
    {
      description: '원격에 폴더를 만듭니다. 사이드바 [파일] 트리에 그대로 나타납니다.',
      inputSchema: { sessionId: z.string(), dir: z.string(), name: z.string() }
    },
    async ({ sessionId, dir, name }) =>
      g(sessionId, 'sftp_mkdir', 'writeAlways', { sessionId, dir, name }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.mkdir(sessionId, dir, name)
        return res.ok ? ok('생성함') : fail(res.message)
      })
  )

  T(
    'sftp_rename',
    'file',
    {
      description: '원격 파일·폴더 이름을 바꿉니다. 사이드바 [파일] 트리에 그대로 반영됩니다.',
      inputSchema: { sessionId: z.string(), path: z.string(), name: z.string() }
    },
    async ({ sessionId, path, name }) =>
      g(sessionId, 'sftp_rename', 'writeAlways', { sessionId, path, name }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.rename(sessionId, path, name)
        return res.ok ? ok('변경함') : fail(res.message)
      })
  )

  T(
    'sftp_remove',
    'file',
    {
      // **되돌릴 수 없다**를 설명문에 적는다 — 모델이 확인을 받을지 정하는 근거가 여기다.
      description:
        '원격 파일·폴더를 **영구 삭제**합니다(폴더는 재귀). 원격에는 휴지통이 없어 되돌릴 수 없습니다 — ' +
        '지우기 전에 무엇을 지우는지 사용자에게 확인받으세요.',
      inputSchema: { sessionId: z.string(), paths: z.array(z.string()) }
    },
    async ({ sessionId, paths }) =>
      g(sessionId, 'sftp_remove', 'writeAlways', { sessionId, paths }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.remove(sessionId, randomUUID(), paths)
        return res.ok ? ok('삭제함') : fail(res.message)
      })
  )

  T(
    'forward_list',
    'net',
    {
      description:
        '지금 연결돼 있는 포트 목록입니다(원격 포트 ↔ 내 PC 의 localPort). ' +
        '화면 아래 [포트] 패널에 보이는 그 목록입니다. 브라우저로 열려면 localPort 를 browser_open 에 넘기세요.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => g(null, 'forward_list', 'readOnly', {}, async () => ok(JSON.stringify(ctx.forwards.list())))
  )

  T(
    'forward_create',
    'net',
    {
      description:
        '원격 서버의 포트를 내 PC 로 끌어옵니다(원격 127.0.0.1:remotePort → 내 PC 의 빈 포트). ' +
        '**웹 화면을 보여 드리려면 여기서 끝내지 마세요** — 돌려주는 localPort 로 ' +
        '`browser_open("http://localhost:<localPort>")` 까지 해야 사용자 화면에 실제로 뜹니다. ' +
        '이 둘이 화면의 [포트] 패널 [열기] 버튼이 하는 일 그대로입니다.',
      inputSchema: { sessionId: z.string(), remotePort: z.number() }
    },
    async ({ sessionId, remotePort }) =>
      g(sessionId, 'forward_create', 'writeAlways', { sessionId, remotePort }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.forwards.create(sessionId, remotePort)
        return res.ok ? ok(JSON.stringify(res.forward)) : fail(res.message)
      })
  )

  T(
    'forward_stop',
    'net',
    {
      description: '포트 연결을 끊습니다. 그 주소를 보고 있던 브라우저 탭은 더 이상 열리지 않습니다.',
      inputSchema: { id: z.string() }
    },
    // writeAlways 로 올렸다(2026-08-26 감사). 사용자가 열어 둔 터널을 끊는 일이라 화면이 그만큼
    // 바뀐다 — 만드는 것을 물어보면서 끊는 것을 안 묻는 비대칭이 이유 없이 놀랍다.
    async ({ id }) =>
      g(null, 'forward_stop', 'writeAlways', { id }, async () => {
        ctx.forwards.stop(id)
        return ok('중지함')
      })
  )

  /**
   * 아라 안의 브라우저(2026-08-26 준영님 제보). **이게 없어서 아라가 밖으로 나갔다.**
   *
   * 사용자 화면 안에서 웹을 보여 주는 유일한 길이다. 로컬 브라우저(Start-Process·open·xdg-open)나
   * 다른 브라우저 자동화 도구를 쓰면 우리 창 밖에 뜬다 — 사용자가 원한 것은 늘 우리 창 안이다.
   *
   * 열리는 자리는 사람이 [포트] 패널 [열기]를 눌렀을 때와 **같은 창·같은 탭 줄**이다. 같은 오리진이
   * 이미 떠 있으면 그 탭을 다시 쓴다(창이 늘지 않는다).
   */
  T(
    'browser_open',
    'net',
    {
      description:
        '**아라 안의 브라우저**에 웹 주소를 띄웁니다. 사용자 화면 안에 탭으로 열립니다 — ' +
        '웹 페이지를 보여 드릴 때는 항상 이 도구를 쓰세요. ' +
        '내 PC 의 브라우저를 실행하거나(Start-Process·open·xdg-open 등) 다른 브라우저 도구를 쓰지 마세요 — ' +
        '그건 우리 창 밖에 떠서 사용자가 원한 화면이 아닙니다. ' +
        '원격 서버의 웹을 보여 주려면 forward_create 로 포트를 끌어온 뒤 그 localPort 주소를 넘기세요. ' +
        'http/https 만 열립니다.',
      inputSchema: { url: z.string() }
    },
    async ({ url }) =>
      g(null, 'browser_open', 'writeAlways', { url }, async () => {
        // 스킴 게이트는 BrowserTabs.openTab 안의 isSafeExternal 이 본다 — 여기서 두 번 쓰지 않는다.
        if (!ctx.browser.open(url)) return fail('열 수 없는 주소입니다(http/https 만 됩니다).')
        return ok('아라 브라우저에 띄웠습니다.')
      })
  )

  T(
    'browser_close',
    'net',
    {
      description:
        '아라 브라우저에서 그 주소(오리진)의 탭을 닫습니다. 마지막 탭이면 브라우저 창이 함께 닫힙니다. ' +
        'origin 은 "http://localhost:8000" 처럼 스킴+호스트+포트까지입니다.',
      inputSchema: { origin: z.string() }
    },
    async ({ origin }) =>
      g(null, 'browser_close', 'writeAlways', { origin }, async () =>
        ctx.browser.closeOrigin(origin) ? ok('닫았습니다.') : fail('그 주소로 열린 탭이 없습니다.')
      )
  )

  // ── 서버 상태 ──────────────────────────────────────────────────────────────
  /**
   * F26 서버 콘솔을 아라에게 연다(2026-08-26).
   *
   * **표가 이미 있었는데 안 물려 있었다.** `shared/remoteCatalog.ts` 는 고정 명령 + 파서라
   * 렌더러가 명령 문자열을 못 넘긴다 — 그 안전한 표를 화면만 쓰고 아라는 못 썼다. 그래서 아라는
   * 프로세스 목록이 필요하면 `session_input('ps aux')` 로 **사용자 터미널에 명령을 치고** 흘러가는
   * 글자를 눈으로 파싱해야 했다. 여기를 열면 구조화된 표를 받고 터미널도 안 더럽힌다.
   *
   * 명령 문자열은 여전히 표 밖으로 못 나간다 — cmdId 와 검증된 인자만 받는다.
   */
  T(
    'server_run',
    'server',
    {
      description:
        '서버 상태를 정해진 명령으로 조회하거나 조작합니다. **결과가 표로 정리돼 돌아옵니다** — ' +
        '터미널에 직접 명령을 치지 마세요(사용자 화면이 지저분해지고 출력을 글자로 파싱해야 합니다). ' +
        'cmdId 목록: ps.list(프로세스) ps.kill svc.list(서비스) svc.action disk.usage disk.du ' +
        'sys.overview(배포판·커널·가동시간) pkg.probe(설치된 프로그램) ctr.list(컨테이너) ctr.action ctr.rmi ' +
        'k8s.list which.cli(그 CLI 가 깔려 있나) git.worktree.add git.worktree.remove. ' +
        '인자가 필요한 것은 args 에 넣습니다(예: ps.kill → {pid}, svc.action → {unit, action}). ' +
        '인자가 표의 규칙에 안 맞으면 아무것도 실행하지 않고 거절합니다. ' +
        '**돌려받은 목록이 수십 줄을 넘으면 글로 옮겨 적지 말고 panel_show 로 그 화면을 열어 주세요.**',
      inputSchema: { sessionId: z.string(), cmdId: z.string(), args: z.record(z.string(), z.unknown()).optional() }
    },
    async ({ sessionId, cmdId, args }) =>
      // 등급은 표가 정한다 — 쓰기 명령(kill·systemctl·rmi)만 승인을 받는다.
      g(
        sessionId,
        'server_run',
        // 등급을 여기서 새로 정하지 않는다 — 무엇이 쓰기인지는 표가 이미 안다(kill·systemctl·rmi…).
        COMMANDS[cmdId as CmdId]?.write === true ? 'writeAlways' : 'readOnly',
        { sessionId, cmdId, args },
        async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
          const res = await ctx.remote.run(sessionId, cmdId as CmdId, args)
          // 실패 사유가 badArgs 면 인자가 표의 규칙을 벗어난 것이다 — 모델이 고쳐서 다시 부를 수 있게 그대로 준다.
          if (!res.ok) return fail(`명령을 실행하지 못했습니다(${res.reason}). cmdId 와 args 를 확인하세요.`)
          return ok(JSON.stringify({ out: res.out, code: res.code }))
        }
      )
  )

  /**
   * 결과가 많을 때 **글로 옮겨 적지 말고 화면을 열어 준다**(2026-08-26 준영님 제안).
   *
   * 실제로 있었던 일: *"kvt 프로세스 목록 보여줘"* → 아라가 수백 줄을 받아 놓고 *"여기서 한 번에
   * 정리해 드리기 어렵습니다"* 라고 답했다. 그런데 그 목록을 보라고 만든 화면이 이미 아래에 있다.
   */
  T(
    'panel_show',
    'server',
    {
      description:
        '화면 아래 패널을 열어 사용자에게 보여 줍니다. **결과가 수십 줄을 넘으면 글로 옮겨 적지 말고 ' +
        '이 도구로 그 화면을 열어 주고 "화면 아래 [○○] 탭에서 보실 수 있습니다" 라고 안내하세요** — ' +
        '표·정렬·검색이 다 되는 화면이라 글보다 낫습니다. 몇 줄뿐이면 그냥 답에 쓰는 게 낫습니다. ' +
        'panel: ps(프로세스) svc(서비스) disk(디스크) pkg(패키지) ctr(컨테이너) k8s monitor(포트) ' +
        'sys(자원) log(로그).',
      inputSchema: { panel: z.string() }
    },
    async ({ panel }) =>
      g(null, 'panel_show', 'readOnly', { panel }, async () =>
        ctx.showPanel(panel)
          ? ok(`화면 아래 [${panel}] 탭을 열었습니다. 사용자에게 그 탭에서 볼 수 있다고 알려 주세요.`)
          : fail('그런 패널이 없습니다. ps·svc·disk·pkg·ctr·k8s·monitor·sys·log 중에서 고르세요.')
      )
  )

  T(
    'tmux_list',
    'server',
    {
      description: '그 서버에 떠 있는 tmux 세션 목록입니다. tmux 가 없으면 그렇게 알려 줍니다.',
      inputSchema: { sessionId: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId }) =>
      g(sessionId, 'tmux_list', 'readOnly', { sessionId }, async () => {
        const client = ctx.sessions.sshClient(sessionId)
        if (!client) return fail('SSH 세션이 아니거나 연결이 끊겼습니다.')
        return ok(JSON.stringify(await fetchTmuxSessions(client)))
      })
  )

  // ── 원격 텍스트 파일 ────────────────────────────────────────────────────────
  // sftp_download 와 다르다: 이쪽은 **내용을 바로 다룬다**(파일을 옮기지 않는다). 아라가 설정 파일
  // 한 줄을 고치려고 download → 로컬 편집 → upload 로 세 번 도는 것을 없앤다.
  T(
    'file_read',
    'file',
    {
      description:
        '원격 **텍스트 파일의 내용**을 읽습니다. 파일을 옮기지 않습니다 — 내용을 보거나 고치려면 ' +
        'sftp_download 말고 이걸 쓰세요. 사용자가 편집기 창에서 보는 것과 같은 내용입니다.',
      inputSchema: { sessionId: z.string(), path: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId, path }) =>
      g(sessionId, 'file_read', 'readOnly', { sessionId, path }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.readText(sessionId, path)
        // D1 과 같은 자리에서 마스킹한다 — 설정 파일에는 비밀이 흔하다.
        return res.ok ? ok(capContext(maskSecrets(res.text))) : fail(res.message)
      })
  )

  T(
    'file_write',
    'file',
    {
      description:
        '원격 텍스트 파일을 **통째로 덮어씁니다**(일부만 고치려면 file_read 로 읽어 고친 전문을 넘기세요). ' +
        '되돌리기 어려우니 무엇을 바꾸는지 사용자에게 먼저 알리세요. eol 은 lf 가 기본입니다.',
      inputSchema: {
        sessionId: z.string(),
        path: z.string(),
        text: z.string(),
        eol: z.enum(['lf', 'crlf']).optional()
      }
    },
    async ({ sessionId, path, text, eol }) =>
      g(sessionId, 'file_write', 'writeAlways', { sessionId, path, bytes: text.length }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.writeText(sessionId, path, text, eol === 'crlf' ? 'crlf' : 'lf')
        return res.ok ? ok('저장했습니다.') : fail(res.message)
      })
  )

  // ── 기록 ────────────────────────────────────────────────────────────────────
  T(
    'log_read',
    'record',
    {
      description:
        '원격 **로그 파일의 끝부분**을 읽습니다(뒤에서부터 창 단위). 사용자 화면의 로그 뷰어가 ' +
        '[이전 불러오기] 로 하는 그 일입니다. `tail -f` 를 터미널에 치지 마세요 — 그 탭이 묶여 버립니다. ' +
        'before 에 이전 응답의 start 를 넣으면 그 앞을 더 읽습니다.',
      inputSchema: { sessionId: z.string(), path: z.string(), before: z.number().optional() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId, path, before }) =>
      g(sessionId, 'log_read', 'readOnly', { sessionId, path, before }, async () => {
        if (!ctx.sessions.has(sessionId)) return fail('세션을 찾을 수 없습니다.')
        const res = await ctx.sftp.readWindow(sessionId, path, before)
        return res.ok ? ok(JSON.stringify({ ...res, text: capContext(maskSecrets(res.text)) })) : fail(res.message)
      })
  )

  T(
    'record_list',
    'record',
    {
      description:
        '**지난 세션 기록** 목록입니다(날짜·서버·파일 이름). *"어제 그 서버에서 뭐 했더라"* 에 답할 때 씁니다. ' +
        '내용은 record_read 에 file 을 넘겨 읽습니다. 기록이 꺼져 있으면 빈 목록입니다.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      g(null, 'record_list', 'readOnly', {}, async () => ok(JSON.stringify(ctx.sessionLog()?.listPast() ?? [])))
  )

  T(
    'record_read',
    'record',
    {
      description:
        '세션 기록을 읽습니다. **지금 열려 있는 탭**은 sessionId 로, **지난 기록**은 record_list 가 준 ' +
        'file 로 지정합니다(둘 중 하나만). 뒤에서부터 창 단위로 옵니다 — before 에 이전 응답의 start 를 ' +
        '넣으면 그 앞을 더 읽습니다.',
      inputSchema: { sessionId: z.string().optional(), file: z.string().optional(), before: z.number().optional() },
      annotations: { readOnlyHint: true }
    },
    async ({ sessionId, file, before }) =>
      g(sessionId ?? null, 'record_read', 'readOnly', { sessionId, file, before }, async () => {
        const log = ctx.sessionLog()
        // 경로 확정·이름 검증은 pathOfFile 이 한다(렌더러와 같은 신뢰 경계를 그대로 쓴다).
        const path = file ? (log?.pathOfFile(file) ?? null) : sessionId ? (log?.pathOf(sessionId) ?? null) : null
        if (path) {
          const res = readFileWindow(path, before)
          return res.ok ? ok(JSON.stringify({ ...res, text: capContext(maskSecrets(res.text)) })) : fail(res.message)
        }
        // 기록이 꺼져 있으면 화면 버퍼가 전부다 — session_read 와 같은 자리로 떨어진다.
        if (sessionId && ctx.sessions.has(sessionId)) {
          const text = normalizeCr(stripAnsi(Buffer.from(ctx.sessions.peek(sessionId)).toString('utf8'), newStripState()))
          return ok(capContext(maskSecrets(text)))
        }
        return fail('기록을 찾을 수 없습니다. record_list 로 지난 기록 이름을 먼저 확인하세요.')
      })
  )

  T(
    'history_list',
    'record',
    {
      description:
        '그 서버에서 **사람이 쳤던 명령** 목록입니다(최근 순). scope 는 SSH 면 서버 이름(session_list 의 ' +
        'serverKey), 로컬이면 "local" 입니다. *"저번에 쓰던 그 명령"* 을 찾을 때 씁니다.',
      inputSchema: { scope: z.string() },
      annotations: { readOnlyHint: true }
    },
    async ({ scope }) =>
      g(null, 'history_list', 'readOnly', { scope }, async () => ok(JSON.stringify(ctx.history.load(scope))))
  )

  // ── 밖으로 나가는 도구는 이 둘뿐이다 ────────────────────────────────────────
  const groupList = groupLines

  const DOOR_TOOLS_DESC =
    'A.R.A(아라) 가 할 수 있는 일의 **목록**입니다. group 없이 부르면 묶음 목록이, group 을 주면 ' +
    '그 묶음의 도구와 인자가 옵니다. **무엇을 할 수 있는지 모를 때 먼저 여기를 보세요.** ' +
    '묶음을 잘못 골랐으면 group 없이 다시 부르면 처음으로 돌아옵니다. ' +
    '실행은 ara_call 로 합니다.'
  const DOOR_CALL_DESC =
    '아라 도구를 실행합니다. tool 이름과 args 는 ara_tools 가 알려 줍니다. ' +
    '없는 이름을 주면 묶음 목록을 돌려주니 거기서 다시 고르면 됩니다.'

  const runTools = (group?: string): string => {
    if (!group) return `아라 도구 묶음입니다. ara_tools({group}) 로 안을 보세요.\n\n${groupList()}`
    if (!(group in G)) return `"${group}" 이라는 묶음은 없습니다. 있는 묶음은 이렇습니다:\n\n${groupList()}`
    const rows = [...TOOLS.entries()]
      .filter(([, d]) => d.group === group)
      .map(([name, d]) => `## ${name}${d.readOnly ? ' (읽기)' : ''}\n인자: ${d.argsHint}\n${d.description}`)
      .join('\n\n')
    return `# ${group} — ${G[group as TG]}\n\n${rows}\n\n실행: ara_call({tool, args})`
  }

  const runCall = async (tool: string, args?: Record<string, unknown>): Promise<ToolResult> => {
    const def = TOOLS.get(tool)
    if (!def) {
      const near = [...TOOLS.keys()].filter((n) => n.includes(tool) || tool.includes(n.split('_')[0]))
      return fail(
        `"${tool}" 이라는 도구가 없습니다.` +
          (near.length ? ` 비슷한 것: ${near.join(', ')}.` : '') +
          `\n\n묶음부터 다시 고르세요:\n${groupList()}`
      )
    }
    // 인자 검증은 **여기 한 곳**이다. zod 경계(스키마 밖 필드는 핸들러에 닿지 않는다)를 그대로 지킨다.
    const parsed = def.schema.safeParse(args ?? {})
    if (!parsed.success) {
      return fail(`${tool} 의 인자가 맞지 않습니다(필요: ${def.argsHint}). ${parsed.error.issues[0]?.message ?? ''}`)
    }
    return def.run(parsed.data as Record<string, unknown>)
  }

  return {
    tools: runTools,
    call: runCall,
    /**
     * function calling 에 넘길 스키마. **손으로 쓴다** — 문이 둘뿐이라 zod→JSON Schema 변환기를
     * 들일 이유가 없다(28개였다면 얘기가 달랐다). 프로바이더마다 감싸는 모양만 다르고 안쪽은 같다.
     */
    doors: [
      {
        name: 'ara_tools',
        description: DOOR_TOOLS_DESC,
        parameters: {
          type: 'object',
          properties: { group: { type: 'string', description: '묶음 이름. 없으면 묶음 목록을 준다.' } },
          required: []
        }
      },
      {
        name: 'ara_call',
        description: DOOR_CALL_DESC,
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'ara_tools 가 알려 준 도구 이름' },
            args: { type: 'object', description: '그 도구의 인자', additionalProperties: true }
          },
          required: ['tool']
        }
      }
    ]
  }
}

/**
 * MCP 서버에 문 둘을 건다. **실행은 게이트가 하고 여기는 등록만** 한다 —
 * 같은 게이트를 API 엔진도 쓰기 때문이다(2026-08-26).
 */
export function registerMcpTools(server: McpServer, ctx: ToolCtx): AraToolGate {
  const gate = buildAraTools(ctx)
  const [toolsDoor, callDoor] = gate.doors
  server.registerTool(
    'ara_tools',
    { description: toolsDoor.description, inputSchema: { group: z.string().optional() }, annotations: { readOnlyHint: true } },
    async ({ group }) => ok(gate.tools(group))
  )
  server.registerTool(
    'ara_call',
    { description: callDoor.description, inputSchema: { tool: z.string(), args: z.record(z.string(), z.unknown()).optional() } },
    async ({ tool, args }) => gate.call(tool, args)
  )
  return gate
}
