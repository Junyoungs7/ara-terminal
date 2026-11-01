// M12 R3 RV-03 — AI 작성 줄 표시(Attribution). 순수 규칙(main 원장·시험이 같이 읽는다).
// Orca @fdfcfb3551 은 이 기능을 문서(docs/site/content/docs/review/attribution.mdx)로만 정했다 — 코드는 없다. 그 판정을 그대로 옮긴다:
//  · 에이전트가 **자기 도구로** 파일을 쓰면 그 줄 범위를 적는다(훅 PostToolUse·AfterTool 의 Edit/Write/MultiEdit · write_file/replace).
//  · 보기(에디터 거터·diff)가 그 줄에 표시를 그린다. · 사람이 그 위를 고치면 그 줄은 사람 것으로 돌아간다.
//  · 아라 안에만(git 에 안 들어간다).
// 판정 방식: 파일마다 "마지막으로 본 글(줄 배열) + 줄마다 AI 여부"를 쥐고, 새 글이 오면 줄을 맞춰(carryMask) 표시를 옮긴다.
// 맞춰지지 않은 줄(새로 생기거나 바뀐 줄)은 사람 것 — 단, 에이전트가 방금 쓴 줄(writtenLines)은 AI.
// ponytail: 줄 맞추기는 앞뒤 같은 줄을 걷고 가운데를 내용 해시로 순서대로 잇는 O(n) 근사(LCS 아님). 같은 내용 줄이 여럿이면 앞에서부터 —
// 틀려도 표시가 한두 줄 밀리는 정도. 정확도가 문제면 가운데만 Myers diff 로.

export type AiMask = { lines: string[]; mask: boolean[] }
/** 에이전트가 쓴 줄 — 'all'(파일 통째) 또는 새 글 기준 1부터 센 줄 번호들, 또는 새 글 안에서 찾을 조각들. */
export type AiWritten = { kind: 'all' } | { kind: 'lines'; lines: number[] } | { kind: 'snippets'; snippets: string[] }
export type AiWrite = { path: string; written: AiWritten }

/** 원장이 쥐는 파일 하나의 상한(이보다 크면 표시 안 함 — 큰 생성 파일). */
export const AI_LINES_MAX_BYTES = 4 * 1024 * 1024
/** 원장이 쥐는 파일 수(넘으면 오래된 것부터 버린다). */
export const AI_LINES_MAX_FILES = 500

export const splitLines = (text: string): string[] => text.split(/\r?\n/)

const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const GEMINI_WRITE_TOOLS = new Set(['write_file', 'replace'])

const str = (o: unknown, k: string): string | undefined => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' ? v : undefined
}

/** structuredPatch(Claude Edit/Write 의 tool_response) 의 '+' 줄 → 새 글 기준 줄 번호. */
export function addedLinesOfPatch(patch: unknown): number[] | null {
  if (!Array.isArray(patch)) return null
  const out: number[] = []
  for (const h of patch) {
    const start = (h as { newStart?: unknown })?.newStart
    const lines = (h as { lines?: unknown })?.lines
    if (typeof start !== 'number' || !Array.isArray(lines)) return null
    let n = start
    for (const l of lines) {
      if (typeof l !== 'string') continue
      if (l.startsWith('+')) out.push(n++)
      else if (l.startsWith(' ')) n++
      // '-' 는 새 글에 없다 · '\' 는 "끝 줄바꿈 없음" 표시
    }
  }
  return out
}

/** 훅 본문 → 에이전트가 쓴 파일·줄. 쓰기 도구의 끝(PostToolUse·AfterTool)이 아니면 null. */
export function aiWriteOf(payload: Record<string, unknown>): AiWrite | null {
  const event = str(payload, 'hook_event_name')
  const tool = str(payload, 'tool_name') ?? ''
  const claude = event === 'PostToolUse' && CLAUDE_WRITE_TOOLS.has(tool)
  const gemini = event === 'AfterTool' && GEMINI_WRITE_TOOLS.has(tool)
  if (!claude && !gemini) return null
  const input = payload['tool_input']
  const path = str(input, 'file_path') ?? str(input, 'absolute_path') ?? str(input, 'path')
  if (!path) return null
  const res = payload['tool_response']
  const patched = addedLinesOfPatch(res && typeof res === 'object' ? (res as Record<string, unknown>)['structuredPatch'] : undefined)
  // 새 파일 Write 는 structuredPatch 가 빈 배열 — 통째로.
  if (patched && patched.length) return { path, written: { kind: 'lines', lines: patched } }
  if (tool === 'Write' || tool === 'write_file') return { path, written: { kind: 'all' } }
  const snippets: string[] = []
  const ns = str(input, 'new_string')
  if (ns) snippets.push(ns)
  const edits = input && typeof input === 'object' ? (input as Record<string, unknown>)['edits'] : undefined
  if (Array.isArray(edits)) for (const e of edits) if (str(e, 'new_string')) snippets.push(str(e, 'new_string')!)
  return snippets.length ? { path, written: { kind: 'snippets', snippets } } : null
}

/** 조각들이 새 글에서 차지하는 줄(1부터). 못 찾은 조각은 건너뛴다. */
export function linesOfSnippets(text: string, snippets: readonly string[]): number[] {
  const out: number[] = []
  for (const s of snippets) {
    const at = text.indexOf(s)
    if (at < 0 || !s.trim()) continue
    const first = countNewlines(text, 0, at) + 1
    const n = countNewlines(s, 0, s.length) + (s.endsWith('\n') ? 0 : 1)
    for (let i = 0; i < n; i++) out.push(first + i)
  }
  return out
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0
  for (let i = s.indexOf('\n', from); i !== -1 && i < to; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** 옛 글의 표시를 새 글로 옮긴다. 같은 내용으로 맞춰진 줄만 표시를 잇고, 나머지(새로 생기거나 바뀐 줄)는 false. */
export function carryMask(prev: AiMask, next: readonly string[]): boolean[] {
  const a = prev.lines
  const out = new Array<boolean>(next.length).fill(false)
  let p = 0
  while (p < a.length && p < next.length && a[p] === next[p]) {
    out[p] = !!prev.mask[p]
    p++
  }
  let s = 0
  while (s < a.length - p && s < next.length - p && a[a.length - 1 - s] === next[next.length - 1 - s]) {
    out[next.length - 1 - s] = !!prev.mask[a.length - 1 - s]
    s++
  }
  // 가운데: 표시가 있는 옛 줄만 내용별 줄 번호 줄을 세우고, 새 줄을 순서대로 앞에서부터 잇는다(되돌아가지 않는다).
  const queues = new Map<string, { at: number[]; i: number }>()
  for (let i = p; i < a.length - s; i++) {
    if (!prev.mask[i]) continue
    const q = queues.get(a[i])
    if (q) q.at.push(i)
    else queues.set(a[i], { at: [i], i: 0 })
  }
  if (queues.size === 0) return out
  let last = -1
  for (let j = p; j < next.length - s; j++) {
    const q = queues.get(next[j])
    if (!q) continue
    while (q.i < q.at.length && q.at[q.i] <= last) q.i++
    if (q.i >= q.at.length) continue
    last = q.at[q.i++]
    out[j] = true
  }
  return out
}

/** 에이전트가 쓴 뒤의 새 표시 — 옛 표시를 옮기고(사람이 그 사이 고친 줄은 사람 것) 방금 쓴 줄을 AI 로. */
export function applyWrite(prev: AiMask | null, text: string, written: AiWritten): AiMask {
  const lines = splitLines(text)
  if (written.kind === 'all') return { lines, mask: lines.map(() => true) }
  const mask = prev ? carryMask(prev, lines) : lines.map(() => false)
  const nums = written.kind === 'lines' ? written.lines : linesOfSnippets(text, written.snippets)
  for (const n of nums) if (n >= 1 && n <= lines.length) mask[n - 1] = true
  return { lines, mask }
}

/** 표시 → 이어진 줄 범위([처음, 끝], 1부터). 장식 수를 줄인다. */
export function rangesOf(mask: readonly boolean[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const start = i
    while (i + 1 < mask.length && mask[i + 1]) i++
    out.push([start + 1, i + 1])
  }
  return out
}
