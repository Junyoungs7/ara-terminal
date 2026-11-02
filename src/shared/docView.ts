// 3차 R1-B 코드 보기 3차 — 글 파일의 "다른 보기"(마크다운 리치/미리 보기 · CSV/TSV 표 · Mermaid 다이어그램 · HTML 미리 보기) 순수 규칙.
// 렌더러 탭·main 미리 보기 프로토콜·단위 시험이 같이 읽는다.
// 출처: stablyai/orca @ec112c6b01 (MIT) src/renderer/src/components/editor/markdown-render-mode.ts·markdown-rich-mode.ts(판정 규칙)·
// markdown-rich-size-limit.ts·csv/csv-parse.ts·csv/csv-delimiter-detection.ts(그대로)·lib/markdown-review-notes.ts(주석 형식),
// shared/constants.ts RICH_MARKDOWN_MAX_SIZE_BYTES, components/tab-bar/tab-create-entry-forced-search.ts·url-classification(새 탭 옴니박스).

/** 글 파일이지만 다른 보기가 있는 종류. 없으면 null(그냥 Monaco). */
export type DocKind = 'markdown' | 'csv' | 'mermaid' | 'html'
/** source = Monaco 원문. rich = Tiptap 리치 편집. preview = 그린 글(마크다운)·샌드박스 문서(HTML). table = CSV 표. diagram = .mmd 그림. */
export type DocView = 'source' | 'rich' | 'preview' | 'table' | 'diagram'

const KIND: Record<string, DocKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  csv: 'csv',
  tsv: 'csv',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  html: 'html',
  htm: 'html'
}

export function docKindOf(path: string): DocKind | null {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (KIND[name.slice(dot + 1).toLowerCase()] ?? null) : null
}

/** 보기 단추 순서(첫 것 = 처음 열 때). Orca: 마크다운 = 리치 기본, CSV = 표, .mmd = 그림, HTML = 에디터(미리 보기는 따로 여는 것). */
export const DOC_VIEWS: Record<DocKind, DocView[]> = {
  markdown: ['rich', 'source', 'preview'],
  csv: ['table', 'source'],
  mermaid: ['diagram', 'source'],
  html: ['source', 'preview']
}
export const defaultDocView = (kind: DocKind): DocView => DOC_VIEWS[kind][0]

// ── 마크다운 리치 모드 판정(Orca) ──────────────────────────────────────────────

/** Orca RICH_MARKDOWN_MAX_SIZE_BYTES — 넘으면 원문(Monaco)으로 연다. [그래도 열기]는 1MB 까지. */
export const RICH_MARKDOWN_MAX_SIZE_BYTES = 600 * 1024
export const MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES = 1024 * 1024

export function exceedsUtf8ByteLimit(content: string, limit: number): boolean {
  if (content.length > limit) return true
  if (content.length * 3 <= limit) return false
  return new TextEncoder().encode(content).length > limit
}

export type MarkdownUnsupported = 'html-or-jsx' | 'reference-links' | 'footnotes'

/** 코드 블록·인라인 코드를 뺀 본문(Orca stripMarkdownCode) — 그 안의 <태그>·[ref]: 는 판정에 넣지 않는다. */
export function stripMarkdownCode(content: string): string {
  let out = ''
  let fence: '`' | '~' | null = null
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (m) {
      const marker = m[1][0] as '`' | '~'
      fence = fence === marker ? null : (fence ?? marker)
    } else if (!fence) out += line.replace(/`+[^`\n]*`+/g, '')
    out += '\n'
  }
  return out
}

/**
 * 리치 편집이 안전하게 못 지키는 문법(Orca markdown-rich-mode). Orca 는 HTML 이 있으면 왕복 변환으로 보존을 증명해 보고 되면 리치로 둔다.
 * ponytail: 아라는 그 증명을 빼고 HTML·JSX 가 보이면 늘 미리 보기로(보수적 — 원문을 조용히 망가뜨리지 않는다). 리치 편집이 필요해지면 왕복 증명을 옮긴다.
 */
export function markdownRichUnsupported(content: string): MarkdownUnsupported | null {
  const body = stripMarkdownCode(splitFrontMatter(content).body)
  if (/^\[\^[^\]]+\]:\s+/m.test(body)) return 'footnotes'
  if (/^\[[^\]]+\]:\s+\S+/m.test(body)) return 'reference-links'
  if (/<!--[\s\S]*?-->/.test(body) || /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/.test(body)) return 'html-or-jsx'
  return null
}

/** Orca getMarkdownRenderMode 그대로 — 원문을 고르면 원문, 미리 보기를 고르면 미리 보기, 크면 원문, 못 지키는 문법이면 미리 보기. */
export function markdownRenderMode(o: { view: DocView; tooBig: boolean; unsupported: boolean }): 'source' | 'rich' | 'preview' {
  if (o.view === 'source') return 'source'
  if (o.view === 'preview') return 'preview'
  if (o.tooBig) return 'source'
  return o.unsupported ? 'preview' : 'rich'
}

/** YAML(---)·TOML(+++) 머리말 — Orca 는 리치 편집에서 따로 읽기 전용으로 보이고 본문만 편집한다. */
export function splitFrontMatter(content: string): { front: string; body: string } {
  const m = content.match(/^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/)
  return m ? { front: m[0], body: content.slice(m[0].length) } : { front: '', body: content }
}

// ── CSV/TSV (Orca csv-parse·csv-delimiter-detection) ────────────────────────────

/** 표 보기 상한(Orca CSV_PAGED_PREVIEW_BYTES 를 넘는 파일은 쪽 나눔 — 아라는 그 위로는 원문만). */
export const CSV_TABLE_MAX_BYTES = 1024 * 1024
/** 한 번에 그리는 줄 수. ponytail: 가상 스크롤 없음 — 큰 표를 자주 보면 Orca CsvGrid 처럼 가상 스크롤로. */
export const CSV_RENDER_ROWS = 2000

export function detectCsvDelimiter(path: string, content: string): string {
  if (path.toLowerCase().endsWith('.tsv')) return '\t'
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const count = (d: string): number => {
    let n = 0
    let q = false
    for (const ch of first) {
      if (ch === '"') q = !q
      else if (!q && ch === d) n++
    }
    return n
  }
  const tabs = count('\t')
  const commas = count(',')
  const semis = count(';')
  const existing = tabs > commas ? '\t' : ','
  // ponytail: Orca 는 세미콜론이 이길 때 앞 8줄의 열 수가 고른지 한 번 더 본다 — 아라는 첫 줄만.
  return semis > commas && semis > tabs ? ';' : existing
}

/** Orca parseCsv(따옴표·"" 이스케이프·CRLF) — 한도 옵션은 뺐다(상한은 CSV_TABLE_MAX_BYTES 로 앞에서 끊는다). */
export function parseCsv(source: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let hasContent = false
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      hasContent = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
      hasContent = true
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      hasContent = false
    } else {
      field += ch
      hasContent = true
    }
  }
  if (hasContent || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export type CsvSort = { col: number; dir: 'asc' | 'desc' } | null

/** 머리 줄을 뺀 몸통 — 검색(대소문자 무시, 어느 칸이든)·정렬(숫자는 숫자로, 아니면 자연 순). 원래 줄 번호를 함께 돌려준다. */
export function csvBodyView(rows: string[][], query: string, sort: CsvSort): { row: string[]; index: number }[] {
  const q = query.trim().toLowerCase()
  const body = rows.slice(1).map((row, i) => ({ row, index: i + 1 }))
  const hit = q ? body.filter((r) => r.row.some((c) => c.toLowerCase().includes(q))) : body
  if (!sort) return hit
  const num = (s: string): number | null => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : null)
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...hit].sort((a, b) => {
    const x = a.row[sort.col] ?? ''
    const y = b.row[sort.col] ?? ''
    const nx = num(x)
    const ny = num(y)
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' })
    return c === 0 ? a.index - b.index : c * sign
  })
}

/** 머리 칸 클릭 — 오름 → 내림 → 정렬 없음(Orca CsvViewer). */
export function nextCsvSort(cur: CsvSort, col: number): CsvSort {
  if (!cur || cur.col !== col) return { col, dir: 'asc' }
  return cur.dir === 'asc' ? { col, dir: 'desc' } : null
}

// ── 새 탭 옴니박스(Orca TabBarCreateEntry) ───────────────────────────────────────

/** Orca DEFAULT_SEARCH_ENGINE = google. ponytail: 검색 엔진 고르기(설정)는 뺐다 — 사내 포털 주소가 정해지면 여기 하나만 바꾼다. */
export const OMNIBOX_SEARCH_URL = 'https://www.google.com/search?q='

/** `?` 로 시작하면 파일·탭을 건너뛰고 바로 검색(Orca parseForcedSearchQuery). */
export function parseOmniboxQuery(input: string): { forced: boolean; query: string } {
  return input.startsWith('?') ? { forced: true, query: input.slice(1).trim() } : { forced: false, query: input.trim() }
}

const FILE_EXT_HOSTS = new Set(['css', 'html', 'js', 'jsx', 'json', 'md', 'py', 'toml', 'ts', 'tsx', 'yaml', 'yml'])

/** 입력이 주소면 http(s) URL, 아니면 null(Orca classifyExplicitUrl·classifyHostUrl 의 줄인 판 — tldts 없이 도메인 모양만). */
export function omniboxUrlOf(query: string): string | null {
  const q = query.trim()
  if (!q || /\s/.test(q)) return null
  if (/^https?:\/\//i.test(q)) {
    try {
      const u = new URL(q)
      return u.hostname ? u.href : null
    } catch {
      return null
    }
  }
  const authority = q.split(/[/?#]/)[0]
  const host = authority.split(':')[0]
  if (FILE_EXT_HOSTS.has(host.split('.').pop()?.toLowerCase() ?? '')) return null
  const local = host.toLowerCase() === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  if (!local && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) return null
  try {
    return new URL(`${local ? 'http' : 'https'}://${q}`).href
  } catch {
    return null
  }
}

/** 여러 낱말이면 검색 줄을 위로(Orca — 한 낱말은 파일이 먼저). */
export const omniboxPrefersSearch = (query: string): boolean => /\s/.test(query.trim())
