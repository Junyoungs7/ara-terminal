// M5 R2 — 채팅 옵션의 순수 규칙(main·렌더러·단위 시험이 같이 읽는다). 출처: stablyai/orca @fdfcfb3551 (MIT), 핵심만.
//  · AI-15 모델 목록 = claude-model-list-probe.ts·claude-structured-model-catalog.ts listedModels(설치된 CLI 에 list_models 를 묻는다 — 모델 이름을
//    코드에 적지 않는다). 터미널 탭에 적용 = agent-session-option-catalog-claude-codex.ts 의 `/model <id>`·`/effort <level>`, 첫 실행 = `--model`·`--effort`.
//  · AI-16 슬래시 = claude-at-rest-commands.ts(폴더 스캔 갈래)·claude-command-folder-scan.ts(하위 폴더 = `a:b`)·skill-metadata.ts(앞머리 description)
//    ·native-chat-picker-triggers.ts(맨 앞 `/` 만 보내는 명령).
//  · AI-19 이름 = conversation-name-generation.ts(첫 요청만·4000자·48자·정리 규칙).
// 뺀 것: 빠른 모드(/fast)·자동 모드 표시·모델 목록 영속 캐시·stream init 의 slash_commands(구조화 세션이 없다)·플러그인 명령.
import type { AgentId } from './agents'

// ── AI-15 모델·추론 강도 ──
export type ModelOption = { id: string; label: string; description?: string; efforts: string[]; isDefault?: true }
export type ModelCatalog = { models: ModelOption[] } | { error: string }

/** 모델 id·강도 값 — 셸 한 줄(--model)과 PTY(/model)에 들어가므로 낱말 하나로만(Orca 예: `opus[1m]`). */
const OPTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/
export const isOptionValue = (v: unknown): v is string => typeof v === 'string' && OPTION_VALUE.test(v)

/** `claude -p` 에 stream-json 으로 list_models 를 묻는다 — API 턴이 아니다(Orca: "reads the picker without an API turn"). */
export const CLAUDE_MODEL_LIST_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config']
export const CLAUDE_MODEL_LIST_STDIN = JSON.stringify({ type: 'control_request', request_id: 'ara-model-discovery', request: { subtype: 'list_models' } }) + '\n'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** control_response 줄에서 모델 목록(Orca listedModels): disabled·default 줄은 빼고, default 가 가리키는 모델에 isDefault. */
export function parseClaudeModelList(stdout: string): ModelOption[] {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('control_response')) continue
    let r: Rec | null = null
    try {
      r = rec(JSON.parse(line))
    } catch {
      continue
    }
    const res = rec(r?.response)
    const rows = rec(res?.response)?.models
    if (r?.type !== 'control_response' || res?.subtype !== 'success' || !Array.isArray(rows)) continue
    const list = rows.map(rec).filter((x): x is Rec => x !== null)
    const defaultRuns = text(list.find((x) => x.value === 'default')?.resolvedModel)
    const seen = new Set<string>()
    const out: ModelOption[] = []
    for (const row of list) {
      const id = text(row.value)
      if (!id || id === 'default' || row.disabled === true || seen.has(id) || !isOptionValue(id)) continue
      seen.add(id)
      const efforts = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter(isOptionValue) : []
      const description = text(row.description)
      out.push({
        id,
        label: text(row.displayName) ?? id,
        ...(description ? { description } : {}),
        efforts,
        ...(defaultRuns !== null && text(row.resolvedModel) === defaultRuns ? { isDefault: true as const } : {})
      })
    }
    if (out.length) return out
  }
  return []
}

/** 첫 실행 인자(Orca launchArgs). 지금은 Claude 만 목록이 있다. */
export function launchOptionArgs(agent: AgentId, o: { model?: string; effort?: string }): string[] {
  if (agent !== 'claude') return []
  return [...(isOptionValue(o.model) ? ['--model', o.model] : []), ...(isOptionValue(o.effort) ? ['--effort', o.effort] : [])]
}

/** 실행 중인 터미널 탭에 칠 명령(Orca build: `/model ${value}`). */
export function optionCommand(kind: 'model' | 'effort', value: string): string | null {
  return isOptionValue(value) ? `/${kind} ${value}` : null
}

/** 강도 이름(Orca effortLabel — xhigh = Extra high). */
export const effortLabel = (v: string): string => (v === 'xhigh' ? 'Extra high' : v.charAt(0).toUpperCase() + v.slice(1))

// ── AI-16 슬래시 명령·스킬 ──
export type SlashItem = { name: string; kind: 'builtin' | 'command' | 'skill'; description?: string; source?: 'user' | 'project' }

/** 에이전트별 기본 명령(이름만 — 설명은 렌더러 i18n `aiws.slash.<이름>`). 이 CLI 들이 TUI 에서 받는 것 중 채팅에서 쓸 만한 것. */
export const BUILTIN_SLASH: Record<AgentId, readonly string[]> = {
  claude: ['clear', 'compact', 'model', 'effort', 'context', 'cost', 'init', 'memory', 'mcp', 'permissions', 'resume', 'review', 'status', 'help'],
  codex: ['new', 'compact', 'model', 'approvals', 'init', 'diff', 'mention', 'status', 'mcp'],
  gemini: ['clear', 'compress', 'chat', 'memory', 'mcp', 'tools', 'stats', 'help']
}

const SLASH_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const DESC_CHARS = 200

/** YAML 앞머리의 한 줄 값(따옴표 벗김). 여러 줄 값·중첩은 1차에서 안 읽는다. */
function frontValue(front: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(front)
  const v = m?.[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim()
  return v && !/^[>|]-?$/.test(v) ? v : null
}

/** 명령·스킬 .md 의 설명 — 앞머리 description, 없으면 본문 첫 문단(Orca summarizeSkillMarkdown). */
export function describeMarkdown(md: string): { name: string | null; description: string | null } {
  const s = md.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const fm = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(s)
  const body = fm ? s.slice(fm[0].length) : s
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s.*$/gm, '').trim())
    .find(Boolean)
  const desc = (fm && frontValue(fm[1], 'description')) || para || null
  return { name: fm ? frontValue(fm[1], 'name') : null, description: desc ? desc.replace(/\s+/g, ' ').slice(0, DESC_CHARS) : null }
}

/** 상대 경로(`a/b.md`) → 명령 이름 `a:b`(Orca: 하위 폴더 = 이름공간). */
export function commandNameOf(rel: string): string | null {
  const name = rel.replace(/\\/g, '/').replace(/\.md$/i, '').split('/').filter(Boolean).join(':')
  return SLASH_NAME.test(name) ? name : null
}

/** 맨 앞 `/` 뒤 낱말(공백 전)만 — 그때만 목록을 연다(Orca LEADING_SLASH_TRIGGER = /^\/(\S*)$/). */
export function slashQuery(draft: string): string | null {
  const m = /^\/(\S*)$/.exec(draft)
  return m ? m[1].toLowerCase() : null
}

/** 거르기·순서 — 이름이 질의로 시작하는 것 먼저, 그다음 이름에 들어 있는 것(같은 무리 안은 받은 순서). */
export function filterSlash(items: readonly SlashItem[], query: string, limit = 50): SlashItem[] {
  const q = query.toLowerCase()
  const head = items.filter((x) => x.name.toLowerCase().startsWith(q))
  const mid = items.filter((x) => !x.name.toLowerCase().startsWith(q) && x.name.toLowerCase().includes(q))
  return [...head, ...mid].slice(0, limit)
}

// ── AI-19 채팅 이름 ──
const FIRST_PROMPT_CHARS = 4000
export const CHAT_NAME_CHARS = 48

/** 이름 짓기 요청의 첫 줄 — 지난 세션 목록(vault)이 이 한 번짜리 실행을 숨길 때 본다(Orca CONVERSATION_NAME_PROMPT_OPENING). */
export const CHAT_NAME_OPENING = "Name this chat from the user's first request."

/** 이름 짓기 요청 글(Orca buildConversationNamePrompt 그대로 — 첫 요청만, 4000자까지). */
export function chatNamePrompt(firstPrompt: string): string {
  return `${CHAT_NAME_OPENING}
Write a short, specific title of at most ${CHAT_NAME_CHARS} characters.
Output only the title, with no heading, quotes, or explanation.

First request:
${firstPrompt.trim().slice(0, FIRST_PROMPT_CHARS)}`
}

/** 모델 출력 → 이름(Orca sanitizeGeneratedConversationName): 생각 블록 거절, 첫 줄, 머리표·강조·따옴표·title: 벗김, 48자(공백에서 끊기). */
export function sanitizeChatName(raw: string): string | null {
  const cleaned = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
  if (cleaned.startsWith('<think>') || cleaned.startsWith('◁think▷')) return null
  const first = cleaned.split(/\r?\n/).find((l) => l.trim())
  if (!first) return null
  let name = first.trim().replace(/^#{1,6}\s*/, '').trim()
  for (;;) {
    const next = name
      .replace(/^(\*\*|__)(.*?)\1$/, '$2')
      .replace(/^("|'|`)(.*?)\1$/, '$2')
      .replace(/^“(.*)”$/, '$1')
      .replace(/^‘(.*)’$/, '$1')
      .replace(/^title\s*:\s*/i, '')
      .trim()
    if (next === name) break
    name = next
  }
  name = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim()
  if (!name) return null
  if (name.length <= CHAT_NAME_CHARS) return name
  const clipped = name.slice(0, CHAT_NAME_CHARS)
  const cut = clipped.lastIndexOf(' ')
  return (cut >= CHAT_NAME_CHARS / 2 ? clipped.slice(0, cut) : clipped).trim()
}

/** 이름 짓기 실행 인자(Orca commit-message-agent-specs-primary — 읽기 전용·한 번, 글은 stdin). */
export const CHAT_NAME_ARGS: Record<AgentId, readonly string[]> = {
  claude: ['-p', '--output-format', 'text', '--permission-mode', 'plan'],
  codex: ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-'],
  // ponytail: gemini 는 stdin 이 관이면 한 번 답하고 끝난다(비대화형). 실측은 사용자 확인 목록.
  gemini: []
}
