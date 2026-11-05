// 출처: herdrdev/herdr src/detect/manifest.rs@ee5bfb5041 (Apache-2.0) — 화면 매니페스트 판정 엔진(AI-05 턴 끝 판정).
// 규칙 데이터는 같은 저장소의 src/detect/manifests/*.toml 22종을 그대로 JSON 으로 옮긴 agentManifests.json(scripts/herdr-manifests.mjs).
// herdr.dev 원격 갱신·로컬 덮어쓰기 파일·explain 은 뺐다. 판정은 터미널 화면 글자(헤드리스 xterm 이 그린 결과)·OSC 제목·OSC 9;4 진행만 본다.
import manifestsJson from './agentManifests.json'

export type ScreenState = 'idle' | 'working' | 'blocked' | 'unknown'

export type ScreenInput = {
  /** 그려진 화면(스크롤백 꼬리 + 보이는 줄). 줄 끝 공백은 걷어 낸 것. */
  screen: string
  /** OSC 0/2 창 제목. */
  oscTitle?: string
  /** OSC 9;4 진행 보고의 값 부분(`4;0` 등). */
  oscProgress?: string
}

export type ScreenDetection = {
  state: ScreenState
  /** 상태 판정을 건너뛸 화면(대화 기록 보기 등) — 이전 상태를 그대로 둔다. */
  skip: boolean
  /** 그 규칙이 "지금 화면에 살아 있는 UI"라고 표시한 것(herdr visible_*). 훅 상태를 덮을지 가르는 근거. */
  visibleBlocker: boolean
  visibleIdle: boolean
  visibleWorking: boolean
  /** 맞은 규칙 id(시험·툴팁용). 없으면 null. */
  rule: string | null
}

type Gate = {
  all?: Gate[]
  any?: Gate[]
  not?: Gate[]
  contains?: string[]
  regex?: string[]
  line_regex?: string[]
}
type Rule = Gate & {
  id: string
  state?: ScreenState
  priority?: number
  region?: string
  visible_idle?: boolean
  visible_blocker?: boolean
  visible_working?: boolean
  skip_state_update?: boolean
}
type Manifest = { id: string; aliases?: string[]; rules?: Rule[] }

export const MANIFEST_SOURCE: string = (manifestsJson as { source: string }).source
const MANIFESTS = (manifestsJson as { manifests: Record<string, Manifest> }).manifests

type CompiledGate = { all: CompiledGate[]; any: CompiledGate[]; not: CompiledGate[]; contains: string[]; regex: RegExp[]; lineRegex: RegExp[] }

/**
 * Rust regex → JS RegExp. 매니페스트가 쓰는 차이만 옮긴다: 맨 앞 인라인 플래그 `(?ims)`, `\x{…}`, `\A`, `\z`.
 * 늘 `u` 플래그(유니코드 클래스·`\u{…}`·`\p{…}`).
 * ponytail: Rust 의 `\w`·`\d`·`\b` 는 유니코드, JS 는 ASCII — 영어 UI 문구만 보는 규칙이라 차이가 안 난다. 한글 문구 규칙이 생기면 여기서 바꾼다.
 */
export function rustRegex(pattern: string): RegExp {
  let flags = 'u'
  let src = pattern
  const m = /^\(\?([ims]+)\)/.exec(src)
  if (m) {
    flags += m[1]
    src = src.slice(m[0].length)
  }
  src = src
    .replace(/\\x\{([0-9A-Fa-f]+)\}/g, '\\u{$1}')
    .replace(/\\A/g, '(?<![\\s\\S])')
    .replace(/\\z/g, '(?![\\s\\S])')
  return new RegExp(src, flags)
}

function compileGate(g: Gate): CompiledGate {
  return {
    all: (g.all ?? []).map(compileGate),
    any: (g.any ?? []).map(compileGate),
    not: (g.not ?? []).map(compileGate),
    contains: (g.contains ?? []).map((s) => s.toLowerCase()),
    regex: (g.regex ?? []).map(rustRegex),
    lineRegex: (g.line_regex ?? []).map(rustRegex)
  }
}

/** Rust `str::lines()` — `\n` 으로 가르고 줄 끝 `\r` 하나를 뗀다. 마지막 빈 조각은 줄이 아니다. */
function lines(text: string): string[] {
  if (text === '') return []
  const out = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  if (text.endsWith('\n')) out.pop()
  return out
}

function gateMatches(g: CompiledGate, text: string, lower: string): boolean {
  if (!g.contains.every((n) => lower.includes(n))) return false
  if (!g.regex.every((r) => r.test(text))) return false
  if (g.lineRegex.length && !g.lineRegex.every((r) => lines(text).some((l) => r.test(l)))) return false
  if (!g.all.every((n) => gateMatches(n, text, lower))) return false
  if (g.any.length && !g.any.some((n) => gateMatches(n, text, lower))) return false
  if (g.not.some((n) => gateMatches(n, text, lower))) return false
  return true
}

// ── 영역(region) — manifest.rs region() 과 같은 이름·같은 자르기 ─────────────────────────────

/** 줄 index 부터 끝까지(바이트 대신 글자 — 같은 줄 경계라 결과가 같다). */
function fromLine(ls: string[], index: number): string {
  return ls.slice(index).join('\n')
}

function bottomNonEmpty(content: string, count: number): string {
  const ls = lines(content)
  let seen = 0
  for (let k = ls.length - 1; k >= 0; k--) {
    if (ls[k].trim() === '') continue
    if (++seen === count) return fromLine(ls, k)
  }
  return seen ? fromLine(ls, ls.findIndex((l) => l.trim() !== '')) : ''
}

function topNonEmpty(content: string, count: number): string {
  const ls = lines(content)
  let seen = 0
  let end = -1
  for (let k = 0; k < ls.length && seen < count; k++) {
    if (ls[k].trim() === '') continue
    seen++
    end = k
  }
  return end < 0 ? '' : ls.slice(0, end + 1).join('\n') + '\n'
}

const codexPromptLine = (l: string): boolean => l === '›' || l.startsWith('› ')
const codexBlockMarker = (l: string): boolean => /^[•■✗✓]/u.test(l)

function currentCodexPromptIndex(ls: string[]): number | null {
  let k = -1
  for (let j = ls.length - 1; j >= 0; j--) {
    if (codexPromptLine(ls[j])) {
      k = j
      break
    }
  }
  if (k < 0) return null
  return ls.slice(k + 1).some(codexBlockMarker) ? null : k
}

function isHorizontalRule(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  let n = 0
  while (t[n] === '─') n++
  if (n === 0) return false
  return t.slice(n).trimStart() === '' || n >= 3
}

function promptBoxTop(ls: string[]): number | null {
  let borders = 0
  for (let k = ls.length - 1; k >= 0; k--) {
    if (isHorizontalRule(ls[k]) && ++borders === 2) return k
  }
  return null
}

function abovePromptBox(content: string): string {
  const ls = lines(content)
  const top = promptBoxTop(ls)
  return top === null ? content : ls.slice(0, top).map((l) => l + '\n').join('')
}

function region(input: ScreenInput, spec: string): string {
  const name = spec.trim()
  if (name === 'osc_title') return input.oscTitle ?? ''
  if (name === 'osc_progress') return input.oscProgress ?? ''
  const content = input.screen
  const ls = lines(content)
  switch (name) {
    case 'whole_recent':
      return content
    case 'after_last_prompt_marker': {
      let k = -1
      for (let j = ls.length - 1; j >= 0; j--)
        if (codexPromptLine(ls[j])) {
          k = j
          break
        }
      return k < 0 ? content : fromLine(ls, k + 1)
    }
    case 'before_current_prompt_marker': {
      const k = currentCodexPromptIndex(ls)
      return k === null ? content : ls.slice(0, k).map((l) => l + '\n').join('')
    }
    case 'whole_recent_without_current_prompt_marker':
      return currentCodexPromptIndex(ls) === null ? content : ''
    case 'prompt_box_body': {
      const top = promptBoxTop(ls)
      if (top === null) return ''
      const rel = ls.slice(top + 1).findIndex(isHorizontalRule)
      const end = rel < 0 ? ls.length : top + 1 + rel
      return ls.slice(top + 1, end).map((l) => l + '\n').join('')
    }
    case 'above_prompt_box':
      return abovePromptBox(content)
    case 'last_non_empty_above_prompt_box':
      return [...lines(abovePromptBox(content))].reverse().find((l) => l.trim() !== '') ?? ''
    case 'after_last_horizontal_rule': {
      let k = -1
      ls.forEach((l, j) => {
        if (isHorizontalRule(l)) k = j
      })
      return k < 0 ? content : fromLine(ls, k + 1)
    }
  }
  const bottom = /^bottom_non_empty_lines\((\d+)\)$/.exec(name)
  if (bottom) return bottomNonEmpty(content, Number(bottom[1]))
  const bottomAll = /^bottom_lines\((\d+)\)$/.exec(name)
  if (bottomAll) return fromLine(ls, Math.max(0, ls.length - Number(bottomAll[1])))
  const top = /^top_non_empty_lines\(([1-9]\d*)\)$/.exec(name)
  if (top) return topNonEmpty(content, Number(top[1]))
  return ''
}

// ── 판정 ────────────────────────────────────────────────────────────────────────────

const compiled = new Map<string, { rule: Rule; gate: CompiledGate }[]>()

function compiledRules(agent: string): { rule: Rule; gate: CompiledGate }[] | null {
  const hit = compiled.get(agent)
  if (hit) return hit
  const m = MANIFESTS[agent] ?? Object.values(MANIFESTS).find((x) => x.aliases?.includes(agent))
  if (!m) return null
  const rules = (m.rules ?? []).map((rule) => ({ rule, gate: compileGate(rule) }))
  compiled.set(agent, rules)
  return rules
}

/** 맨 아래 가로줄 둘 사이(claude 입력 상자 안) — 매니페스트 밖에서 그 자리를 볼 때. */
export const promptBoxBody = (screen: string): string => region({ screen }, 'prompt_box_body')

/** 실린 매니페스트 id(시험·보고용). */
export const manifestIds = (): string[] => Object.keys(MANIFESTS)

/**
 * 화면 하나를 판정한다(herdr evaluate_loaded_manifest). 맞은 규칙 중 priority 가 가장 큰 것(같으면 먼저 나온 것).
 * 아무것도 안 맞으면 idle(herdr fallback_explain — 아는 에이전트가 떠 있는데 일하는 표시도 막힌 표시도 없으면 쉬는 것). 모르는 에이전트는 unknown.
 */
export function detectScreen(agent: string, input: ScreenInput): ScreenDetection {
  const none: ScreenDetection = { state: 'unknown', skip: false, visibleBlocker: false, visibleIdle: false, visibleWorking: false, rule: null }
  const rules = compiledRules(agent)
  if (!rules) return none
  let best: Rule | null = null
  for (const { rule, gate } of rules) {
    const text = region(input, rule.region ?? 'whole_recent')
    if (!gateMatches(gate, text, text.toLowerCase())) continue
    if (!best || (rule.priority ?? 0) > (best.priority ?? 0)) best = rule
  }
  if (!best) return { ...none, state: 'idle' }
  const state = best.state ?? 'unknown'
  return {
    state,
    skip: best.skip_state_update === true,
    visibleBlocker: best.visible_blocker === true && state === 'blocked',
    visibleIdle: best.visible_idle === true && state === 'idle',
    visibleWorking: best.visible_working === true && state === 'working',
    rule: best.id
  }
}
