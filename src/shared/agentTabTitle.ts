// M11 에이전트 탭 제목 — Orca src/shared/agent-tab-title.ts(첫 지시 → 생성 제목)·agent-title-decoration.ts(살아 있는 OSC 제목의 앞 상태 글리프)·
// tab-title-resolution.ts(우선순위)를 옮겼다(orcaRef fdfcfb3551, MIT). deriveGeneratedTabTitle 은 원본 그대로.
export const GENERATED_TAB_TITLE_MAX_LENGTH = 40
export const GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT = 512

const LEADING_FILLER_PATTERNS: RegExp[] = [
  /^(?:can|could|would)\s+you(?:\s+please)?\s+/i,
  /^please(?:\s+|$)/i,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^help\s+me(?:\s+to)?\s+/i,
  /^help\s+/i,
  /^let'?s\s+/i,
  /^we\s+need\s+to\s+/i,
  /^need\s+to\s+/i
]

function capitalizeFirstLetter(value: string): string {
  return value.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase())
}

function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const rawSlice = value.slice(0, maxLength)
  const sliced = rawSlice.trim()
  if (sliced.length < rawSlice.length) {
    return sliced
  }
  const lastSpace = sliced.lastIndexOf(' ')
  if (lastSpace >= Math.floor(maxLength * 0.55)) {
    return sliced.slice(0, lastSpace).trim()
  }
  return sliced
}

// Collapse pasted-prompt whitespace without a regex pass on renderer state paths.
function foldGeneratedTabTitleWhitespace(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isGeneratedTabTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function isGeneratedTabTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

export function deriveGeneratedTabTitle(prompt: string): string | null {
  // Bound renderer title cleanup before scanning paste-sized prompts.
  const promptPreview = prompt.slice(0, GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT)
  const firstClause = promptPreview
    .trim()
    // Strip URLs before punctuation: underscores in /merge_requests would leak fragments. Avoid a word boundary so _https://…_ also matches.
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_~#>[\]{}()]/g, ' ')
    .replace(/^(?:issue|task|bug|feature|pr)\s*(?:#?\d+)?\s*[:-]\s*/i, '')
    .split(/[.!?;\n\r\u2028\u2029]/u)[0]
    ?.trim()

  if (!firstClause) {
    return null
  }

  let candidate = firstClause
  for (let i = 0; i < 3; i += 1) {
    const before = candidate
    for (const pattern of LEADING_FILLER_PATTERNS) {
      candidate = candidate.replace(pattern, '')
    }
    candidate = candidate.trim()
    if (candidate === before.trim()) {
      break
    }
  }

  candidate = foldGeneratedTabTitleWhitespace(candidate.replace(/[^\p{L}\p{N}\s]/gu, ' '))

  if (!candidate) {
    return null
  }

  return truncateAtWordBoundary(capitalizeFirstLetter(candidate), GENERATED_TAB_TITLE_MAX_LENGTH)
}

// Strip redundant leading status glyphs/prefixes only from known agent titles; the tab already shows the provider icon.
const LEADING_AGENT_TITLE_DECORATION_RE =
  /^(?:[\u2733\u2726\u23F2\u25C7\u270B\u25B2\u2800-\u28FF\u25D0-\u25D3]+|[.*]\s)\s*/

export function stripLeadingAgentTitleDecorationOrEmpty(title: string): string {
  return title.replace(LEADING_AGENT_TITLE_DECORATION_RE, '').trimStart()
}

export function stripLeadingAgentTitleDecoration(title: string): string {
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(title)
  // Retain glyph-only titles rather than producing blank tab labels.
  return stripped.length > 0 ? stripped : title
}

// ── 아라: Claude 가 OSC 로 정하는 작업 요약 제목("✳ Fix login bug") ──
// Orca 는 에이전트 종류별 제목 판정(agent-title-core·evidence)이 크다. 아라는 Claude 만 — Claude 는 터미널 제목을 그 턴의 작업 요약으로 쓴다.
// ponytail: Gemini("◇  Ready (폴더)")·Codex 제목은 상태 문구라 탭 제목으로 안 쓴다. 다른 CLI 가 요약 제목을 쓰면 여기 한 줄.
const CLAUDE_IDENTITY_FRAME_RE = /^claude(?: code)?(?:\s+(?:ready|idle|done|working|thinking|running))?(?:\s*-\s*action required)?$/

/** 살아 있는 OSC 제목 → 탭에 쓸 작업 요약. 상태 글리프를 떼고, 이름뿐인 제목("Claude Code")·빈 것은 null. */
export function agentLiveTitle(agent: string, raw: string): string | null {
  if (agent !== 'claude') return null
  const t = stripLeadingAgentTitleDecorationOrEmpty(raw).trim()
  if (!t || CLAUDE_IDENTITY_FRAME_RE.test(t.toLowerCase())) return null
  return t.length > GENERATED_TAB_TITLE_MAX_LENGTH * 2 ? t.slice(0, GENERATED_TAB_TITLE_MAX_LENGTH * 2) : t
}

/**
 * 탭에 보일 제목 — Orca resolveTerminalTabTitle 순서: (사람이 정한 이름 = 아라 AI-19 채팅 이름) > 지난 세션 제목(재개) >
 * 생성 제목(설정이 켜졌을 때 — Orca tabAutoGenerateTitle 기본 꺼짐) > 살아 있는 OSC 제목 > 없음(에이전트 이름만).
 */
export function resolveAgentTabTitle(
  tab: { name?: string; vaultTitle?: string; genTitle?: string },
  liveTitle: string | null | undefined,
  generatedTitlesEnabled: boolean
): string {
  return tab.name?.trim() || tab.vaultTitle?.trim() || (generatedTitlesEnabled ? tab.genTitle?.trim() : '') || liveTitle?.trim() || ''
}
