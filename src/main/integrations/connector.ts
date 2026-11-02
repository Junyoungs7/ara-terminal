// IN-02b 커넥터 이음새 — Orca `src/main/external-conversations/external-conversation-seam.ts` + `src/cli/specs/connector.ts`
// (start · send · prompt · answer · cancel · watch, orcaRef ec112c6b01)의 아라판. 밖의 대화(Slack 스레드 등)와 에이전트 탭을 잇는다.
// 운반(Slack Socket Mode)은 모른다 — 다른 사내 협업 툴도 이 틀에 꽂는다(키의 source 만 다르다).
// 화면·소켓·electron 을 import 하지 않는다(시험이 가짜 host 로 부른다).
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, parseInteractivePrompt, type AskAnswerKeyGroup } from '@shared/agentAsk'
import type { RunState } from '@shared/agentHooks'
import { isAgentId, type AgentId } from '@shared/agents'
import { maskSecrets } from '@shared/maskSecrets'

/** Orca ConversationKey — source 는 운반 이름('slack' …), externalId 는 그 운반 안의 대화(스레드) id. */
export type ConversationKey = { source: string; externalId: string }

/** Orca CONNECTOR_REFUSALS 중 아라에 맞는 것 + run_disabled(시작·이어 지시 스위치가 꺼짐). */
export type ConnectorRefusal =
  | 'run_disabled'
  | 'agent_not_reachable'
  | 'unsupported_agent'
  | 'launch_failed'
  | 'not_linked'
  | 'prompt_not_pending'
  | 'prompt_unsupported'
  | 'option_not_offered'
  | 'agent_asking'

/** accepted = 탭에 썼다(에이전트가 받았다는 뜻은 아니다 — Orca 같음). */
export type Delivery = { outcome: 'accepted'; sessionId: string; note?: 'idle' } | { outcome: 'refused'; reason: ConnectorRefusal; detail?: string }

export type ConnectorTab = { n: number; sessionId: string; label: string; agent: string; state: RunState | null; ask?: string }
export type ConnectorHost = {
  tabs(): ConnectorTab[]
  /** M11 카드 답 길(키 묶음, 1초 간격). */
  answer(sessionId: string, groups: AskAnswerKeyGroup[]): { ok: boolean }
  /** M3 안전 입력(첫 지시·채팅과 같은 길 — 입력 상자를 본 뒤 괄호 붙여넣기 → Enter). */
  followUp(sessionId: string, text: string): { ok: boolean }
  /** 앱의 [+] 와 같은 길(ara CLI agent.launch). worktree = 작업 단위 선택자(이름·id:·path:·branch:). */
  launch(req: { agent: AgentId; worktree: string; prompt: string }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>
  /** 탭 화면 글(턴 결과에 쓴다). */
  screen(sessionId: string): Promise<string>
}

export type AnswerChoice = 'allow' | 'deny' | number
/** Orca watch 의 prompt · turn-ended. key = 그 탭에 이어진 대화(없으면 null — 알림 채널로). */
export type ConversationEvent =
  | { kind: 'prompt'; key: ConversationKey | null; tab: ConnectorTab }
  | { kind: 'turn-ended'; key: ConversationKey | null; tab: ConnectorTab; lastOutput: string }

/** 턴 결과 상한 — Slack 글 하나에 넉넉히 들어가고 화면을 통째로 내보내지 않는 크기. */
export const TURN_RESULT_MAX_CHARS = 1500
const TURN_RESULT_MAX_LINES = 15
/** 같은 배달 id 를 기억하는 수(Slack 재전송 대비). 넘으면 오래된 것부터 잊는다. */
const RECEIPTS_MAX = 500
const ESCAPE = '\x1b'
// 토큰 모양(mcp-server-inspection 과 같은 것 + GitLab·Slack 앱 토큰). 상한 있는 반복만 — 긴 줄에서 백트래킹하지 않게.
const TOKEN = /\b(sk-[A-Za-z0-9_-]{12,200}|gh[pousr]_[A-Za-z0-9_]{12,200}|xox[abeprs]-[A-Za-z0-9-]{12,200}|xapp-[A-Za-z0-9-]{12,200}|glpat-[A-Za-z0-9_-]{12,200}|AKIA[A-Z0-9]{16})\b/g

/** 비밀 가리기 — 세션 로그와 같은 maskSecrets + 토큰 모양. */
export function redactSecrets(text: string): string {
  return maskSecrets(text).replace(TOKEN, '****')
}

/** 화면 글 → 턴 결과: 테두리·빈 줄을 빼고 뒤쪽 몇 줄, 길이 상한, 비밀 가림. */
export function turnResult(screen: string): string {
  const lines = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /[^\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝>›❯·•]/u.test(l))
  // ponytail: 화면 뒤쪽 줄 — 에이전트 입력 상자 안내 줄이 섞일 수 있다. Orca 처럼 Stop 훅의 last_assistant_message 를 싣게 되면 그걸로.
  const tail = redactSecrets(lines.slice(-TURN_RESULT_MAX_LINES).join('\n'))
  return tail.length > TURN_RESULT_MAX_CHARS ? `…${tail.slice(-TURN_RESULT_MAX_CHARS)}` : tail
}

export const conversationId = (k: ConversationKey): string => JSON.stringify([k.source, k.externalId])

/** 승인 또는 질문 하나·하나 고르기만 밖에서 답한다(Orca prompt: 나머지는 unsupported — 앱에서). */
export function answerableHere(tab: ConnectorTab): boolean {
  const card = parseInteractivePrompt(tab.ask)
  return card?.kind === 'approval' || (card?.kind === 'question' && card.prompt.questions.length === 1 && !card.prompt.questions[0]!.multiSelect)
}

export function createConnectorSeam(host: ConnectorHost, opts: { allowRun(): boolean }) {
  /** 대화 → 탭(sessionId). ponytail: 메모리만 — 아라를 다시 켜면 스레드 이음이 끊긴다(번호로는 계속 조종됨). Orca 는 작업 단위에 저장. */
  const links = new Map<string, { key: ConversationKey; sessionId: string }>()
  const receipts = new Map<string, Promise<Delivery>>()
  const last = new Map<string, { state: RunState | null; ask?: string }>()

  /** Orca receipts.run — 같은 대화·같은 배달 id 는 첫 답을 돌려준다(두 번 실행하지 않는다). */
  const once = (key: ConversationKey, deliveryId: string, run: () => Promise<Delivery>): Promise<Delivery> => {
    const id = JSON.stringify([conversationId(key), deliveryId])
    const seen = receipts.get(id)
    if (seen) return seen
    const p = run()
    receipts.set(id, p)
    if (receipts.size > RECEIPTS_MAX) receipts.delete(receipts.keys().next().value!)
    return p
  }
  const refused = (reason: ConnectorRefusal, detail?: string): Delivery => ({ outcome: 'refused', reason, ...(detail ? { detail } : {}) })
  const tabOf = (sessionId: string): ConnectorTab | null => host.tabs().find((t) => t.sessionId === sessionId) ?? null

  const seam = {
    tabs: (): ConnectorTab[] => host.tabs(),
    /** 대화에 이어진 탭(닫혔으면 null). */
    linked(key: ConversationKey): ConnectorTab | null {
      const l = links.get(conversationId(key))
      return l ? tabOf(l.sessionId) : null
    },
    keyOf(sessionId: string): ConversationKey | null {
      for (const l of links.values()) if (l.sessionId === sessionId) return l.key
      return null
    },

    answer(tab: ConnectorTab, choice: AnswerChoice): Delivery {
      const card = parseInteractivePrompt(tab.ask)
      if (!card) return refused('prompt_not_pending')
      let groups: AskAnswerKeyGroup[]
      if (card.kind === 'approval') {
        if (choice !== 'allow' && choice !== 'deny') return refused('option_not_offered')
        groups = [{ raw: choice === 'allow' ? card.approval.allowSend : card.approval.denySend }]
      } else {
        if (!answerableHere(tab)) return refused('prompt_unsupported')
        const q = card.prompt.questions[0]!
        if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 1 || choice > q.options.length) return refused('option_not_offered', String(q.options.length))
        const sel = [{ indices: [choice - 1] }]
        groups = tab.agent === 'codex' ? buildCodexAskAnswerKeys(card.prompt, sel) : buildAskAnswerKeys(card.prompt, sel)
      }
      return host.answer(tab.sessionId, groups).ok ? { outcome: 'accepted', sessionId: tab.sessionId } : refused('agent_not_reachable')
    },

    /** Orca connector start — 작업 단위에 에이전트 탭을 띄우고 첫 지시, 대화를 그 탭에 잇는다. */
    start(key: ConversationKey, deliveryId: string, req: { agent: string; worktree: string; prompt: string }): Promise<Delivery> {
      return once(key, deliveryId, async () => {
        if (!opts.allowRun()) return refused('run_disabled')
        if (!isAgentId(req.agent)) return refused('unsupported_agent')
        const r = await host.launch({ agent: req.agent, worktree: req.worktree, prompt: req.prompt })
        if (!r.ok) return refused('launch_failed', r.error)
        links.set(conversationId(key), { key, sessionId: r.sessionId })
        return { outcome: 'accepted', sessionId: r.sessionId }
      })
    },

    /** Orca connector send — 이어 지시. 답을 기다리는 탭에는 넣지 않는다(Orca 는 붙잡아 두고 답 뒤에 보냄 — 아라는 거절하고 먼저 답하게). */
    followUp(key: ConversationKey, deliveryId: string, tab: ConnectorTab | null, text: string): Promise<Delivery> {
      return once(key, deliveryId, async () => {
        if (!opts.allowRun()) return refused('run_disabled')
        if (!tab) return refused('not_linked')
        if (tab.state === 'blocked') return refused('agent_asking')
        if (!host.followUp(tab.sessionId, text).ok) return refused('agent_not_reachable')
        // 번호로 지시한 탭도 이 대화에 잇는다 — 턴 결과가 이 스레드로 온다.
        links.set(conversationId(key), { key, sessionId: tab.sessionId })
        return { outcome: 'accepted', sessionId: tab.sessionId }
      })
    },

    /** Orca connector cancel — 승인 대기면 거부, 질문 대기면 앱에서, 일하는 중이면 Esc 한 번, 쉬는 중이면 그대로. */
    cancel(key: ConversationKey, deliveryId: string, tab: ConnectorTab | null): Promise<Delivery> {
      return once(key, deliveryId, async () => {
        if (!tab) return refused('not_linked')
        const card = parseInteractivePrompt(tab.ask)
        if (card?.kind === 'approval') return seam.answer(tab, 'deny')
        if (card) return refused('prompt_unsupported')
        if (tab.state !== 'working') return { outcome: 'accepted', sessionId: tab.sessionId, note: 'idle' }
        return host.answer(tab.sessionId, [{ raw: ESCAPE }]).ok ? { outcome: 'accepted', sessionId: tab.sessionId } : refused('agent_not_reachable')
      })
    },

    /** Orca watch 의 한 번 훑기 — 바뀐 것만 이벤트로. 처음 본 탭은 기준만 잡는다. */
    async tick(): Promise<ConversationEvent[]> {
      const out: ConversationEvent[] = []
      const tabs = host.tabs()
      for (const tab of tabs) {
        const prev = last.get(tab.sessionId)
        last.set(tab.sessionId, { state: tab.state, ...(tab.ask ? { ask: tab.ask } : {}) })
        if (!prev) continue
        const key = seam.keyOf(tab.sessionId)
        if (tab.ask && tab.ask !== prev.ask) out.push({ kind: 'prompt', key, tab })
        else if (prev.state === 'working' && tab.state === 'idle') out.push({ kind: 'turn-ended', key, tab, lastOutput: turnResult(await host.screen(tab.sessionId)) })
      }
      // 보았다가 닫힌 탭은 잊는다(이음도). 막 띄워 아직 목록에 없는 탭의 이음은 남긴다.
      const open = new Set(tabs.map((t) => t.sessionId))
      for (const id of [...last.keys()].filter((id) => !open.has(id))) {
        last.delete(id)
        for (const [cid, l] of links) if (l.sessionId === id) links.delete(cid)
      }
      return out
    },

    reset(): void {
      last.clear()
    }
  }
  return seam
}
export type ConnectorSeam = ReturnType<typeof createConnectorSeam>
