// M5 AI-13 터미널 에이전트를 채팅으로 보기 — 순수 규칙(main 꼬리 읽기·렌더러 목록·단위 시험이 같이 읽는다).
// Orca(orcaRef fdfcfb3551) src/main/native-chat 의 핵심만:
//  · 줄 해석 = transcript-line-decoders-claude.ts decodeClaudeTranscriptLine + transcript-record-blocks.ts claudeContentBlocks·toolResultOutput
//    (하네스가 끼운 사용자 턴·isMeta 는 버리고 그 안의 tool_result 만 살린다, 끊김 문구는 조용한 시스템 줄)
//  · 꼬리 읽기의 줄 자르기 = transcript-tail-boundary.ts(덜 쓴 마지막 줄은 다음 읽기로 미룬다)
//  · 경로 = session-file-resolver.ts(훅이 준 transcript_path 가 우선, 없으면 세션 id 로 projects/*/<id>.jsonl)
// 뺀 것: 편집 diff 블록·이미지 미리보기·붙여넣은 글 펼치기·하위 에이전트 구역·되감기·Codex/Gemini/Grok 해석(라운드 뒤).
import type { AgentId } from './agents'
import { INJECTED } from './vault'

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'image' }
  /** 도구 호출 — 결과(tool_result)가 오면 같은 블록에 붙는다. 화면은 접어서 그린다. */
  | { type: 'tool'; id: string; name: string; summary: string; result?: string; error?: boolean }
  /** AskUserQuestion — 질문 카드 자리(답은 터미널에서). answered = 결과가 왔다. */
  | { type: 'question'; id: string; questions: string[]; answered: boolean }

export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; blocks: ChatBlock[] }

/** main → 렌더러: 바뀐(또는 새) 메시지들. reset 이면 앞의 것을 버리고 이것으로 시작(다른 파일·잘린 파일). */
export type AgentChatEvent = { sessionId: string; messages: ChatMessage[]; reset?: boolean }
export type AgentChatSnapshot = { messages: ChatMessage[]; file: string | null }

/** AI-14 기본값 자리 — 에이전트별 "채팅 | 터미널". Claude 는 원격 제어 때문에 PTY 대화형 + 채팅으로 보기(계획 M5).
 *  'terminal-chat' = 터미널로 열고 [채팅] 으로 같은 세션을 본다. 구조화 채팅('chat')은 아직 없다. 설정은 라운드 2. */
export type AgentOpenMode = 'terminal' | 'terminal-chat'
export const AGENT_OPEN_MODE: Record<AgentId, AgentOpenMode> = { claude: 'terminal-chat', codex: 'terminal', gemini: 'terminal' }
export const canChat = (agent: AgentId): boolean => AGENT_OPEN_MODE[agent] === 'terminal-chat'

/** 메모리·IPC 상한 — 이보다 오래된 메시지는 버린다(긴 대화의 화면은 꼬리가 중요하다). */
export const CHAT_CAP = 2000
/** 도구 결과 글 상한(통째로 실으면 수 MB 출력이 화면·IPC 로 간다). */
const RESULT_CHARS = 4000
const SUMMARY_CHARS = 200
/** Claude 가 끊긴 턴에 끼우는 글(Orca transcript-turn-markers). */
const INTERRUPTED = /^\[Request interrupted by user/

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

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
  const pick = str(i?.command) ?? str(i?.file_path) ?? str(i?.notebook_path) ?? str(i?.pattern) ?? str(i?.url) ?? str(i?.query) ?? str(i?.description) ?? str(i?.prompt)
  const s = pick ?? (i ? JSON.stringify(i) : '')
  return clip(s.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS) || name
}

function questionsOf(input: unknown): string[] {
  const qs = rec(input)?.questions
  if (!Array.isArray(qs)) return []
  return qs.map((q) => str(rec(q)?.question) ?? '').filter(Boolean)
}

type Decoded = { id: string; groupId: string | null; role: ChatMessage['role']; blocks: ChatBlock[]; results: { id: string; text: string; error: boolean }[] }

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
      if (tid) results.push({ id: tid, text: clip(toolResultText(b.content), RESULT_CHARS), error: b.is_error === true })
      continue
    }
    if (injected) continue
    if (b.type === 'text') {
      const text = str(b.text)
      if (!text) continue
      if (r.type === 'user' && INTERRUPTED.test(text)) return { id, groupId: null, role: 'system', blocks: [{ type: 'text', text: text.trim() }], results }
      if (r.type === 'user' && INJECTED.test(text)) continue
      blocks.push({ type: 'text', text })
    } else if (b.type === 'image') blocks.push({ type: 'image' })
    else if (b.type === 'tool_use') {
      const tid = str(b.id) ?? `${id}:${blocks.length}`
      const name = str(b.name) ?? 'tool'
      if (name === 'AskUserQuestion') blocks.push({ type: 'question', id: tid, questions: questionsOf(b.input), answered: false })
      else blocks.push({ type: 'tool', id: tid, name, summary: toolSummary(name, b.input) })
    }
    // thinking 은 뺀다(1차 — Orca 는 접힌 추론 줄).
  }
  if (!blocks.length && !results.length) return null
  // 한 응답(message.id)은 블록마다 따로 기록된다 — 한 말풍선으로 묶는다.
  return { id, groupId: r.type === 'assistant' ? str(msg?.id) : null, role: r.type, blocks, results }
}

export type ChatModel = {
  /** 새 줄들 → 바뀐 메시지(새 것 포함, 순서대로). */
  add(lines: readonly string[]): ChatMessage[]
  messages(): ChatMessage[]
}

export function createChatModel(cap = CHAT_CAP): ChatModel {
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
        const d = decodeClaudeLine(line, `line-${seq++}`)
        if (!d) continue
        for (const res of d.results) {
          const mid = owner.get(res.id)
          const at = mid === undefined ? undefined : index.get(mid)
          if (at === undefined) continue
          const m = list[at]
          list[at] = {
            ...m,
            blocks: m.blocks.map((b) =>
              b.type === 'tool' && b.id === res.id ? { ...b, result: res.text, error: res.error } : b.type === 'question' && b.id === res.id ? { ...b, answered: true } : b
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

/** 훅 본문(transcript_path·session_id)에서 찾을 것. 경로가 .jsonl 이면 그것이 정답이다(파일 이름이 세션 id 와 다를 수 있다). */
export function transcriptHint(payload: Record<string, unknown>): { path: string | null; sessionId: string | null } {
  const p = str(payload['transcript_path'])
  const id = str(payload['session_id'])
  return { path: p && p.toLowerCase().endsWith('.jsonl') ? p : null, sessionId: id && SAFE_ID.test(id) ? id : null }
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
