// M3 R2 — main 상태 원장(status.ts): 헤드리스 화면 판정 + 훅 + 첫 지시 전달(준비된 뒤 입력). 진짜 CLI 대신 화면 바이트를 흘린다.
import { afterEach, describe, expect, it } from 'vitest'
import { composerReady, createAgentStatusTracker, promptBytes, submitDelayMs, type AgentStatusTracker } from '../src/main/agents/status'
import { detectScreen } from '../src/shared/agentScreen'
import type { AgentStatusView } from '../src/shared/agentHooks'
import type { Session } from '../src/shared/types'

const RULE = '─'.repeat(40)
const meta = (id: string): Session => ({ id, type: 'local', title: 't', serverKey: 'localhost' }) as Session
const crlf = (...ls: string[]): Uint8Array => new TextEncoder().encode(ls.join('\r\n') + '\r\n')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('시간 초과')
    await sleep(20)
  }
}

describe('입력 상자 판정(첫 지시를 넣어도 되나)', () => {
  const ready = (agent: 'claude' | 'codex' | 'gemini', screen: string): boolean => composerReady(agent, { screen }, detectScreen(agent, { screen }))
  it('claude: 프롬프트 상자면 준비, 신뢰 확인(막힘)·셸 프롬프트면 아니다', () => {
    expect(ready('claude', ['Welcome to Claude Code', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n'))).toBe(true)
    expect(ready('claude', ['Do you trust the files in this folder?', '', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to cancel'].join('\n'))).toBe(false)
    expect(ready('claude', 'PS C:\\work> claude --dangerously-skip-permissions')).toBe(false)
  })
  it('codex: 현재 입력 줄 › 이 있고 신뢰 확인이 아니면 준비', () => {
    expect(ready('codex', ['>_ OpenAI Codex (v0.163.0)', '', '› Ask Codex to do anything', '', '  100% context left'].join('\n'))).toBe(true)
    expect(ready('codex', ['> You are in C:\\work', '', '  Do you trust the contents of this directory?', '', '› 1. Yes, continue', '  2. No, quit', '', '  Press enter to continue'].join('\n'))).toBe(false)
    expect(ready('codex', 'PS C:\\work> codex')).toBe(false)
  })
  it('gemini: 입력 상자 안내 문구', () => {
    expect(ready('gemini', ['╭────╮', '│ >   Type your message or @path/to/file │', '╰────╯'].join('\n'))).toBe(true)
    expect(ready('gemini', 'PS C:\\work> gemini --yolo')).toBe(false)
  })
})

describe('넣을 바이트', () => {
  const hard = '"따옴표" & 100% !x! ^\r\n둘째 줄'
  it('괄호 붙여넣기로 감싸 줄바꿈이 제출이 안 된다(글자는 그대로)', () => {
    expect(promptBytes('claude', hard, true)).toBe('\x1b[200~"따옴표" & 100% !x! ^\n둘째 줄\x1b[201~')
  })
  it('codex + Windows 는 줄바꿈을 Alt+Enter 로(입력 레코드)', () => {
    expect(promptBytes('codex', hard, true)).toBe('"따옴표" & 100% !x! ^\x1b\r둘째 줄')
    expect(promptBytes('codex', hard, false)).toContain('\x1b[200~')
  })
  it('Enter 까지 기다림은 길이에 비례', () => {
    expect(submitDelayMs('claude', 'a', true)).toBeGreaterThanOrEqual(500)
    expect(submitDelayMs('codex', 'a'.repeat(1000), true)).toBeGreaterThan(submitDelayMs('claude', 'a'.repeat(1000), true))
  })
})

describe('원장', () => {
  let t: AgentStatusTracker | null = null
  afterEach(() => {
    t?.exit('s1')
    t = null
  })
  const make = (promptTimeoutMs?: number): { pushed: AgentStatusView[]; written: string[] } => {
    const pushed: AgentStatusView[] = []
    const written: string[] = []
    t = createAgentStatusTracker({ push: (v) => pushed.push(v), write: (_id, d) => written.push(d), win: true, promptTimeoutMs })
    return { pushed, written }
  }

  it('화면만 있으면 추정 상태, 훅이 오면 훅 상태(자식 줄 포함)', async () => {
    const { pushed } = make()
    t!.track({ sessionId: 's1', agent: 'claude' })
    t!.data(meta('s1'), crlf('● Working', '', '✻ Thinking… (3s · esc to interrupt)', '', RULE, '❯ ', RULE))
    await until(() => pushed.length > 0)
    expect(pushed.at(-1)).toMatchObject({ sessionId: 's1', state: 'working', estimated: true })
    t!.hook({ source: 'claude', paneKey: 's1', payload: { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' } })
    t!.hook({ source: 'claude', paneKey: 's1', payload: { hook_event_name: 'Stop' } })
    expect(pushed.at(-1)).toMatchObject({ state: 'idle', estimated: false, source: 'hook:Stop' })
    expect(pushed.at(-1)?.children.map((c) => c.agentType)).toEqual(['Explore'])
    // 다른 칸 키의 훅은 아무 일도 안 한다.
    const n = pushed.length
    t!.hook({ source: 'claude', paneKey: 'other', payload: { hook_event_name: 'UserPromptSubmit' } })
    expect(pushed.length).toBe(n)
  })

  it('첫 지시: 셸 단계에서는 안 넣고, 입력 상자가 뜨고 잠잠해진 뒤 한 번만 넣고 Enter', async () => {
    const { written } = make()
    const prompt = '"따옴표" & 100% 확인\n둘째 줄'
    t!.track({ sessionId: 's1', agent: 'claude', prompt })
    t!.data(meta('s1'), crlf('PS C:\\work> & claude --dangerously-skip-permissions'))
    await sleep(700)
    expect(written).toEqual([]) // 셸에는 절대 안 친다
    t!.data(meta('s1'), crlf('Welcome to Claude Code', '', RULE, '❯ ', RULE, '  ? for shortcuts'))
    await until(() => written.length === 2, 4000)
    expect(written[0]).toBe(`\x1b[200~${prompt}\x1b[201~`)
    expect(written[1]).toBe('\r')
    // 다시 그려도 두 번 넣지 않는다.
    t!.data(meta('s1'), crlf(RULE, '❯ ', RULE))
    await sleep(700)
    expect(written).toHaveLength(2)
  })

  it('입력 상자가 끝내 안 보이면 넣지 않고 실패를 알린다', async () => {
    const { pushed, written } = make(300)
    t!.track({ sessionId: 's1', agent: 'codex', prompt: 'hi' })
    t!.data(meta('s1'), crlf("codex : The term 'codex' is not recognized"))
    await until(() => pushed.some((v) => v.promptFailed === true), 2000)
    expect(written).toEqual([])
  })
})
