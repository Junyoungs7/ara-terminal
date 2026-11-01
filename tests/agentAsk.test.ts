// M11 질문/승인 카드(shared/agentAsk.ts). 승인 봉투 시험은 Orca native-chat-approval-envelope.test.ts(fdfcfb3551)에서 옮겼다(opencode 줄 뺌).
import { describe, expect, it } from 'vitest'
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, deriveInteractivePrompt, hasAskAnswer, parseApprovalEnvelope, parseInteractivePrompt, type AskPrompt } from '@shared/agentAsk'
import { applyHookEvent } from '@shared/agentHooks'

const ESC = String.fromCharCode(27)

describe('parseApprovalEnvelope (Orca 시험)', () => {
  it('reads tool and summary with the default TUI answer keys', () => {
    expect(parseApprovalEnvelope(JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } }))).toEqual({ tool: 'Bash', summary: 'rm -rf build', allowSend: '1', denySend: ESC })
  })
  it.each([
    ['missing', { tool: 'Edit' }],
    ['empty', { tool: 'Edit', summary: '' }],
    ['non-string', { tool: 'Edit', summary: 42 }]
  ])('omits a %s summary', (_label, approval) => {
    expect(parseApprovalEnvelope(JSON.stringify({ approval }))).not.toHaveProperty('summary')
  })
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['invalid JSON', '{bad'],
    ['a JSON primitive', '"approval"'],
    ['JSON null', 'null'],
    ['an array', '[]'],
    ['no approval', '{}'],
    ['a question envelope', JSON.stringify({ questions: [] })],
    ['a non-object approval', JSON.stringify({ approval: 'Bash' })],
    ['no tool', JSON.stringify({ approval: {} })],
    ['an empty tool', JSON.stringify({ approval: { tool: '' } })],
    ['a non-string tool', JSON.stringify({ approval: { tool: 7 } })]
  ])('returns null for %s', (_label, input) => {
    expect(parseApprovalEnvelope(input)).toBeNull()
  })
})

describe('훅 → 카드 글 → 카드', () => {
  it('AskUserQuestion 은 도구 입력 그대로, PermissionRequest 는 approval 봉투, post-tool·다른 이벤트는 없음', () => {
    const q = { questions: [{ question: 'Pick', options: ['a', { label: 'b', description: 'bee' }] }] }
    expect(deriveInteractivePrompt('AskUserQuestion', q, 'PreToolUse')).toBe(JSON.stringify(q))
    expect(deriveInteractivePrompt('AskUserQuestion', q, 'PostToolUse')).toBeUndefined()
    expect(deriveInteractivePrompt('Write', { file_path: '/a/b.ts', content: 'x' }, 'PermissionRequest')).toBe(JSON.stringify({ approval: { tool: 'Write', summary: '/a/b.ts' } }))
    expect(deriveInteractivePrompt('Bash', { command: 'ls' }, 'PreToolUse')).toBeUndefined()
    const card = parseInteractivePrompt(deriveInteractivePrompt('AskUserQuestion', q, 'PreToolUse'))
    expect(card).toEqual({ kind: 'question', prompt: { questions: [{ question: 'Pick', header: undefined, multiSelect: false, options: [{ label: 'a' }, { label: 'b', description: 'bee' }] }] } })
    expect(parseInteractivePrompt(JSON.stringify({ approval: { tool: 'Bash' } }))?.kind).toBe('approval')
  })

  it('applyHookEvent: 막힘에 글을 싣고, 막힘이 풀리면 지운다(자식 질문도 부모로)', () => {
    const blocked = applyHookEvent(null, 'claude', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'make' } }, 1)
    expect(blocked).toMatchObject({ state: 'blocked', kind: 'permission' })
    expect(blocked?.ask).toContain('"tool":"Bash"')
    const after = applyHookEvent(blocked, 'claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 2)
    expect(after?.state).toBe('working')
    expect(after?.ask).toBeUndefined()
    const child = applyHookEvent(null, 'claude', { hook_event_name: 'PreToolUse', agent_id: 'c1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?' }] } }, 3)
    expect(child).toMatchObject({ state: 'blocked', kind: 'question' })
    expect(parseInteractivePrompt(child?.ask)?.kind).toBe('question')
  })
})

describe('답 → TUI 키(Orca native-chat-ask-answer 규칙)', () => {
  const single: AskPrompt = { questions: [{ question: 'Q', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] }
  const multi: AskPrompt = { questions: [{ question: 'Q', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }] }
  const two: AskPrompt = { questions: [single.questions[0]!, { question: 'R', multiSelect: false, options: [{ label: 'X' }] }] }

  it('단일 선택 = 숫자 하나(고르면 넘어간다)', () => {
    expect(buildAskAnswerKeys(single, [{ indices: [1] }])).toEqual([{ raw: '2' }])
  })
  it('직접 입력 = "Type something" 줄 번호 + 글 + Enter', () => {
    expect(buildAskAnswerKeys(single, [{ indices: [], other: '내 답' }])).toEqual([{ raw: '3' }, { text: '내 답' }, { raw: '\r' }])
  })
  it('다중 선택 = 숫자로 토글 → 다음 탭 → Submit 에서 Enter', () => {
    expect(buildAskAnswerKeys(multi, [{ indices: [0, 2] }])).toEqual([{ raw: '1' }, { raw: '3' }, { raw: '\x1b[C' }, { raw: '\r' }])
  })
  it('여러 질문: 안 답한 질문은 건너뛰고 마지막에 Enter', () => {
    expect(buildAskAnswerKeys(two, [{ indices: [] }, { indices: [0] }])).toEqual([{ raw: '\x1b[C' }, { raw: '1' }, { raw: '\r' }])
    expect(hasAskAnswer(two, [{ indices: [] }, { indices: [] }])).toBe(false)
  })
  it('Codex: 숫자가 확정, 메모는 줄로 옮겨 Tab·글·Enter', () => {
    expect(buildCodexAskAnswerKeys(single, [{ indices: [1] }])).toEqual([{ raw: '2' }])
    expect(buildCodexAskAnswerKeys(single, [{ indices: [0], other: 'n' }])).toEqual([{ raw: '\t' }, { text: 'n' }, { raw: '\r' }])
  })
})
