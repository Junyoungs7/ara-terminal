// M12 R3 RV-02 — 소스 제어 [AI 로 쓰기]: 커밋 메시지 · MR 제목·본문 · 브랜치 이름. 순수 규칙(main·시험이 같이 읽는다).
// 출처: stablyai/orca @fdfcfb3551 (MIT) shared/commit-message-generation.ts(buildCommitMessagePrompt·splitGeneratedCommitMessage)
// · commit-message-prompt.ts(truncateDiffForPrompt) · commit-message-agent-output.ts(cleanGeneratedCommitMessage 의 CLI 출력 정리)
// · pull-request-generation.ts(buildPullRequestFieldsPrompt·parseGeneratedPullRequestFields) · branch-name-from-work.ts(buildBranchNamePrompt·sanitizeBranchSlug)
// · commit-message-agent-specs-primary.ts(claude·codex 실행 인자) · claude-background-run-isolation.ts.
// 엔진 = 사용자 PC(원격 작업 단위는 그 서버)에 깔린 CLI 에이전트를 한 번 실행(구독 그대로 — API 키 과금 아님). 프롬프트는 stdin 으로만.
// 뺀 것: 사용자 지정 명령·모델 고르기·생각 강도 고르기·이슈 연결·jcode/kimi 출력 갈래·명령줄 길이 맞추기(stdin 이라 필요 없음).
import type { AgentId } from './agents'

export type ScmAiKind = 'commit' | 'mr' | 'branch'
/** 실패 코드 — 렌더러가 scm.ai.err.<code> 로 옮긴다. message = CLI 의 말(앞부분만). */
export type ScmAiErr = 'noStaged' | 'noBranchChanges' | 'noBase' | 'noCli' | 'noCliRemote' | 'canceled' | 'timeout' | 'failed' | 'empty' | 'busy'
export type ScmAiResult =
  | { ok: true; agent: AgentId; text?: string; title?: string; body?: string; base?: string; slug?: string }
  | { ok: false; code: ScmAiErr; message?: string; agent?: AgentId }

/** Orca SOURCE_CONTROL_GENERATION_TIMEOUT_MS. */
export const SCM_AI_TIMEOUT_MS = 60_000
/** Orca STAGED_DIFF_BYTE_BUDGET(UTF-16 글자 수). */
export const STAGED_DIFF_BYTE_BUDGET = 200_000
/** Orca 가 [AI 로 쓰기]를 받는 에이전트(commit-message-agent-specs-primary). Gemini 는 Orca 에 명세가 없다. */
export const SCM_AI_AGENTS: readonly AgentId[] = ['claude', 'codex']
/** 기본 에이전트가 지원 밖(gemini)이면 Claude(Orca 기본 claude). */
export const scmAiAgentOf = (defaultAgent: AgentId): AgentId => (SCM_AI_AGENTS.includes(defaultAgent) ? defaultAgent : 'claude')

/** Claude 가 기업 MCP 설정 때문에 --strict-mcp-config 를 거절할 때의 말(Orca ENTERPRISE_REFUSAL) — 그때만 그 인자 없이 한 번 더. */
export const CLAUDE_ENTERPRISE_REFUSAL = 'You cannot use --strict-mcp-config when an enterprise MCP config is present'

/**
 * 실행 인자(Orca 명세 그대로 — claude 기본 모델 sonnet·강도 low, codex 는 CLI 기본 모델).
 * 사용자 전역 설정 파일은 안 건드린다: 훅 끄기는 이 실행의 `--settings`(POSIX 만 — Windows cmd 인용에 JSON 을 안 싣는다, M5 모델 목록과 같은 한계).
 */
export function scmAiArgs(agent: AgentId, o: { strictMcp: boolean; posix: boolean }): string[] {
  if (agent === 'codex') return ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only']
  return [
    '-p',
    '--output-format',
    'text',
    '--model',
    'sonnet',
    '--permission-mode',
    'plan',
    '--effort',
    'low',
    ...(o.strictMcp ? ['--strict-mcp-config'] : []),
    ...(o.posix ? ['--settings', '{"disableAllHooks":true}'] : [])
  ]
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated: ${value.length - maxChars} characters omitted]`
}

function splitDiffIntoFileSections(diff: string): string[] {
  const boundary = '\ndiff --git '
  const sections: string[] = []
  let start = 0
  let next = diff.indexOf(boundary)
  while (next !== -1) {
    sections.push(diff.slice(start, next + 1))
    start = next + 1
    next = diff.indexOf(boundary, start)
  }
  sections.push(diff.slice(start))
  return sections
}

function clipSectionOnLineBoundary(section: string, limit: number): string {
  if (section.length <= limit) return section
  if (limit <= 0) return ''
  const markerFor = (omitted: number): string => `\n...(diff truncated, ${omitted} bytes omitted)\n`
  let marker = markerFor(section.length)
  if (marker.length >= limit) return marker.slice(0, limit)
  const target = limit - marker.length
  const lineBreak = section.lastIndexOf('\n', target)
  const cut = lineBreak > target / 2 ? lineBreak : target
  marker = markerFor(section.length - cut)
  return `${section.slice(0, Math.min(cut, Math.max(0, limit - marker.length)))}${marker}`
}

function allocateBudgetFairly(sizes: number[], budget: number): number[] {
  const alloc = sizes.map(() => 0)
  let active = sizes.map((_, i) => i)
  let remaining = budget
  while (active.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / active.length)
    if (share === 0) break
    const still: number[] = []
    for (const i of active) {
      const need = sizes[i] - alloc[i]
      const grant = Math.min(need, share)
      alloc[i] += grant
      remaining -= grant
      if (grant < need) still.push(i)
    }
    active = still
  }
  return alloc
}

/** 파일마다 몫을 나눠 자른다 — 큰 생성 파일 하나가 사람이 고친 작은 파일들을 밀어내지 않게(Orca 그대로). */
export function truncateDiffForPrompt(diff: string, budget: number = STAGED_DIFF_BYTE_BUDGET): string {
  if (diff.length <= budget) return diff
  const sections = splitDiffIntoFileSections(diff)
  if (sections.length <= 1) return clipSectionOnLineBoundary(diff, budget)
  const alloc = allocateBudgetFairly(
    sections.map((s) => s.length),
    budget
  )
  return sections.map((s, i) => clipSectionOnLineBoundary(s, alloc[i])).join('')
}

export type CommitContext = { branch: string | null; stagedSummary: string; stagedPatch: string }

export function buildCommitMessagePrompt(c: CommitContext): string {
  const patch = c.stagedPatch.trim() ? truncateDiffForPrompt(c.stagedPatch) : '(diff omitted — too large to read; infer the change from the staged file list above)'
  return [
    'You are generating a single git commit message.',
    'Return only the commit message text. Do not include a preamble, quotes, or code fences.',
    '',
    'Rules:',
    '- First line: imperative mood, <= 72 chars, no trailing period.',
    '- Optional body: blank line, then short wrapped bullet points or prose explaining WHY.',
    '- Capture the primary user-visible or developer-visible change.',
    '- Use only the staged changes below as context.',
    '- Do not include "Co-authored-by" or other git trailers.',
    '',
    `Branch: ${c.branch ?? '(detached)'}`,
    '',
    'Staged files:',
    limitSection(c.stagedSummary, 6_000),
    '',
    'Staged patch:',
    '```diff',
    patch,
    '```'
  ].join('\n')
}

const REASONING_TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '◁think▷', close: '◁/think▷' }
] as const

/** CLI 출력 정리(Orca cleanGeneratedCommitMessage 의 claude·codex 갈래): 줄바꿈 맞춤 · 진행 머리줄 · 생각 블록 · 감싼 코드 울타리 · 목록 기호. */
export function cleanGeneratedText(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const nl = text.indexOf('\n')
  if (nl !== -1) {
    const first = text.slice(0, nl)
    if (/^(generating|thinking)\b/i.test(first) || /^[.…]+$/.test(first.trim())) text = text.slice(nl + 1).trim()
  }
  for (const { open, close } of REASONING_TAGS) {
    if (!text.startsWith(open)) continue
    const at = text.indexOf(close, open.length)
    if (at !== -1) text = text.slice(at + close.length).trim()
  }
  const fence = /^```[A-Za-z0-9_-]*\n([\s\S]*)\n```$/.exec(text)
  if (fence) text = fence[1].trim()
  return text.replace(/^(\s*)(?:[-*•●]\s+|\d+[.)]\s+)/, '$1').trim()
}

/** 제목 줄 72자·끝 마침표 없음, 본문은 빈 줄 뒤(Orca splitGeneratedCommitMessage). 빈 답이면 ''. */
export function commitMessageOf(raw: string): string {
  const text = cleanGeneratedText(raw)
  if (!text) return ''
  const nl = text.indexOf('\n')
  const subject = (nl === -1 ? text : text.slice(0, nl)).trim().replace(/[.]+$/g, '').slice(0, 72).trimEnd() || 'Update project files'
  const body = nl === -1 ? '' : text.slice(nl + 1).trim()
  return body ? `${subject}\n\n${body}` : subject
}

export type MrContext = { branch: string | null; base: string; commitSummary: string; changeSummary: string; patch: string }

/** Orca buildPullRequestFieldsPrompt — 제공자는 GitLab(묶음 11), 이슈 연결·지금 제목/본문은 없음(아라에 MR 화면이 아직 없다). */
export function buildMrPrompt(c: MrContext): string {
  return [
    'You are generating pull request details.',
    'Return ONLY compact JSON with this exact shape:',
    '{"base":"branch-name","title":"short title","body":"markdown description","draft":false}',
    '',
    'Rules:',
    '- Use the branch diff and commits below as source of truth.',
    '- Keep the base branch as the current base unless the diff clearly targets a different branch.',
    '- Title: concise, specific, no trailing period.',
    '- Body: start with `## Problem`, then `## Solution`, in simple ELI5 language before details.',
    '- Reuse equivalent existing sections instead of duplicating them.',
    '- No GitLab issue is linked; do not invent one.',
    '- Include testing notes only when evidence exists.',
    '- draft: true only when the changes clearly look unfinished, WIP, or unsafe to review.',
    '- Do not include labels, reviewers, code fences, prose, or any keys beyond base/title/body/draft.',
    '',
    `Head branch: ${c.branch ?? '(detached)'}`,
    `Current base: ${c.base}`,
    'Current title: (empty)',
    'Current description: (empty)',
    'Current draft: false',
    'Linked GitLab issue: (none)',
    '',
    'Commits:',
    limitSection(c.commitSummary || '(none)', 8_000),
    '',
    'Changed files:',
    limitSection(c.changeSummary || '(none)', 8_000),
    '',
    'Patch:',
    '```diff',
    truncateDiffForPrompt(c.patch),
    '```',
    '',
    'Final output requirement:',
    'Return compact JSON only with keys base, title, body, and draft. No prose or code fences.'
  ].join('\n')
}

/** Orca parseGeneratedPullRequestFields — 울타리·앞뒤 말을 걷고 JSON 하나. 못 읽으면 throw. */
export function parseMrFields(raw: string, base: string): { base: string; title: string; body: string } {
  let text = cleanGeneratedText(raw)
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) text = text.slice(s, e + 1)
  const r = JSON.parse(text) as unknown
  if (!r || typeof r !== 'object') throw new Error('Expected a JSON object.')
  const o = r as Record<string, unknown>
  const title = typeof o['title'] === 'string' ? o['title'].trim().replace(/[.]+$/g, '') : ''
  const b = typeof o['base'] === 'string' && o['base'].trim() ? o['base'].trim() : base
  return { base: b, title: title || 'Update project files', body: typeof o['body'] === 'string' ? o['body'].replace(/\s+$/g, '') : '' }
}

/**
 * Orca buildBranchNamePrompt. Orca 는 그 작업 단위 첫 지시(firstPrompt)를 준다 — 소스 제어 패널에는 첫 지시가 없어
 * 지금 바뀐 것(커밋·파일 목록)을 그 자리에 싣는다.
 */
export function buildBranchNamePrompt(work: string): string {
  return ['Generate a short git branch name that summarizes the coding task described below.', 'Output ONLY the branch name on a single line, nothing else.', '', 'User request:', work.trim()].join('\n')
}

/** Orca sanitizeBranchSlug — 영소문자·숫자 kebab-case, 4 낱말. 남는 게 없으면 ''. */
export function sanitizeBranchSlug(raw: string, maxWords = 4): string {
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
  return words.slice(0, maxWords).join('-')
}

/** 실패 출력 앞부분(Orca excerptAgentFailureOutput 축약) — stderr 우선, ANSI 걷고 240자. */
export function failureExcerpt(stdout: string, stderr: string): string | undefined {
  const src = /\S/.test(stderr) ? stderr : stdout
  // eslint-disable-next-line no-control-regex
  const clean = src.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  return clean ? clean.slice(0, 240) : undefined
}
