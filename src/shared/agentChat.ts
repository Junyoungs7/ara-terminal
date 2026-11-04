// M5 AI-13 터미널 에이전트를 채팅으로 보기 — 순수 규칙(main 꼬리 읽기·렌더러 목록·단위 시험이 같이 읽는다).
// Orca(orcaRef fdfcfb3551) src/main/native-chat 의 핵심만:
//  · 줄 해석 = transcript-line-decoders-claude.ts decodeClaudeTranscriptLine + transcript-record-blocks.ts claudeContentBlocks·toolResultOutput
//    (하네스가 끼운 사용자 턴·isMeta 는 버리고 그 안의 tool_result 만 살린다, 끊김 문구는 조용한 시스템 줄)
//  · 꼬리 읽기의 줄 자르기 = transcript-tail-boundary.ts(덜 쓴 마지막 줄은 다음 읽기로 미룬다)
//  · 경로 = session-file-resolver.ts(훅이 준 transcript_path 가 우선, 없으면 세션 id 로 projects/*/<id>.jsonl)
//  · R2: Codex = transcript-line-decoders-codex.ts(response_item 만 — event_msg 의 같은 말은 겹치므로 버림), Gemini = Orca 에 채팅 디코더가
//    없어 ai-vault session-scanner-gemini-parsers.ts(type user/gemini) 모양에 toolCalls 를 도구 블록으로 더했다.
// 뺀 것: 편집 diff 블록·붙여넣은 글 펼치기·하위 에이전트 구역·되감기·Grok 해석·Codex 추론(reasoning) 줄. 그림·Claude thinking 은 넣었다.
import type { AgentId } from './agents'
import { INJECTED } from './vault'

/** 도구 줄 오른쪽 요약용 — 테스트 통과/전체. */
export type TestCount = { pass: number; total: number }

export type ChatBlock =
  | { type: 'text'; text: string }
  /** src = 안전한 data: URL(png·jpeg·gif·webp, 상한 이내)일 때만 — 없으면(외부 URL·SVG·너무 큼) 표시만. */
  | { type: 'image'; src?: string }
  /** 모델의 생각 — 접힌 "생각함" 한 줄(Orca NativeChatReasoningRow). */
  | { type: 'thinking'; text: string }
  /** 도구 호출 — 결과(tool_result)가 오면 같은 블록에 붙는다. 화면은 접어서 그린다. */
  | { type: 'tool'; id: string; name: string; summary: string; result?: string; error?: boolean; at?: number; ms?: number; add?: number; del?: number; tests?: TestCount }
  /** AskUserQuestion — 질문 카드 자리(답은 터미널에서). answered = 결과가 왔다. */
  | { type: 'question'; id: string; questions: string[]; answered: boolean }

export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; blocks: ChatBlock[] }

/** main → 렌더러: 바뀐(또는 새) 메시지들. reset 이면 앞의 것을 버리고 이것으로 시작(다른 파일·잘린 파일). */
export type AgentChatEvent = { sessionId: string; messages: ChatMessage[]; reset?: boolean }
export type AgentChatSnapshot = { messages: ChatMessage[]; file: string | null }
/** R4 orcad read 의 답 — next = 다음에 읽을 바이트 위치, reset = 파일이 줄어 꼬리부터 다시 읽었다. */
export type TranscriptSlice = { size: number; next: number; text: string; reset: boolean }


/** 메모리·IPC 상한 — 이보다 오래된 메시지는 버린다(긴 대화의 화면은 꼬리가 중요하다). */
export const CHAT_CAP = 2000
/** 도구 결과 글 상한(통째로 실으면 수 MB 출력이 화면·IPC 로 간다). */
const RESULT_CHARS = 4000
const SUMMARY_CHARS = 200
/** 그림 data: URL 상한(글자 수 ≈ 바이트) — 넘으면 표시만. */
export const IMAGE_MAX_CHARS = 8 * 1024 * 1024
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/
const BASE64 = /^[A-Za-z0-9+/\s]+={0,2}\s*$/
/** Claude 가 끊긴 턴에 끼우는 글(Orca transcript-turn-markers). */
const INTERRUPTED = /^\[Request interrupted by user/

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** 그림 블록 — 허용 형식·크기 안의 base64 만 data: URL 로(외부 URL 은 불러오지 않는다 — CSP·추적 방지). */
export function imageBlock(mime: unknown, data: unknown): ChatBlock {
  if (typeof mime === 'string' && IMAGE_MIME.test(mime) && typeof data === 'string' && data.length <= IMAGE_MAX_CHARS && BASE64.test(data)) return { type: 'image', src: `data:${mime};base64,${data.replace(/\s+/g, '')}` }
  return { type: 'image' }
}
/** Codex input_image.image_url 의 data: URL 만. */
function dataUrlImage(u: unknown): ChatBlock {
  const m = typeof u === 'string' ? /^data:([^;,]+);base64,/.exec(u) : null
  return m ? imageBlock(m[1], (u as string).slice(m[0].length)) : { type: 'image' }
}

/** 덜 쓴 마지막 줄은 carry 로 남긴다 — 다음 읽기에서 이어 붙인다. */
export function takeLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== ''), carry: rest }
}

export function toolResultText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (str(rec(x)?.text) ?? ''))).filter(Boolean).join('\n')
  return v == null ? '' : JSON.stringify(v)
}

/** 접힌 도구 줄에 보일 한 줄 — 명령·파일·패턴. 나머지는 입력 JSON 머리. */
export function toolSummary(name: string, input: unknown): string {
  const i = rec(input)
  const pick = str(i?.command) ?? str(i?.file_path) ?? str(i?.absolute_path) ?? str(i?.dir_path) ?? str(i?.path) ?? str(i?.notebook_path) ?? str(i?.pattern) ?? str(i?.url) ?? str(i?.query) ?? str(i?.description) ?? str(i?.prompt)
  const s = pick ?? (i ? JSON.stringify(i) : '')
  return clip(s.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS) || name
}

/**
 * 채팅 목록이 바닥에 붙어 있나 — 붙어 있을 때만 새 내용을 따라 내려간다(stick-to-bottom).
 * 바닥에서 px 안이면 붙어 있다. 내용이 칸보다 짧으면(스크롤 없음) 늘 붙어 있다.
 */
export function nearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, px = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < px
}

/** 소요 시간 글 — 1초 미만 0.3s · 60초 이상 1m 4s. 잘못된 값이면 null. */
export function fmtDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const lineCount = (s: unknown): number => (typeof s === 'string' && s ? s.split('\n').length : 0)

/**
 * Edit/Write/MultiEdit 입력의 줄 수 변화.
 * ponytail: 정확한 diff 가 아니라 old/new 문자열의 줄 수 차이(바뀐 줄이 같은 수면 +N −N). 진짜 diff 가 필요하면 줄 단위 LCS.
 */
export function editLines(name: string, input: unknown): { add: number; del: number } | null {
  const i = rec(input)
  if (!i) return null
  if (name === 'Write') return typeof i.content === 'string' ? { add: lineCount(i.content), del: 0 } : null
  const pairs = name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits.map(rec) : name === 'Edit' ? [i] : null
  if (!pairs) return null
  let add = 0
  let del = 0
  for (const e of pairs) {
    add += lineCount(e?.new_string)
    del += lineCount(e?.old_string)
  }
  return { add, del }
}

/**
 * Bash 결과 글에서 흔한 테스트 요약만 — vitest/jest `Tests  3 passed | 1 failed (4)`, pytest `3 passed, 1 failed`, playwright `3 passed`·`1 failed` 줄.
 * 못 찾으면 null. ponytail: 마지막 "N passed/failed" 묶음만 읽는다(skipped·flaky 는 전체에 안 넣음).
 */
export function parseTests(text: string): TestCount | null {
  const lines = text.split('\n')
  // 한 줄에 합계가 있는 형식(vitest/jest "Tests  3 passed | 1 failed (4)" · pytest "=== 3 passed, 1 failed in 1s ===") — 마지막 것.
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k]
    if (!/^\s*Tests\b|^[=\s]*\d+\s+(passed|failed)\b.*\bin\s+[\d.]+s/.test(l)) continue
    const pass = /(\d+)\s+passed\b/.exec(l)
    const fail = /(\d+)\s+failed\b/.exec(l)
    if (pass || fail) return { pass: pass ? +pass[1] : 0, total: (pass ? +pass[1] : 0) + (fail ? +fail[1] : 0) }
  }
  // playwright — "  3 passed (4s)" · "  1 failed" 가 줄마다 따로(들여쓴 줄). 마지막 실행 묶음의 합.
  let pass = 0
  let fail = 0
  for (const l of lines) {
    const m = /^\s+(\d+)\s+(passed|failed)\b/.exec(l)
    if (m) m[2] === 'passed' ? (pass = +m[1]) : (fail = +m[1])
  }
  return pass || fail ? { pass, total: pass + fail } : null
}

function questionsOf(input: unknown): string[] {
  const qs = rec(input)?.questions
  if (!Array.isArray(qs)) return []
  return qs.map((q) => str(rec(q)?.question) ?? '').filter(Boolean)
}

type Decoded = { id: string; groupId: string | null; role: ChatMessage['role']; blocks: ChatBlock[]; results: { id: string; text: string; error: boolean; ts?: number; tests?: TestCount }[] }
/** 줄 timestamp(ISO) → ms. */
const tsOf = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** jsonl 한 줄 → 메시지 조각 + 도구 결과. 대화 줄이 아니면 null. */
export function decodeClaudeLine(line: string, fallbackId: string): Decoded | null {
  let r: Rec | null = null
  try {
    r = rec(JSON.parse(line))
  } catch {
    return null
  }
  if (!r || (r.type !== 'user' && r.type !== 'assistant')) return null
  const msg = rec(r.message)
  const content = msg?.content
  const id = str(r.uuid) ?? fallbackId
  const injected = r.type === 'user' && (r.isMeta === true || r.isSynthetic === true || r.isCompactSummary === true)
  const blocks: ChatBlock[] = []
  const results: Decoded['results'] = []
  const items: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  for (const it of items) {
    const b = rec(it)
    if (!b) continue
    if (b.type === 'tool_result') {
      const tid = str(b.tool_use_id)
      if (tid) results.push({ id: tid, text: clip(toolResultText(b.content), RESULT_CHARS), error: b.is_error === true, ts: tsOf(r.timestamp), tests: parseTests(toolResultText(b.content)) ?? undefined })
      continue
    }
    if (injected) continue
    if (b.type === 'text') {
      const text = str(b.text)
      if (!text) continue
      if (r.type === 'user' && INTERRUPTED.test(text)) return { id, groupId: null, role: 'system', blocks: [{ type: 'text', text: text.trim() }], results }
      if (r.type === 'user' && INJECTED.test(text)) continue
      blocks.push({ type: 'text', text })
    } else if (b.type === 'image') {
      const src = rec(b.source)
      blocks.push(src?.type === 'base64' ? imageBlock(src.media_type, src.data) : { type: 'image' })
    } else if (b.type === 'thinking') {
      const text = str(b.thinking)
      if (text) blocks.push({ type: 'thinking', text: clip(text, RESULT_CHARS) })
    }
    else if (b.type === 'tool_use') {
      const tid = str(b.id) ?? `${id}:${blocks.length}`
      const name = str(b.name) ?? 'tool'
      if (name === 'AskUserQuestion') blocks.push({ type: 'question', id: tid, questions: questionsOf(b.input), answered: false })
      else {
        const ed = editLines(name, b.input)
        const at = tsOf(r.timestamp)
        blocks.push({ type: 'tool', id: tid, name, summary: toolSummary(name, b.input), ...(at !== undefined ? { at } : {}), ...(ed ? ed : {}) })
      }
    }
  }
  if (!blocks.length && !results.length) return null
  // 한 응답(message.id)은 블록마다 따로 기록된다 — 한 말풍선으로 묶는다.
  return { id, groupId: r.type === 'assistant' ? str(msg?.id) : null, role: r.type, blocks, results }
}

// ── Codex rollout(jsonl) ──
/** Codex 가 사용자 턴에 끼우는 맥락(환경·지시·스킬) — 사람이 친 글이 아니다. */
const CODEX_INJECTED = /^\s*(<(environment_context|user_instructions|user_shell_command|skill|turn_aborted)\b|# AGENTS\.md instructions)/i

/** Codex 도구 인자 — function_call.arguments 는 JSON 글, shell 의 command 는 배열. */
function codexInput(p: Rec): unknown {
  let v: unknown = p.arguments ?? p.input ?? p.action
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return { command: v }
    }
  }
  const r = rec(v)
  return r && Array.isArray(r.command) ? { ...r, command: r.command.filter((x) => typeof x === 'string').join(' ') } : v
}

/** function_call_output.output — 글이거나 {output|content} 를 담은 JSON 글. */
function codexOutput(v: unknown): string {
  if (typeof v === 'string') {
    try {
      const r = rec(JSON.parse(v))
      if (r) return toolResultText(r.output ?? r.content ?? v)
    } catch {
      /* 그냥 글 */
    }
    return v
  }
  const r = rec(v)
  return toolResultText(r ? (r.content ?? r.output ?? r) : v)
}

/** Codex rollout 한 줄(Orca decodeCodexTranscriptLine 의 response_item 갈래 + 끊김). */
export function decodeCodexLine(line: string, fallbackId: string): Decoded | null {
  let r: Rec | null = null
  try {
    r = rec(JSON.parse(line))
  } catch {
    return null
  }
  const p = rec(r?.payload)
  if (!r || !p) return null
  const id = str(p.id) ?? fallbackId
  if (r.type === 'event_msg') return p.type === 'turn_aborted' ? { id, groupId: null, role: 'system', blocks: [{ type: 'text', text: '[Request interrupted by user]' }], results: [] } : null
  if (r.type !== 'response_item') return null
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const items = Array.isArray(p.content) ? p.content : []
    const blocks: ChatBlock[] = []
    for (const it of items) {
      const b = rec(it)
      const text = str(b?.text)
      if (b?.type === 'input_image') blocks.push(dataUrlImage(b.image_url))
      else if (text && !(p.role === 'user' && CODEX_INJECTED.test(text))) blocks.push({ type: 'text', text })
    }
    return blocks.length ? { id, groupId: null, role: p.role, blocks, results: [] } : null
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
    const name = str(p.name) ?? (p.type === 'local_shell_call' ? 'shell' : 'tool')
    const input = codexInput(p)
    return { id, groupId: null, role: 'assistant', blocks: [{ type: 'tool', id: str(p.call_id) ?? id, name, summary: toolSummary(name, input) }], results: [] }
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const tid = str(p.call_id)
    const out = rec(p.output)
    return tid ? { id, groupId: null, role: 'user', blocks: [], results: [{ id: tid, text: clip(codexOutput(p.output), RESULT_CHARS), error: out?.success === false || p.is_error === true }] } : null
  }
  return null
}

// ── Gemini 세션(.json 통째 / .jsonl 줄) ──
function geminiText(v: unknown): string | null {
  if (typeof v === 'string') return str(v)
  if (Array.isArray(v)) return str(v.map((x) => (typeof x === 'string' ? x : (str(rec(x)?.text) ?? ''))).join(''))
  return null
}

/** Gemini 메시지 한 개(type user|gemini, content, toolCalls[{id,name,args,resultDisplay,status}]). 머리·$set 줄은 null. */
export function decodeGeminiLine(line: string, fallbackId: string): Decoded | null {
  let r: Rec | null = null
  try {
    r = rec(JSON.parse(line))
  } catch {
    return null
  }
  if (!r || (r.type !== 'user' && r.type !== 'gemini')) return null
  const id = str(r.id) ?? fallbackId
  const blocks: ChatBlock[] = []
  const text = geminiText(r.content)
  if (text && !(r.type === 'user' && INJECTED.test(text))) blocks.push({ type: 'text', text })
  for (const c of Array.isArray(r.toolCalls) ? r.toolCalls : []) {
    const t = rec(c)
    if (!t) continue
    const name = str(t.displayName) ?? str(t.name) ?? 'tool'
    const result = geminiText(t.resultDisplay) ?? (Array.isArray(t.result) ? toolResultText(t.result.map((x) => rec(rec(rec(x)?.functionResponse)?.response)?.output ?? '')) : '')
    blocks.push({ type: 'tool', id: str(t.id) ?? `${id}:${blocks.length}`, name, summary: toolSummary(name, t.args), ...(result || t.status ? { result: clip(result, RESULT_CHARS), error: t.status === 'error' } : {}) })
  }
  return blocks.length ? { id, groupId: null, role: r.type === 'user' ? 'user' : 'assistant', blocks, results: [] } : null
}

/** Gemini .json(통째로 다시 쓰는 옛 형식)을 줄로 — messages 를 한 줄씩. 깨졌으면 null(쓰는 중 — 다음 변경 때 다시). */
export function geminiDocLines(text: string): string[] | null {
  try {
    const m = rec(JSON.parse(text))?.messages
    return Array.isArray(m) ? m.map((x) => JSON.stringify(x)) : []
  } catch {
    return null
  }
}

export type LineDecoder = (line: string, fallbackId: string) => Decoded | null
export const DECODERS: Record<AgentId, LineDecoder> = { claude: decodeClaudeLine, codex: decodeCodexLine, gemini: decodeGeminiLine }

export type ChatModel = {
  /** 새 줄들 → 바뀐 메시지(새 것 포함, 순서대로). */
  add(lines: readonly string[]): ChatMessage[]
  messages(): ChatMessage[]
}

export function createChatModel(cap = CHAT_CAP, decode: LineDecoder = decodeClaudeLine): ChatModel {
  let list: ChatMessage[] = []
  const index = new Map<string, number>() // 메시지 id → list 자리
  const groups = new Map<string, string>() // 응답 message.id → 메시지 id
  const owner = new Map<string, string>() // 도구 id → 메시지 id
  const merged = new Set<string>() // 앞 말풍선에 묶인 줄 id(다시 읽어도 두 번 붙지 않게)
  let seq = 0

  const reindex = (): void => {
    index.clear()
    list.forEach((m, i) => index.set(m.id, i))
  }

  return {
    add(lines) {
      const changed = new Set<string>()
      for (const line of lines) {
        const d = decode(line, `line-${seq++}`)
        if (!d) continue
        for (const res of d.results) {
          const mid = owner.get(res.id)
          const at = mid === undefined ? undefined : index.get(mid)
          if (at === undefined) continue
          const m = list[at]
          list[at] = {
            ...m,
            blocks: m.blocks.map((b) =>
              b.type === 'tool' && b.id === res.id
                ? {
                    ...b,
                    result: res.text,
                    error: res.error,
                    ...(b.at !== undefined && res.ts !== undefined ? { ms: res.ts - b.at } : {}),
                    ...(b.name === 'Bash' && res.tests ? { tests: res.tests } : {})
                  }
                : b.type === 'question' && b.id === res.id ? { ...b, answered: true } : b
            )
          }
          changed.add(m.id)
        }
        // 같은 줄을 두 번 읽음(앞 메시지에 묶인 줄 포함) — 무시. 묶인 줄의 id 도 index 에 둔다.
        if (!d.blocks.length || index.has(d.id) || merged.has(d.id)) continue
        const into = d.groupId ? groups.get(d.groupId) : undefined
        const at = into === undefined ? undefined : index.get(into)
        let target: ChatMessage
        if (at !== undefined && at === list.length - 1) {
          target = { ...list[at], blocks: [...list[at].blocks, ...d.blocks] }
          list[at] = target
          merged.add(d.id)
        } else {
          target = { id: d.id, role: d.role, blocks: d.blocks }
          list.push(target)
          index.set(target.id, list.length - 1)
          if (d.groupId) groups.set(d.groupId, target.id)
        }
        for (const b of d.blocks) if (b.type === 'tool' || b.type === 'question') owner.set(b.id, target.id)
        changed.add(target.id)
      }
      if (list.length > cap) {
        const drop = list.slice(0, list.length - cap)
        list = list.slice(-cap)
        for (const m of drop) {
          changed.delete(m.id)
          for (const b of m.blocks) if (b.type === 'tool' || b.type === 'question') owner.delete(b.id)
        }
        reindex()
      }
      return list.filter((m) => changed.has(m.id))
    },
    messages: () => list
  }
}

/** 렌더러: 받은 메시지를 목록에 합친다(같은 id 는 그 자리에서 바꾸고 새 것은 뒤에). */
export function mergeMessages(list: readonly ChatMessage[], incoming: readonly ChatMessage[], reset = false, cap = CHAT_CAP): ChatMessage[] {
  const out = reset ? [] : [...list]
  const at = new Map(out.map((m, i) => [m.id, i]))
  for (const m of incoming) {
    const i = at.get(m.id)
    if (i === undefined) {
      at.set(m.id, out.length)
      out.push(m)
    } else out[i] = m
  }
  return out.length > cap ? out.slice(-cap) : out
}

// ── 세션 id → transcript 경로(Orca session-file-resolver 의 Claude 갈래) ──
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 훅 본문(transcript_path·session_id)에서 찾을 것. 경로가 .jsonl(Gemini 옛 형식은 .json)이면 그것이 정답이다(파일 이름이 세션 id 와 다를 수 있다). */
export function transcriptHint(payload: Record<string, unknown>): { path: string | null; sessionId: string | null } {
  const p = str(payload['transcript_path'])
  const id = str(payload['session_id'])
  return { path: p && /\.jsonl?$/i.test(p) ? p : null, sessionId: id && SAFE_ID.test(id) ? id : null }
}

/** 채팅 입력칸 → PTY 로 보낼 글. 첨부는 경로만(DLP — 파일 내용은 앱이 안 읽는다). 공백 든 경로는 큰따옴표로. */
export function composeChatText(text: string, files: readonly string[]): string {
  const paths = files.map((f) => (/\s/.test(f) ? `"${f}"` : f))
  return [text.replace(/\s+$/, ''), ...paths].filter(Boolean).join('\n')
}

/** 탭별 초안(보내지 않은 글 + 첨부 경로). 재시작 뒤에도 — 탭 id 는 데몬 세션 id 라 그대로 돌아온다. */
export type ChatDraft = { text: string; files: string[] }
export function draftOf(v: unknown): ChatDraft {
  const r = rec(v)
  return {
    text: typeof r?.text === 'string' ? r.text : '',
    files: Array.isArray(r?.files) ? r.files.filter((f): f is string => typeof f === 'string' && f !== '') : []
  }
}
