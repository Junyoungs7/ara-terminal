/**
 * `ask_user` — **AI 가 사람에게 되묻는 길**(#125 1단계).
 *
 * 왜 필요한가(2026-08-24 실측): 헤드리스 Claude Code 에는 사람에게 되묻는 도구가 **없다**
 * (`AskUserQuestion`·`ExitPlanMode` 가 도구 목록에 안 들어온다 — 설계 §3.4c). "물어볼 사람이
 * 없다"는 전제로 도는 판이기 때문이다. 그래서 그 자리를 **우리가 만든다**: MCP 도구는 우리가
 * 정의하니 헤드리스에서도 완전히 동작한다.
 *
 * 준영님 질문에 대한 답이 이것이다 — *"대화형에서 1번/2번으로 물어보는 것"* 의 큰 몫이
 * 이 도구로 돌아온다. 다만 **Claude Code 의 프롬프트를 가져오는 게 아니라 아라의 것을 만드는** 길이다.
 *
 * 지키는 것 넷:
 *  ① **사람이 답할 때까지 기다린다**(도구 호출이 열린 채로). 그게 되묻기의 정의다.
 *  ② **한없이 기다리지 않는다** — 시간이 지나면 "답을 못 받았다"로 돌려준다. 모델이 영원히 멈추면
 *     대화가 죽고 프로세스가 남는다.
 *  ③ **한 번에 몇 개까지만.** 질문 폭탄(승인 피로 공격)을 막는다 — 승인 게이트의 rate limit 과 같은 결.
 *  ④ **선택지는 우리가 번호를 붙이지 않는다** — 화면이 버튼으로 그린다. 문자열 목록만 넘긴다.
 */
import { randomUUID } from 'node:crypto'

/** 화면에 올라가는 질문 한 건. */
export type AskRequest = {
  askId: string
  question: string
  /** 고를 것들. 빈 배열이면 자유 입력만 받는다. */
  options: string[]
  /** 여러 개 고를 수 있나. */
  multi: boolean
  /** 이 시각을 넘기면 시간 초과다(화면이 남은 시간을 보여 줄 수 있게 절대 시각으로 준다). */
  expiresAt: number
}

export type AskEmit = {
  ask: (r: AskRequest) => void
  /** 답이 왔거나 시간이 지나 목록에서 빠졌다 — 화면이 카드를 접는다. */
  askDone: (askId: string) => void
}

/** 기본 대기 시간. 승인(2분)보다 넉넉하다 — 사람이 생각해서 고르는 물음이다. */
export const ASK_TIMEOUT_MS = 5 * 60 * 1000
/** 동시에 열어 둘 수 있는 질문 수. 넘으면 거절한다(질문 폭탄 방지). */
export const ASK_MAX_PENDING = 3

export type AskUserManager = {
  /** 도구 핸들러가 부른다. 사람이 답하면 그 문자열, 시간이 지나면 null. */
  ask(o: { question: string; options?: string[]; multi?: boolean }): Promise<string | null>
  /** 화면이 답을 보낸다. 없는 id 는 조용히 버린다(늦게 온 답). */
  answer(askId: string, text: string): void
  /** 화면이 다시 그릴 때 쓰는 목록. */
  pending(): AskRequest[]
  /** 대화를 닫을 때 — 기다리는 것들을 모두 "답 못 받음"으로 닫는다(유령 대기 금지). */
  clear(): void
}

export function createAskUser(emit: AskEmit, timeoutMs: number = ASK_TIMEOUT_MS): AskUserManager {
  const waiting = new Map<string, { req: AskRequest; timer: NodeJS.Timeout; done: (t: string | null) => void }>()

  const finish = (askId: string, text: string | null): void => {
    const w = waiting.get(askId)
    if (!w) return
    clearTimeout(w.timer)
    waiting.delete(askId)
    emit.askDone(askId)
    w.done(text)
  }

  return {
    ask: ({ question, options = [], multi = false }) =>
      new Promise<string | null>((resolve) => {
        if (waiting.size >= ASK_MAX_PENDING) {
          resolve(null)
          return
        }
        const askId = randomUUID()
        const req: AskRequest = {
          askId,
          question: question.trim(),
          options: options.map((o) => o.trim()).filter((o) => o !== ''),
          multi,
          expiresAt: Date.now() + timeoutMs
        }
        const timer = setTimeout(() => finish(askId, null), timeoutMs)
        timer.unref?.()
        waiting.set(askId, { req, timer, done: resolve })
        emit.ask(req)
      }),

    answer: (askId, text) => finish(askId, text),

    pending: () => [...waiting.values()].map((w) => w.req),

    clear: () => {
      for (const id of [...waiting.keys()]) finish(id, null)
    }
  }
}
