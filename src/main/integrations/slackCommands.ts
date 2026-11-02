// M15 IN-02 · IN-02b Slack 명령 — 글 한 줄 → 커넥터 이음새(connector.ts) 호출 → 답 글. 소켓을 모른다(시험이 그대로 부른다).
// Orca 커넥터 명령(src/cli/specs/connector.ts)과 짝: 시작=start · 지시=send · 질문=prompt · 답=answer · 취소=cancel · (알림=watch, feature.ts).
// 대상 탭: 앞에 번호가 있으면 그 탭, 없으면 이 스레드에 이어진 탭(시작했거나 번호로 지시한 탭).
// git 쓰기(푸시·삭제 등) 명령은 없다. 시작·지시는 설정의 스위치가 켜져 있을 때만(connector.ts run_disabled).
import { parseInteractivePrompt } from '@shared/agentAsk'
import type { RunState } from '@shared/agentHooks'
import { answerableHere, type AnswerChoice, type ConnectorSeam, type ConnectorTab, type ConversationKey, type Delivery } from './connector'

export type SlackTab = ConnectorTab
/** key = 이 스레드(대화), deliveryId = 이 글(같은 글이 두 번 와도 한 번만 실행). */
export type SlackCtx = { key: ConversationKey; deliveryId: string }

const STATE_LABEL: Record<RunState, string> = { working: '일하는 중', blocked: '답을 기다림', idle: '쉬는 중' }

export const HELP_TEXT = [
  '*아라 명령*',
  '• `상태` — 에이전트 탭 목록과 상태',
  '• `질문` — 답을 기다리는 카드',
  '• `답 [번호] 허용|거부` — 승인 카드에 답',
  '• `답 [번호] <선택지 번호>` — 질문 카드(질문 하나·하나 고르기)에 답',
  '• `시작 <작업 단위> <claude|codex|gemini> <첫 지시>` — 새 에이전트 탭(설정에서 켠 경우만)',
  '• `지시 [번호] <글>` — 그 탭에 이어 지시(설정에서 켠 경우만)',
  '• `취소 [번호]` — 승인 대기면 거부, 일하는 중이면 멈춤(Esc)',
  '번호를 빼면 이 스레드에 이어진 탭. 푸시·삭제 같은 git 쓰기 명령은 없습니다.'
].join('\n')

/** Slack 글의 꾸밈을 벗긴다: 앞의 봇 멘션(<@U…>), 링크 꺾쇠(<url|글> → url), HTML 이스케이프, 앞뒤 빈칸. */
export function cleanSlackText(text: string): string {
  return text
    .replace(/^\s*<@[A-Z0-9]+>\s*/, '')
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
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
  lines.push(answerableHere(tab) ? `\`답 ${tab.n} <번호>\`` : '여러 질문·여러 선택은 아라에서 답하세요.')
  return lines.join('\n')
}

/** 턴 결과 글(connector turnResult 를 거친 것). */
export function describeTurnEnd(tab: SlackTab, lastOutput: string): string {
  return `*[${tab.n}] ${tab.label}* — 끝났습니다.${lastOutput ? `\n\`\`\`\n${lastOutput.replace(/```/g, "'''")}\n\`\`\`` : ''}`
}

const COMMANDS: Record<string, string> = {
  상태: 'status', status: 'status',
  질문: 'prompt', prompt: 'prompt', ask: 'prompt',
  답: 'answer', answer: 'answer',
  시작: 'start', start: 'start',
  지시: 'send', send: 'send',
  취소: 'cancel', cancel: 'cancel',
  도움: 'help', help: 'help'
}
const commandOf = (text: string): string | undefined => COMMANDS[(cleanSlackText(text).split(/\s+/)[0] ?? '').toLowerCase()]
/** 채널에선 명령 낱말로 시작하는 글에만 답한다(사람끼리 나누는 말에 도움말을 달지 않게). DM 은 늘 답한다. */
export const isSlackCommand = (text: string): boolean => commandOf(text) !== undefined

const REFUSAL: Record<string, string> = {
  run_disabled: '시작·지시는 꺼져 있습니다 — 아라 설정 › Slack 에서 켜야 합니다.',
  agent_not_reachable: '보내지 못했습니다 — 그 탭이 닫혔을 수 있습니다.',
  unsupported_agent: '에이전트는 claude·codex·gemini 중 하나입니다.',
  not_linked: '이 스레드에 이어진 탭이 없습니다. 번호를 붙이세요(`상태`로 확인).',
  prompt_not_pending: '지금 답을 기다리지 않습니다.',
  prompt_unsupported: '여러 질문·여러 선택은 아라에서 답하세요.',
  agent_asking: '이 탭은 답을 기다리는 중입니다 — 먼저 `답` 하세요.'
}

function say(tab: SlackTab | null, d: Delivery, ok: string): string {
  const head = tab ? `[${tab.n}] ` : ''
  if (d.outcome === 'accepted') return `${head}${ok}`
  if (d.reason === 'launch_failed') return `시작하지 못했습니다 — ${d.detail ?? ''}`
  if (d.reason === 'option_not_offered') return d.detail ? `${head}1~${d.detail} 중 번호를 고르세요.` : `${head}\`허용\` 또는 \`거부\``
  return `${head}${REFUSAL[d.reason] ?? d.reason}`
}

export async function runSlackCommand(raw: string, seam: ConnectorSeam, ctx: SlackCtx): Promise<string> {
  const text = cleanSlackText(raw)
  const cmd = commandOf(text)
  const rest = text.replace(/^\S+\s*/, '')
  const tabs = seam.tabs()
  // 앞 낱말이 탭 번호면 그 탭, 아니면 이 스레드에 이어진 탭.
  const target = (s: string): { tab: SlackTab | null; rest: string } => {
    const m = /^(\d+)(?:\s+([\s\S]*))?$/.exec(s)
    const byN = m ? tabs.find((t) => String(t.n) === m[1]) : undefined
    return byN ? { tab: byN, rest: m?.[2]?.trim() ?? '' } : { tab: seam.linked(ctx.key), rest: s }
  }

  if (cmd === 'status') {
    if (!tabs.length) return '열린 에이전트 탭이 없습니다.'
    return tabs.map((t) => `[${t.n}] ${t.label} — ${t.state ? STATE_LABEL[t.state] : '모름'}`).join('\n')
  }
  if (cmd === 'prompt') {
    const { tab } = target(rest)
    const cards = (tab ? [tab] : tabs).map(describeCard).filter((x): x is string => !!x)
    return cards.length ? cards.join('\n\n') : '답을 기다리는 카드가 없습니다.'
  }
  if (cmd === 'answer') {
    // `답 2 1` = 2번 탭에 1, `답 1` = 이어진 탭에 1(이어진 탭이 없으면 번호 탭으로 본다 — 옛 `답 <번호> 허용` 꼴).
    const words = rest.split(/\s+/).filter(Boolean)
    const linked = seam.linked(ctx.key)
    const tab = words.length >= 2 ? (tabs.find((t) => String(t.n) === words[0]) ?? null) : linked
    const pick = (words.length >= 2 ? words[1] : words[0])?.toLowerCase() ?? ''
    if (!tab) return words.length >= 2 ? '그 번호의 탭이 없습니다. `상태`로 번호를 확인하세요.' : REFUSAL['not_linked']!
    const choice: AnswerChoice | null = ['허용', 'allow', 'y', 'yes'].includes(pick) ? 'allow' : ['거부', 'deny', 'n', 'no'].includes(pick) ? 'deny' : /^\d+$/.test(pick) ? Number(pick) : null
    if (choice === null) return parseInteractivePrompt(tab.ask)?.kind === 'approval' ? `\`답 ${tab.n} 허용\` 또는 \`답 ${tab.n} 거부\`` : `\`답 ${tab.n} <번호>\``
    const d = seam.answer(tab, choice)
    const card = parseInteractivePrompt(tab.ask)
    const label = card?.kind === 'question' && typeof choice === 'number' ? `"${card.prompt.questions[0]?.options[choice - 1]?.label ?? choice}" 로 답했습니다.` : `${choice === 'allow' ? '허용' : '거부'}했습니다.`
    return say(tab, d, label)
  }
  if (cmd === 'start') {
    const m = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(rest)
    if (!m) return '`시작 <작업 단위> <claude|codex|gemini> <첫 지시>`'
    const d = await seam.start(ctx.key, ctx.deliveryId, { worktree: m[1]!, agent: m[2]!.toLowerCase(), prompt: m[3]!.trim() })
    return say(null, d, '시작했습니다 — 이 스레드에서 `지시 <글>`·`취소`, 턴이 끝나면 결과가 여기 옵니다.')
  }
  if (cmd === 'send') {
    const { tab, rest: body } = target(rest)
    if (!body) return '`지시 [번호] <글>`'
    return say(tab, await seam.followUp(ctx.key, ctx.deliveryId, tab, body), '보냈습니다 — 턴이 끝나면 결과가 이 스레드로 옵니다.')
  }
  if (cmd === 'cancel') {
    const { tab } = target(rest)
    const d = await seam.cancel(ctx.key, ctx.deliveryId, tab)
    return say(tab, d, d.outcome === 'accepted' && d.note === 'idle' ? '쉬는 중이라 그대로 둡니다.' : '취소했습니다.')
  }
  return HELP_TEXT
}
