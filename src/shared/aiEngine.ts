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
  /**
   * 한 턴이 끝났다 — 비용·시간·턴 수·토큰.
   * `costUsd` 는 Claude Code 의 `total_cost_usd` 그대로다 — **프로세스 누적값**이다(2.1.300 바이너리:
   * `total_cost_usd: costLedger.totalCostUSD()`). 더하면 이중 계산이 된다 — 마지막 값을 쓴다.
   * `tokens` 는 **이 턴 것**이다(result.usage 는 질의 하나의 값). 입력은 캐시 읽기·쓰기를 포함한다.
   */
  | { t: 'turn'; costUsd: number | null; ms: number; turns: number; text: string; tokens?: { input: number; output: number } }
  /**
   * 구독 한도(Claude Code `rate_limit_event`). pct 는 0~100, resetsAt 은 ms.
   * 계정 값이라 대화가 바뀌어도 유효하다 — 화면이 마지막 값을 기억한다.
   */
  | { t: 'limits'; five: AiLimit | null; week: AiLimit | null }
  /**
   * 맥락(컨텍스트 창) 사용량(아라 채팅 v3 #21). 실측 2.1.300: `assistant.message.usage` 의
   * input·cache_read·cache_creation 합이 지금 맥락에 든 토큰(`used`), `result.modelUsage[*].contextWindow`
   * 가 창 크기(`window`)다. 두 값은 서로 다른 줄로 오므로 한쪽만 실린다 — 화면이 마지막 값을 합친다.
   */
  | { t: 'context'; used?: number; window?: number }
  | { t: 'error'; message: string }
  | { t: 'exit'; code: number | null }

export type AiLimit = { pct: number; resetsAt: number | null }

/** 엔진 하나. 대화 하나가 이걸 하나 쥔다. */
export type AiEngine = {
  send(text: string): void
  /** 권한 요청에 답한다(#124). */
  respondPermission(requestId: string, allow: boolean): void
  /** 지금 턴을 멈춘다. */
  interrupt(): void
  /** 권한 모드를 도는 중에 바꾼다(#136 계획 승인). 못 하는 엔진은 아무 일도 안 한다. */
  setMode(mode: string): void
  /** 모델을 도는 중에 바꾼다(#137). 못 하는 엔진은 아무 일도 안 한다. */
  setModel(model: string): void
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

/** result.modelUsage 의 contextWindow — 모델이 여럿이면 가장 큰 창. 없으면 사건을 안 낸다. */
function ctxWindow(mu: unknown): AiEngineEvent[] {
  if (!mu || typeof mu !== 'object') return []
  const ws = Object.values(mu as Record<string, unknown>)
    .map((v) => num((v as Record<string, unknown> | null)?.contextWindow))
    .filter((v): v is number => v !== null && v > 0)
  return ws.length > 0 ? [{ t: 'context', window: Math.max(...ws) }] : []
}

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
      // 맥락 사용량 — 하위 에이전트(parent_tool_use_id 있음)의 말은 그쪽 맥락이라 뺀다.
      const u = (m.message as { usage?: Record<string, unknown> } | undefined)?.usage
      if (u && !str(m.parent_tool_use_id)) {
        const used = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0)
        if (used > 0) out.push({ t: 'context', used })
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

    case 'result': {
      const u = (m.usage ?? null) as Record<string, unknown> | null
      const tokens = u
        ? {
            // 캐시 읽기(cache_read)는 뺀다 — 매 턴 대화 전체를 다시 읽어 숫자만 부풀린다.
            input: (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0),
            output: num(u.output_tokens) ?? 0
          }
        : null
      return [
        {
          t: 'turn',
          costUsd: num(m.total_cost_usd),
          ms: num(m.duration_ms) ?? 0,
          turns: num(m.num_turns) ?? 0,
          text: str(m.result) ?? '',
          ...(tokens ? { tokens } : {})
        },
        ...ctxWindow(m.modelUsage)
      ]
    }

    // 구독 한도(실측 2026-10-20, 2.1.300). unifiedWindows 가 없는 모양은 버린다 — 화면이 대체 표시로 간다.
    case 'rate_limit_event': {
      const w = ((m.rate_limit_info as Record<string, unknown> | undefined)?.unifiedWindows ?? null) as Record<
        string,
        Record<string, unknown> | undefined
      > | null
      if (!w || typeof w !== 'object') return []
      const lim = (x: Record<string, unknown> | undefined): AiLimit | null => {
        const u = num(x?.utilization)
        if (u === null) return null
        const r = num(x?.resetsAt)
        return { pct: Math.round(Math.min(1, Math.max(0, u)) * 100), resetsAt: r === null ? null : r * 1000 }
      }
      const five = lim(w.five_hour)
      const week = lim(w.seven_day)
      return five || week ? [{ t: 'limits', five, week }] : []
    }

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

/**
 * 권한 모드를 **도는 중에** 바꾼다(#136). 이것이 계획 승인 흐름의 유일한 실행 수단이다.
 *
 * 실측(2026-08-25): `set_permission_mode` 는 control 채널로 먹는다 —
 * `{"subtype":"success","response":{"mode":"acceptEdits"}}` 를 돌려주고 곧바로 `init` 이 새 모드로
 * 다시 온다. **재기동도 `--resume` 도 필요 없다.** 도구 차단 목록은 이렇게 못 바꾸지만
 * (프로세스에 붙박이다), 계획 승인에 필요한 것은 정확히 모드 쪽이다.
 *
 * 목표 모드는 `default` 가 아니라 **`acceptEdits`** 다. `default` 로 바꿔 봤더니
 * *"Claude requested permissions to write to …, but you haven't granted it yet"* 로 또 막혔다 —
 * 헤드리스에는 그 승인을 줄 창이 없다(§3.4b).
 */
export function permissionModeLine(requestId: string, mode: string): string {
  return (
    JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }) +
    '\n'
  )
}

/**
 * 모델을 **도는 중에** 바꾼다(#137). 실측(2026-08-25): `success` 를 주고 곧바로 `init` 이 새
 * 모델로 다시 온다 — 재기동도 `--resume` 도 필요 없다(권한 모드와 같은 성질이다).
 */
export function modelLine(requestId: string, model: string): string {
  return (
    JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_model', model } }) + '\n'
  )
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
  /** 쓸 모델(#137). 비어 있으면 붙이지 않는다 = 사용자의 `~/.claude` 기본값. */
  model?: string
  /**
   * 말투 파일(#138). Claude Code 기본 프롬프트를 **지우지 않고 얹는다**(`--append-…`).
   * 파일로 넘기는 이유는 araMcp.writePersona 주석 참고(사람이 친 글자를 argv 에 안 넣는다).
   */
  personaFile?: string
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
  if (o.model) a.push('--model', o.model)
  if (o.personaFile) a.push('--append-system-prompt-file', o.personaFile)
  return a
}
