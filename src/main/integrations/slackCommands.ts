// M15 IN-02 Slack 명령 — 글 한 줄 → 답 글(+ 할 일). 화면·소켓을 모르는 순수 함수(시험이 그대로 부른다).
// Orca 커넥터 이음새(src/cli/specs/connector.ts)의 모양을 최소로 따랐다: prompt(무엇을 기다리나) · answer(승인 또는 질문 하나·단일 선택만,
// 그 밖은 "아라에서 답하세요") · watch(상태). **뺀 것**: start(새 에이전트 띄우기)·send(이어 지시)·cancel — 밖에서 실행을 시키는 명령은 넣지 않는다.
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, parseInteractivePrompt, type AskAnswerKeyGroup } from '@shared/agentAsk'
import type { RunState } from '@shared/agentHooks'

export type SlackTab = { n: number; sessionId: string; label: string; agent: string; state: RunState | null; ask?: string }
export type SlackReply = { text: string; answer?: { sessionId: string; groups: AskAnswerKeyGroup[] } }

const STATE_LABEL: Record<RunState, string> = { working: '일하는 중', blocked: '답을 기다림', idle: '쉬는 중' }

export const HELP_TEXT = [
  '*아라 명령*',
  '• `상태` — 에이전트 탭 목록과 상태',
  '• `질문` — 답을 기다리는 카드',
  '• `답 <번호> 허용|거부` — 승인 카드에 답',
  '• `답 <번호> <선택지 번호>` — 질문 카드(질문 하나·하나 고르기)에 답',
  '실행·푸시 같은 명령은 받지 않습니다.'
].join('\n')

/** Slack 글의 꾸밈을 벗긴다: 앞의 봇 멘션(<@U…>), 앞뒤 빈칸. */
export function cleanSlackText(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim()
}

export function describeCard(tab: SlackTab): string | null {
  const card = parseInteractivePrompt(tab.ask)
  if (!card) return null
  if (card.kind === 'approval') {
    const a = card.approval
    return `*[${tab.n}] ${tab.label}* — ${a.tool} 실행을 허용할까요?${a.summary ? `\n> ${a.summary}` : ''}\n\`답 ${tab.n} 허용\` · \`답 ${tab.n} 거부\``
  }
  const lines = [`*[${tab.n}] ${tab.label}* — 질문`]
  for (const q of card.prompt.questions) {
    lines.push(`> ${q.question}`)
    q.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}`))
  }
  lines.push(answerable(tab) ? `\`답 ${tab.n} <번호>\`` : '여러 질문·여러 선택은 아라에서 답하세요.')
  return lines.join('\n')
}

const answerable = (tab: SlackTab): boolean => {
  const card = parseInteractivePrompt(tab.ask)
  return card?.kind === 'question' && card.prompt.questions.length === 1 && !card.prompt.questions[0]!.multiSelect
}

const COMMANDS = new Set(['상태', 'status', '질문', 'prompt', 'ask', '답', 'answer', '도움', 'help'])
/** 채널에선 명령 낱말로 시작하는 글에만 답한다(사람끼리 나누는 말에 도움말을 달지 않게). DM 은 늘 답한다. */
export const isSlackCommand = (text: string): boolean => COMMANDS.has((cleanSlackText(text).split(/\s+/)[0] ?? '').toLowerCase())

export function runSlackCommand(raw: string, tabs: SlackTab[]): SlackReply {
  const [cmd = '', ...args] = cleanSlackText(raw).split(/\s+/)
  const c = cmd.toLowerCase()
  if (c === '상태' || c === 'status') {
    if (!tabs.length) return { text: '열린 에이전트 탭이 없습니다.' }
    return { text: tabs.map((t) => `[${t.n}] ${t.label} — ${t.state ? STATE_LABEL[t.state] : '모름'}`).join('\n') }
  }
  if (c === '질문' || c === 'prompt' || c === 'ask') {
    const cards = tabs.map(describeCard).filter((x): x is string => !!x)
    return { text: cards.length ? cards.join('\n\n') : '답을 기다리는 카드가 없습니다.' }
  }
  if (c === '답' || c === 'answer') {
    const tab = tabs.find((t) => String(t.n) === args[0])
    if (!tab) return { text: '그 번호의 탭이 없습니다. `상태`로 번호를 확인하세요.' }
    const card = parseInteractivePrompt(tab.ask)
    if (!card) return { text: `[${tab.n}] 은 지금 답을 기다리지 않습니다.` }
    const pick = (args[1] ?? '').toLowerCase()
    if (card.kind === 'approval') {
      const allow = ['허용', 'allow', 'y', 'yes'].includes(pick)
      const deny = ['거부', 'deny', 'n', 'no'].includes(pick)
      if (!allow && !deny) return { text: `\`답 ${tab.n} 허용\` 또는 \`답 ${tab.n} 거부\`` }
      return { text: `[${tab.n}] ${allow ? '허용' : '거부'}했습니다.`, answer: { sessionId: tab.sessionId, groups: [{ raw: allow ? card.approval.allowSend : card.approval.denySend }] } }
    }
    if (!answerable(tab)) return { text: '여러 질문·여러 선택은 아라에서 답하세요.' }
    const q = card.prompt.questions[0]!
    const i = Number(pick) - 1
    if (!Number.isInteger(i) || i < 0 || i >= q.options.length) return { text: `1~${q.options.length} 중 번호를 고르세요.` }
    const sel = [{ indices: [i] }]
    const groups = tab.agent === 'codex' ? buildCodexAskAnswerKeys(card.prompt, sel) : buildAskAnswerKeys(card.prompt, sel)
    return { text: `[${tab.n}] "${q.options[i]!.label}" 로 답했습니다.`, answer: { sessionId: tab.sessionId, groups } }
  }
  return { text: HELP_TEXT }
}
