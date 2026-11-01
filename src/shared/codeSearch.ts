// M6 R2 — WS-06 빠른 열기(Ctrl+P) · WS-09 워크트리 전체 검색의 순수 규칙. main(rg 실행)·렌더러(순위·결과)·단위 시험이 같이 읽는다.
// Orca(orcaRef fdfcfb3551) src/shared/quick-open-path-search.ts · quick-open-filter.ts · text-search.ts ·
// text-search-match-accumulator.ts · renderer quick-open-history-ranking.ts 의 1차 판.

// ── 빠른 열기 ────────────────────────────────────────────────────────────────

/** 목록에 보이는 수 — Orca QUICK_OPEN_RESULT_LIMIT. */
export const QUICK_OPEN_RESULT_LIMIT = 50
/** 파일 목록 상한 — Orca QUICK_OPEN_LISTING_MAX_RESULTS(20_001 = 2만 + 넘었는지 보는 한 개). */
export const QUICK_OPEN_LISTING_MAX = 20_000
/** 최근 연 파일 기억 수 — Orca QUICK_OPEN_RECENT_CANDIDATE_LIMIT. */
export const QUICK_OPEN_RECENT_LIMIT = 100

/** rg 가 .gitignore 를 무시하지 않아도 들어오는 도구 생성 폴더(숨김 폴더 포함 목록에서 뺀다) — Orca HIDDEN_DIR_BLOCKLIST + node_modules. */
const LIST_PRUNE = ['node_modules', '.git', '.next', '.nuxt', '.cache', '.stably', '.vscode', '.idea', '.yarn', '.pnpm-store', '.terraform', '.docker', '.husky', '.npm', '.npm-global', '.gvfs']

/** `rg --files` 인자(cwd = 워크트리, 대상 '.'). .gitignore 는 존중하고 숨김 파일은 넣는다(Orca primary 패스). */
export function buildListArgs(win: boolean): string[] {
  return ['--files', '--no-config', '--null', '--hidden', ...(win ? ['--path-separator', '/'] : []), ...LIST_PRUNE.flatMap((n) => ['--glob', `!**/${n}`]), '.']
}

/** rg 가 낸 경로('./a/b' · 'a\\b') → 워크트리 기준 'a/b'. 루트 밖·빈 줄은 null. */
export function normalizeRgPath(raw: string): string | null {
  let p = raw.replace(/\\/g, '/')
  if (p.startsWith('./')) p = p.slice(2)
  if (!p || p === '.' || p.startsWith('/') || p === '..' || p.startsWith('../')) return null
  return p
}

/**
 * 한 단어의 퍼지 점수(작을수록 좋다, 안 맞으면 null) — Orca fuzzyMatchIndexedFile 그대로(구분자 -·_ 대체 갈래는 뺐다).
 * 글자를 앞에서부터 욕심껏 잇되 · 사이 간격만큼 + · '/' '.' '-' 바로 뒤에서 맞으면 −5 · 파일 이름에 단어가 통째로 있으면 −100.
 */
function fuzzy(term: string, lowerPath: string, lowerName: string): number | null {
  let score = 0
  let last = -1
  for (let qi = 0; qi < term.length; qi++) {
    const next = last + 1
    const ti = lowerPath[next] === term[qi] ? next : lowerPath.indexOf(term[qi], next + 1)
    if (ti === -1) return null
    if (last !== -1) score += ti - last - 1
    const prev = lowerPath[ti - 1]
    if (ti > 0 && (prev === '/' || prev === '.' || prev === '-')) score -= 5
    last = ti
  }
  if (lowerName.includes(term)) score -= 100
  return score
}

/** 검색어(공백으로 나눈 단어들, \\ = /)의 점수 — 단어마다 맞아야 하고 점수는 더한다. 안 맞으면 null. */
export function scoreQuickOpen(query: string, path: string): number | null {
  const terms = [...new Set(query.trim().replace(/\\/g, '/').toLowerCase().split(/\s+/))].filter(Boolean)
  const lowerPath = path.replace(/\\/g, '/').toLowerCase()
  const lowerName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  let score = 0
  for (const term of terms) {
    const s = fuzzy(term, lowerPath, lowerName)
    if (s === null) return null
    score += s
  }
  return score
}

function rank(query: string, files: readonly string[]): string[] {
  const hits: { path: string; score: number }[] = []
  for (const path of files) {
    const score = scoreQuickOpen(query, path)
    if (score !== null) hits.push({ path, score })
  }
  // 같은 점수는 경로 순(Orca compareFileNames 자리 — 이름 정렬 규칙은 단순 비교로).
  hits.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return hits.map((h) => h.path)
}

/**
 * 빠른 열기 순위 — Orca rankQuickOpenFilesWithHistory: **최근 연 파일 중 맞는 것을 최근 순서대로 먼저**, 그다음 나머지를 점수 순.
 * recent = 최근 것이 앞, 목록(files)에 없는 것은 뺀다(지워졌거나 무시된 파일). 결과는 상한(50)까지.
 */
export function rankQuickOpen(query: string, files: readonly string[], recent: readonly string[]): string[] {
  const have = new Set(files)
  const recentHits = recent.filter((p) => have.has(p) && scoreQuickOpen(query, p) !== null)
  const seen = new Set(recentHits)
  const rest: string[] = []
  for (const p of rank(query, files)) {
    if (recentHits.length + rest.length >= QUICK_OPEN_RESULT_LIMIT) break
    if (!seen.has(p)) rest.push(p)
  }
  return [...recentHits, ...rest].slice(0, QUICK_OPEN_RESULT_LIMIT)
}

// ── 전체 검색 ────────────────────────────────────────────────────────────────

/** 맞은 수 상한 — Orca DEFAULT_SEARCH_MAX_RESULTS. 넘으면 rg 를 멈추고 truncated. */
export const SEARCH_MAX_RESULTS = 2000
/** 시간 상한 — Orca SEARCH_TIMEOUT_MS. 넘으면 그때까지의 결과 + truncated. */
export const SEARCH_TIMEOUT_MS = 15_000
/** 검색할 파일 크기 상한 — Orca SEARCH_MAX_FILE_SIZE(5MB, 편집기 상한보다 작게). */
const SEARCH_MAX_FILE_MB = 5
/** 미리보기 한 줄 길이 상한 — Orca MAX_LINE_CONTENT_LENGTH. */
export const SEARCH_LINE_MAX = 500

export type SearchOptions = {
  query: string
  regex: boolean
  caseSensitive: boolean
  /** 쉼표로 나눈 글롭(예: `src/**, *.ts`). */
  include: string
  exclude: string
}

/** 한 줄의 맞음. text = 미리보기(500자 창), ranges = 그 안에서 맞은 자리(UTF-16, [시작, 끝)). */
export type SearchMatch = { line: number; text: string; ranges: [number, number][] }
/** 파일 하나의 맞음 묶음. path = 워크트리 기준 '/' 경로. */
export type SearchFile = { path: string; matches: SearchMatch[] }

/** 쉼표로 나눈 글롭 — Orca splitSearchGlobPatterns(rg 갈래)의 단순판: 빈 칸 거름. */
export function splitGlobs(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** rg --json 인자(cwd = 워크트리, 대상 '.') — Orca buildRgArgs. 검색어는 `--` 뒤라 옵션으로 읽히지 않는다. */
export function buildSearchArgs(o: SearchOptions, win: boolean): string[] {
  const args = ['--no-config', '--json', '--hidden', '--glob', '!.git', '--max-filesize', `${SEARCH_MAX_FILE_MB}M`]
  if (win) args.push('--path-separator', '/')
  if (!o.caseSensitive) args.push('--ignore-case')
  if (!o.regex) args.push('--fixed-strings')
  for (const g of splitGlobs(o.include)) args.push('--glob', g)
  for (const g of splitGlobs(o.exclude)) args.push('--glob', `!${g}`)
  args.push('--', o.query, '.')
  return args
}

export type SearchAcc = { files: Map<string, SearchFile>; total: number; truncated: boolean }
export const newSearchAcc = (): SearchAcc => ({ files: new Map(), total: 0, truncated: false })

const enc = new TextEncoder()
const dec = new TextDecoder()
/** rg 의 submatch 자리는 UTF-8 **바이트**다 — 글자(UTF-16) 자리로. ASCII 줄은 같으니 그대로. */
function charAt(bytes: Uint8Array | null, byte: number): number {
  return bytes ? dec.decode(bytes.subarray(0, byte)).length : byte
}

/** 바이트로 온 줄(rg 가 UTF-8 이 아닌 줄을 base64 로 준다) — 깨진 글자는 대체 문자로. */
function lineText(lines: { text?: string; bytes?: string } | undefined): string | null {
  if (typeof lines?.text === 'string') return lines.text
  if (typeof lines?.bytes === 'string') return dec.decode(Uint8Array.from(atob(lines.bytes), (c) => c.charCodeAt(0)))
  return null
}

/**
 * rg --json 한 줄을 모은다 — Orca ingestRgJsonLine. match 만 쓰고 begin·end·summary 는 넘긴다.
 * 상한에 닿으면 truncated 를 켜고 'stop'(부르는 쪽이 rg 를 끊는다). 경로가 바이트로 온 파일은 열 수 없어 빼고 truncated.
 * 줄이 500자보다 길면 첫 맞음을 가운데 두고 자른다(앞뒤 '…').
 */
export function ingestRgJsonLine(line: string, acc: SearchAcc, max = SEARCH_MAX_RESULTS): 'continue' | 'stop' {
  if (acc.total >= max) return 'stop'
  if (!line) return 'continue'
  let msg: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string; bytes?: string }; line_number?: number; submatches?: { start: number; end: number }[] } }
  try {
    msg = JSON.parse(line)
  } catch {
    acc.truncated = true
    return 'continue'
  }
  if (msg.type !== 'match' || !msg.data) return 'continue'
  const d = msg.data
  const path = typeof d.path?.text === 'string' ? normalizeRgPath(d.path.text) : null
  const raw = lineText(d.lines)
  if (path === null || raw === null) {
    acc.truncated = true
    return 'continue'
  }
  const text = raw.replace(/\r?\n$/, '')
  const bytes = /[^\x00-\x7f]/.test(text) ? enc.encode(text) : null
  let ranges = (d.submatches ?? []).map((s): [number, number] => [charAt(bytes, s.start), charAt(bytes, s.end)])
  if (ranges.length === 0) ranges = [[0, 0]]
  let shown = text
  if (text.length > SEARCH_LINE_MAX) {
    const from = Math.max(0, Math.min(ranges[0][0] - Math.floor(SEARCH_LINE_MAX / 4), text.length - SEARCH_LINE_MAX))
    const to = from + SEARCH_LINE_MAX
    const head = from > 0 ? '…' : ''
    shown = head + text.slice(from, to) + (to < text.length ? '…' : '')
    ranges = ranges
      .map(([s, e]): [number, number] => [Math.max(s, from) - from + head.length, Math.min(e, to) - from + head.length])
      .filter(([s, e]) => e > s)
  }
  let f = acc.files.get(path)
  if (!f) acc.files.set(path, (f = { path, matches: [] }))
  f.matches.push({ line: d.line_number ?? 0, text: shown, ranges })
  acc.total += Math.max(1, d.submatches?.length ?? 0)
  if (acc.total >= max) {
    acc.truncated = true
    return 'stop'
  }
  return 'continue'
}
