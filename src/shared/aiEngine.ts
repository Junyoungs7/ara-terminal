/**
 * 아라 엔진 — **대화 한 벌의 공통 언어**(#123).
 *
 * 엔진이 둘 이상이다(설계 §3): A = 이 PC 의 Claude Code 를 상주 프로세스로 띄우기,
 * B = API 키로 직접 부르기. 화면은 **둘을 구분하지 않는다** — 여기 정의한 사건만 받는다.
 * 그래야 한 갈래가 막혀도(구독 경로가 끊기거나 약관이 걸리거나) 제품이 죽지 않는다.
 *
 * 이 파일에는 **순수 함수만** 둔다: 프로세스도, IPC 도 없다. 그래야 렌더러와 main 이 같은
 * 타입을 쓰고, 파서를 프로세스 없이 시험할 수 있다.
 */

/** 화면이 받는 사건. 엔진이 무엇이든 이 모양으로 온다. */
export type AiEngineEvent =
  /**
   * 프로세스가 떴다 — 세션 id·모델·작업 폴더·**쓸 수 있는 도구 목록**.
   * 재개(`--resume`)에 세션 id 가 필요하고, 도구 목록은 "이 판에서 무엇이 가능한가"를 말해 준다
   * (예: 사람에게 되묻는 도구가 헤드리스에도 있는지 — #124b 관찰).
   */
  | { t: 'ready'; sessionId: string | null; model: string | null; cwd: string | null; tools: string[] }
  /** 어시스턴트가 쓴 글 조각. */
  | { t: 'text'; text: string }
  /** 도구를 부르기 시작했다. brief 는 사람이 읽을 한 줄(명령·파일 이름 등). */
  | { t: 'tool'; id: string; name: string; brief: string }
  /** 도구가 끝났다. */
  | { t: 'toolResult'; id: string; ok: boolean; brief: string }
  /**
   * 권한을 물어 왔다(Claude Code 의 기본 도구). 답은 사람이 한다 — 우리가 대신 승인하지 않는다.
   * 왕복 배선은 #124 다. 여기서는 **모양만** 정해 둔다.
   */
  | { t: 'permission'; requestId: string; tool: string; brief: string }
  /** 한 턴이 끝났다 — 비용·시간·턴 수. */
  | { t: 'turn'; costUsd: number | null; ms: number; turns: number; text: string }
  | { t: 'error'; message: string }
  | { t: 'exit'; code: number | null }

/** 엔진 하나. 대화 하나가 이걸 하나 쥔다. */
export type AiEngine = {
  send(text: string): void
  /** 권한 요청에 답한다(#124). */
  respondPermission(requestId: string, allow: boolean): void
  /** 지금 턴을 멈춘다. */
  interrupt(): void
  /** 프로세스를 내린다. 앱을 끌 때 반드시 부른다 — 고아 프로세스를 남기지 않는다(#64 규율). */
  dispose(): void
  onEvent(fn: (e: AiEngineEvent) => void): () => void
}

// ── stream-json 파싱 ─────────────────────────────────────────────────────────
// Claude Code 는 `--output-format stream-json` 에서 **줄마다 JSON 하나**를 뱉는다.
// 모양은 버전마다 늘어난다 — 그래서 **아는 것만 집고 모르는 줄은 조용히 흘린다.**
// 낯선 타입에 예외를 던지면 CLI 가 새 이벤트를 하나 추가한 날 대화창이 죽는다.

/** 도구 한 줄 요약. 사람이 목록에서 훑을 수 있어야 한다("무엇을 했나"가 한눈에). */
export function toolBrief(_name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
  // 자주 쓰는 도구는 **그 도구에서 제일 중요한 인자**를 집는다.
  const pick =
    s('command') || s('file_path') || s('path') || s('pattern') || s('url') || s('query') || s('prompt') || s('description')
  if (pick !== '') return cut(pick)
  // 모르는 도구 — 문자열 인자 아무거나 하나(이름만 덜렁 있는 것보다 낫다).
  const first = Object.values(o).find((v) => typeof v === 'string' && v !== '')
  return typeof first === 'string' ? cut(first) : ''
}

const cut = (s: string, n = 120): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

/** 도구 결과 요약. 성공이면 앞부분만, 실패면 그 이유가 앞에 있다. */
function resultBrief(content: unknown): string {
  if (typeof content === 'string') return cut(content)
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter((x) => x !== '')
      .join(' ')
    return cut(text)
  }
  return ''
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 줄 하나 → 사건 여럿(한 줄에 도구 호출이 여러 개 실릴 수 있다).
 * JSON 이 아니거나 모르는 타입이면 **빈 배열**이다 — 던지지 않는다.
 */
export function parseStreamJson(line: string): AiEngineEvent[] {
  const s = line.trim()
  if (s === '' || !s.startsWith('{')) return []
  let m: Record<string, unknown>
  try {
    m = JSON.parse(s) as Record<string, unknown>
  } catch {
    return []
  }
  switch (m.type) {
    case 'system':
      // subtype 은 init 말고도 늘어난다. 우리가 쓰는 건 첫 init 하나다.
      if (m.subtype !== 'init') return []
      return [
        {
          t: 'ready',
          sessionId: str(m.session_id),
          model: str(m.model),
          cwd: str(m.cwd),
          tools: Array.isArray(m.tools) ? m.tools.filter((x): x is string => typeof x === 'string') : []
        }
      ]

    case 'assistant': {
      const content = ((m.message as { content?: unknown } | undefined)?.content ?? []) as unknown[]
      const out: AiEngineEvent[] = []
      for (const raw of Array.isArray(content) ? content : []) {
        const c = raw as Record<string, unknown>
        if (c.type === 'text' && str(c.text)) out.push({ t: 'text', text: String(c.text) })
        else if (c.type === 'tool_use') {
          out.push({
            t: 'tool',
            id: str(c.id) ?? '',
            name: str(c.name) ?? '',
            brief: toolBrief(String(c.name ?? ''), c.input)
          })
        }
      }
      return out
    }

    case 'user': {
      // 도구 결과는 **user 메시지에 실려** 돌아온다(모델에게 주는 입력이라 그렇다).
      const content = ((m.message as { content?: unknown } | undefined)?.content ?? []) as unknown[]
      const out: AiEngineEvent[] = []
      for (const raw of Array.isArray(content) ? content : []) {
        const c = raw as Record<string, unknown>
        if (c.type !== 'tool_result') continue
        out.push({
          t: 'toolResult',
          id: str(c.tool_use_id) ?? '',
          ok: c.is_error !== true,
          brief: resultBrief(c.content)
        })
      }
      return out
    }

    case 'result':
      return [
        {
          t: 'turn',
          costUsd: num(m.total_cost_usd),
          ms: num(m.duration_ms) ?? 0,
          turns: num(m.num_turns) ?? 0,
          text: str(m.result) ?? ''
        }
      ]

    // 권한 요청은 control 채널로 온다(#124 에서 왕복을 잇는다).
    case 'control_request': {
      const req = (m.request ?? {}) as Record<string, unknown>
      if (req.subtype !== 'can_use_tool') return []
      return [
        {
          t: 'permission',
          requestId: str(m.request_id) ?? '',
          tool: str(req.tool_name) ?? '',
          brief: toolBrief(String(req.tool_name ?? ''), req.input)
        }
      ]
    }

    default:
      return []
  }
}

/** 사람이 친 한 마디 → stdin 에 넣을 줄(스트리밍 입력 모드의 형식). */
export function userMessageLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }) + '\n'
  )
}

/** 지금 턴을 멈춰 달라는 control 요청. */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n'
}

/** 권한 요청에 대한 답(#124 에서 쓴다). */
export function permissionReplyLine(requestId: string, allow: boolean): string {
  return (
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: {} } : { behavior: 'deny', message: '사용자가 거절했습니다' }
      }
    }) + '\n'
  )
}

export type ClaudeArgsOpts = {
  /** 아라 MCP 설정 파일 경로(#124). 없으면 붙이지 않는다. */
  mcpConfigPath?: string
  /** 이어서 할 대화의 세션 id. */
  resumeId?: string
  /** 이 세션에 쓸 새 id(재개하려면 우리가 알아야 한다). */
  sessionId?: string
  /** 사용자의 권한 설정을 따른다 — 우리가 기본값을 바꾸지 않는다. */
  permissionMode?: string
  /**
   * 아라 문지기가 막는 도구들(#135, shared/aiGate.ts 가 목록을 만든다).
   * 비어 있으면 플래그 자체를 안 붙인다 — 기본은 "아무것도 막지 않는다"다.
   */
  disallowed?: readonly string[]
}

/**
 * 상주 프로세스로 띄울 때의 인자.
 *
 * **여기에 사람이 친 글자는 한 자도 들어가지 않는다.** 질문은 전부 stdin 으로 간다 —
 * 명령줄에 실으면 인용·인코딩 문제가 생기고(윈도우에서 한글이 잘렸다), 원격의 `ps` 에도 남는다.
 *
 * 끄지 않는 것들(설계 §3.2): `--bare` 를 쓰지 않는다. 훅·스킬·플러그인·CLAUDE.md 를 그대로 읽어야
 * "평소 쓰는 그 Claude Code" 가 된다. `--allowedTools` 로 **우리 도구만** 미리 통과시키고
 * (승인은 아라 게이트가 이미 한다 — 두 번 묻지 않는다) 기본 도구의 권한은 사용자 설정을 따른다.
 */
export function buildClaudeArgs(o: ClaudeArgsOpts = {}): string[] {
  const a = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // stream-json 출력은 --verbose 를 요구한다(없으면 CLI 가 거절한다).
    '--verbose',
    // 우리 MCP 도구는 아라 승인 게이트가 이미 지킨다 — Claude Code 쪽에서 또 묻지 않는다.
    '--allowedTools',
    'mcp__ara__*'
  ]
  if (o.mcpConfigPath) a.push('--mcp-config', o.mcpConfigPath)
  if (o.resumeId) a.push('--resume', o.resumeId)
  else if (o.sessionId) a.push('--session-id', o.sessionId)
  if (o.permissionMode) a.push('--permission-mode', o.permissionMode)
  // 붙박이다 — 도는 중에 되돌릴 수 없어서(실측 §3.4f) 허용은 --resume 재기동으로 한다.
  if (o.disallowed && o.disallowed.length > 0) a.push('--disallowedTools', ...o.disallowed)
  return a
}
