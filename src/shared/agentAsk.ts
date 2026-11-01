// M11 질문/승인 카드 — 에이전트가 사람의 답을 기다릴 때(훅 PermissionRequest · AskUserQuestion) 카드로 보여 주고 답을 TUI 키로 보낸다.
// 출처: stablyai/orca @fdfcfb3551 (MIT) — 기능 단위로 옮겼다:
//  · 훅 → 카드 글 = src/shared/agent-hook-listener/interactive-tool.ts(deriveInteractivePrompt·summarizeApprovalInput)
//  · 카드 읽기 = src/shared/native-chat/input/native-chat-ask.ts(parseAskFromStatus·parseCanonicalQuestionsInput·askOptionsHavePreview)·
//    native-chat-approval-envelope.ts·native-chat-interactive-prompt.ts(parseInteractivePrompt)
//  · 답 → 키 = src/shared/native-chat-ask-answer.ts(buildAskAnswerKeys·buildCodexAskAnswerKeys·hasAskAnswer — 원본 그대로)
//  · 걸음 간격 = src/shared/native-chat/input/native-chat-answer-stepping.ts
// 뺀 것: 등록식 질문 도구 표(Codex 비동기 질문·OMP 계획 검토), 대화 기록에서 남은 질문 찾기(transcript ask), opencode 승인 키(Enter).

export type AskOption = { label: string; description?: string }
export type AskQuestion = {
  question: string
  header?: string
  multiSelect: boolean
  options: AskOption[]
  /** Claude renders its preview selector: digits only move focus, Enter commits, free text is a note. */
  hasPreviews?: true
}
export type AskPrompt = { questions: AskQuestion[] }

export type ChatApproval = { tool: string; summary?: string; allowSend: string; denySend: string }

export type InteractivePromptCard = { kind: 'question'; prompt: AskPrompt } | { kind: 'approval'; approval: ChatApproval } | null

const ESCAPE = String.fromCharCode(27)
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_user_question', 'askUserQuestion'])
export const isAskUserQuestionTool = (tool: string | undefined): boolean => !!tool && QUESTION_TOOLS.has(tool)

// ── 훅 → 카드 글(main) ──

/** One-line description of a tool call for an approval card (Bash command, file path, else clipped JSON). */
export function summarizeApprovalInput(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>
    const direct = obj.command ?? obj.file_path ?? obj.path ?? obj.url ?? obj.pattern
    if (typeof direct === 'string' && direct.length > 0) {
      return direct.length > 200 ? `${direct.slice(0, 200)}…` : direct
    }
  }
  try {
    const json = JSON.stringify(toolInput) ?? ''
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
  } catch {
    return ''
  }
}

/** AskUserQuestion = 도구 입력 그대로({questions}), PermissionRequest = {approval:{tool,summary}}. 나머지 이벤트는 undefined. */
export function deriveInteractivePrompt(toolName: string | undefined, toolInput: unknown, eventName?: unknown): string | undefined {
  const isPostToolEvent = eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
  if (isAskUserQuestionTool(toolName) && !isPostToolEvent && toolInput !== undefined && toolInput !== null) {
    try {
      return JSON.stringify(toolInput)
    } catch {
      return undefined
    }
  }
  if (eventName === 'PermissionRequest' && typeof toolName === 'string' && toolName.length > 0) {
    try {
      return JSON.stringify({ approval: { tool: toolName, summary: summarizeApprovalInput(toolInput) } })
    } catch {
      return undefined
    }
  }
  return undefined
}

// ── 카드 읽기(렌더러) ──

function parseOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((option): AskOption | null => {
      if (typeof option === 'string') return { label: option }
      if (option && typeof option === 'object' && 'label' in option && typeof option.label === 'string') {
        return { label: option.label, description: 'description' in option && typeof option.description === 'string' ? option.description : undefined }
      }
      return null
    })
    .filter((option): option is AskOption => option !== null)
}

/** Claude only switches a single-select to its preview layout for a non-blank preview. */
export function askOptionsHavePreview(rawOptions: unknown): boolean {
  return (
    Array.isArray(rawOptions) &&
    rawOptions.some((option) => option && typeof option === 'object' && 'preview' in option && typeof option.preview === 'string' && option.preview.trim().length > 0)
  )
}

function parseCanonicalQuestionsInput(input: unknown): AskPrompt | null {
  if (!input || typeof input !== 'object' || !('questions' in input)) return null
  const rawQuestions = input.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue
    const text = 'question' in raw && typeof raw.question === 'string' ? raw.question : ''
    const rawOptions = 'options' in raw ? raw.options : undefined
    const options = parseOptions(rawOptions)
    if (text || options.length > 0) {
      const multiSelect = 'multiSelect' in raw ? raw.multiSelect === true : ('multiple' in raw && raw.multiple === true) || ('multi' in raw && raw.multi === true)
      questions.push({
        question: text,
        header: 'header' in raw && typeof raw.header === 'string' ? raw.header : undefined,
        multiSelect,
        options,
        ...(!multiSelect && askOptionsHavePreview(rawOptions) ? { hasPreviews: true as const } : {})
      })
    }
  }
  return questions.length > 0 ? { questions } : null
}

export function parseAskFromStatus(interactivePrompt: string | undefined | null): AskPrompt | null {
  if (!interactivePrompt) return null
  try {
    return parseCanonicalQuestionsInput(JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

/** Read the approval envelope published on PermissionRequest. 허용 = '1'(Claude·Codex 기본 TUI 승인 줄), 거부 = Esc. */
export function parseApprovalEnvelope(interactivePrompt: string | undefined | null): ChatApproval | null {
  if (!interactivePrompt) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('approval' in parsed)) return null
  const approval = parsed.approval
  if (typeof approval !== 'object' || approval === null || !('tool' in approval)) return null
  const tool = approval.tool
  if (typeof tool !== 'string' || tool.length === 0) return null
  const summary = 'summary' in approval ? approval.summary : undefined
  return { tool, ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}), allowSend: '1', denySend: ESCAPE }
}

export function parseInteractivePrompt(interactivePrompt: string | undefined | null): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt)
  if (prompt) return { kind: 'question', prompt }
  const approval = parseApprovalEnvelope(interactivePrompt)
  return approval ? { kind: 'approval', approval } : null
}

// ── 답 → 키 ──

/** Option indices in display order plus free text; selectors address stable numbers rather than labels. */
export type AskAnswerSelection = { indices: number[]; other?: string }
/** raw is verbatim PTY input; text goes through the paste path. */
export type AskAnswerKeyGroup = { raw: string } | { text: string }

function isAnswered(sel: AskAnswerSelection | undefined): boolean {
  return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0
}

function answerLabels(question: AskQuestion, sel: AskAnswerSelection | undefined): string[] {
  const labels = (sel?.indices ?? []).map((i) => question.options[i]?.label ?? '').filter((l) => l.length > 0)
  const other = (sel?.other ?? '').trim()
  return other ? [...labels, other] : labels
}

// Claude commits the highlighted default on Enter; pasted labels do not select it.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'
const ASK_PREVIEW_NOTES = 'n'

/** Claude 선택기: 단일 선택 숫자는 고르고 넘어감, 직접 입력은 "Type something" 줄 + Enter, 다중 선택은 숫자로 토글 후 다음 탭, 여러 질문이면 마지막 Submit 에서 Enter. */
export function buildAskAnswerKeys(prompt: AskPrompt, selections: AskAnswerSelection[]): AskAnswerKeyGroup[] {
  const questions = prompt.questions
  const multiQuestion = questions.length > 1
  const groups: AskAnswerKeyGroup[] = []

  questions.forEach((q, qi) => {
    const sel = selections[qi]
    const other = (sel?.other ?? '').trim()
    const typeSomething = String(q.options.length + 1)

    if (q.hasPreviews && (other || (sel?.indices.length ?? 0) > 0)) {
      const index = sel?.indices[0]
      if (index === 0 && other && q.options.length > 1) {
        // a note commits its row only once focus has moved, and row 1 starts focused.
        groups.push({ raw: '2' }, { raw: '1' })
      } else if (index !== undefined) {
        groups.push({ raw: String(index + 1) })
      }
      if (other) groups.push({ raw: ASK_PREVIEW_NOTES }, { text: other })
      groups.push({ raw: ASK_ENTER })
    } else if (q.multiSelect) {
      for (const i of sel?.indices ?? []) groups.push({ raw: String(i + 1) })
      if (other) groups.push({ raw: typeSomething }, { text: other }, { raw: ASK_ENTER })
      groups.push({ raw: ASK_NEXT_TAB })
    } else if (other) {
      groups.push({ raw: typeSomething }, { text: answerLabels(q, sel).join(', ') }, { raw: ASK_ENTER })
    } else if ((sel?.indices.length ?? 0) > 0) {
      groups.push({ raw: String(sel!.indices[0]! + 1) })
    } else if (multiQuestion) {
      groups.push({ raw: ASK_NEXT_TAB })
    }
  })

  const endsOnSubmitTab = multiQuestion || (questions.length === 1 && questions[0]!.multiSelect === true)
  if (endsOnSubmitTab && groups.length > 0) groups.push({ raw: ASK_ENTER })
  return groups
}

/** Codex commits on the final option digit; notes attach to the highlighted row. */
export function buildCodexAskAnswerKeys(prompt: AskPrompt, selections: AskAnswerSelection[]): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  let hasUnanswered = false
  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const selectedIndex = selection?.indices[0]
    const note = (selection?.other ?? '').trim()
    if (note) {
      const targetIndex = selectedIndex ?? question.options.length
      const rowCount = question.options.length + 1
      const nextSteps = targetIndex
      const previousSteps = rowCount - targetIndex
      const usePrevious = previousSteps < nextSteps
      const navigationKey = usePrevious ? ASK_PREVIOUS_ROW : ASK_NEXT_ROW
      const navigationSteps = usePrevious ? previousSteps : nextSteps
      for (let index = 0; index < navigationSteps; index += 1) groups.push({ raw: navigationKey })
      groups.push({ raw: ASK_NOTES }, { text: note }, { raw: ASK_ENTER })
      return
    }
    if (selectedIndex !== undefined) {
      groups.push({ raw: String(selectedIndex + 1) })
      return
    }
    hasUnanswered = true
    groups.push({ raw: '\x7f' })
    groups.push({ raw: questionIndex < prompt.questions.length - 1 ? ASK_NEXT_TAB : ASK_ENTER })
  })
  if (hasUnanswered) groups.push({ raw: ASK_ENTER })
  return groups
}

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}

/** 키 묶음 사이 간격(Orca NATIVE_CHAT_QUESTION_STEP_MS = Enter 0.5초 + 다음 질문이 그려질 0.5초). */
export const ASK_STEP_MS = 1000
/** 한 번에 보낼 키 묶음 수·글 길이 상한(main 이 다시 거른다). */
export const ASK_MAX_GROUPS = 64
export const ASK_MAX_TEXT = 4000
