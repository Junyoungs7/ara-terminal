import type { AiEngineEvent } from '@shared/aiEngine'
import type { AskRequest } from '../../main/mcp/askUser'

/**
 * 아라 대화 화면의 **심장**(#125) — 사건 흐름을 화면에 그릴 항목으로 접는다.
 *
 * 왜 순수 함수로 떼어 놓나: 이 접기 규칙이 화면의 성격을 정한다(준영님이 고른 **B+C 혼합** —
 * 도구는 접힌 묶음 한 줄, 되묻기는 알약 버튼). 규칙이 JSX 안에 섞이면 프로세스 없이는 못 고치고,
 * "도구 세 개가 왜 두 묶음으로 갈렸지" 같은 것을 눈으로만 확인하게 된다.
 *
 * 접는 규칙 넷:
 *  ① 잇따른 도구 호출은 **한 묶음**으로 — `session_list` → `disk.usage` 는 "도구 2개 썼습니다" 한 줄.
 *  ② 글이 오면 묶음이 닫힌다 — 다음 도구는 새 묶음이다(무엇을 하고 나서 무슨 말을 했는지가 남는다).
 *  ③ 이어지는 글 조각은 **한 말풍선**에 붙인다(스트리밍은 조각으로 온다).
 *  ④ 되묻기는 **항상 맨 아래 홀로** — 답할 것이 목록 중간에 묻히면 안 된다.
 */

export type ToolLine = { id: string; name: string; brief: string; ok: boolean | null }

export type ChatItem =
  /** 사람이 보낸 말. */
  | { k: 'me'; id: string; text: string }
  /** 아라가 한 말(조각이 이어 붙는다). */
  | { k: 'ai'; id: string; text: string }
  /** 도구 묶음 — 평소엔 한 줄로 접혀 있다. */
  | { k: 'tools'; id: string; lines: ToolLine[] }
  /** 되묻기 — 사람이 답해야 다음이 있다. */
  | { k: 'ask'; id: string; req: AskRequest }
  /** 상태 한 줄(열림·닫힘·오류·폴더 안내). */
  | { k: 'note'; id: string; text: string; tone: 'plain' | 'bad' }

let seq = 0
const nextId = (): string => `i${++seq}`

/** 마지막 항목이 그 종류면 돌려준다(붙일 자리 찾기). */
function tail<T extends ChatItem['k']>(items: ChatItem[], k: T): Extract<ChatItem, { k: T }> | null {
  const last = items[items.length - 1]
  return last && last.k === k ? (last as Extract<ChatItem, { k: T }>) : null
}

/** 엔진·되묻기 사건 하나 → 새 목록. **원본을 건드리지 않는다**(React 가 바뀐 걸 알아야 한다). */
export function reduceChat(items: ChatItem[], e: AiEngineEvent): ChatItem[] {
  switch (e.t) {
    case 'text': {
      const last = tail(items, 'ai')
      // ③ 조각을 한 말풍선에 붙인다.
      if (last) return [...items.slice(0, -1), { ...last, text: last.text + e.text }]
      return [...items, { k: 'ai', id: nextId(), text: e.text }]
    }

    case 'tool': {
      const line: ToolLine = { id: e.id, name: e.name, brief: e.brief, ok: null }
      const last = tail(items, 'tools')
      // ① 잇따른 호출은 같은 묶음으로.
      if (last) return [...items.slice(0, -1), { ...last, lines: [...last.lines, line] }]
      return [...items, { k: 'tools', id: nextId(), lines: [line] }]
    }

    case 'toolResult': {
      // 결과는 **그 도구 줄**에 표시한다 — 묶음이 이미 닫혔어도 뒤에서 찾아 올라간다.
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.k !== 'tools') continue
        const j = it.lines.findIndex((l) => l.id === e.id && l.ok === null)
        if (j < 0) continue
        const lines = [...it.lines]
        lines[j] = { ...lines[j], ok: e.ok, brief: lines[j].brief || e.brief }
        return [...items.slice(0, i), { ...it, lines }, ...items.slice(i + 1)]
      }
      return items
    }

    case 'ready':
      return [...items, { k: 'note', id: nextId(), text: noteReady(e.cwd, e.tools.length, e.model), tone: 'plain' }]

    case 'error':
      return [...items, { k: 'note', id: nextId(), text: e.message, tone: 'bad' }]

    // 턴 끝과 종료는 화면 아래 상태줄이 말한다 — 목록에 줄을 하나 더 쌓지 않는다.
    case 'turn':
    case 'permission':
    case 'exit':
      return items
  }
}

/** 사람이 보낸 말을 목록에 넣는다(보내는 즉시 — 답을 기다리는 동안 화면이 비면 안 된다). */
export function pushMine(items: ChatItem[], text: string): ChatItem[] {
  return [...items, { k: 'me', id: nextId(), text }]
}

/** 되묻기 도착. ④ 항상 맨 아래에 홀로 — 같은 질문이 두 번 오면 갱신만 한다. */
export function pushAsk(items: ChatItem[], req: AskRequest): ChatItem[] {
  const without = items.filter((i) => !(i.k === 'ask' && i.req.askId === req.askId))
  return [...without, { k: 'ask', id: 'ask-' + req.askId, req }]
}

/** 답했거나 시간이 지났다 — 카드를 접는다. */
export function dropAsk(items: ChatItem[], askId: string): ChatItem[] {
  return items.filter((i) => !(i.k === 'ask' && i.req.askId === askId))
}

/** 지금 답을 기다리는 질문(있으면 입력칸 대신 그걸 먼저 보여 준다). */
export function openAsk(items: ChatItem[]): AskRequest | null {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'ask') return (items[i] as { req: AskRequest }).req
  return null
}

function noteReady(cwd: string | null, tools: number, model: string | null): string {
  // 폴더가 없는 판 = API 키 엔진(#126). "? 에서 시작했습니다 · 도구 0개" 는 사실이지만 아무것도
  // 알려 주지 않는다 — **무엇을 못 하는지**를 말해 주는 편이 낫다.
  if (cwd === null) return `${model ?? 'API'} · 도구 없이 대화만 합니다`
  return `${cwd} 에서 시작했습니다 · 도구 ${tools}개`
}

/**
 * 숫자 키로 고르기. 1~9 만 받고, 그 자리에 선택지가 없으면 아무 일도 없다.
 * (되묻기 카드가 열려 있을 때만 호출된다 — 평소 숫자는 그냥 글자다.)
 */
export function pickByKey(key: string, options: readonly string[]): string | null {
  if (!/^[1-9]$/.test(key)) return null
  return options[Number(key) - 1] ?? null
}

/** 남은 시간 한 줄(`4:41 남음`). 지났으면 빈 문자열 — 카드가 곧 사라진다. */
export function remainText(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.floor((expiresAt - now) / 1000))
  if (s <= 0) return ''
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 남음`
}
