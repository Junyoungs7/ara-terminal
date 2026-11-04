// 원격 3차 R4 — 원격 에이전트 탭의 채팅 보기. 서버 transcript 를 orcad read 요청(그 세션의 연결, 꼬리부터·바이트 오프셋 증분·상한)으로 읽어
// 로컬과 같은 파서(@shared/agentChat)로 민다. 경로는 서버 훅의 transcript_path(경로 검사는 orcad — claude-shared·accounts 아래 .jsonl 만).
// 변경 알림이 없으니 열린 채팅 화면만 1초마다 + 훅이 올 때 바로 읽는다(바뀐 게 없으면 빈 답 하나). 옛 orcad('unknown request')면 그 화면은 그만 묻는다.
import type { AgentId } from '@shared/agents'
import { createChatModel, DECODERS, takeLines, transcriptHint, type AgentChatEvent, type AgentChatSnapshot, type ChatModel, type TranscriptSlice } from '@shared/agentChat'

export const REMOTE_CHAT_POLL_MS = 1000

type Open = { offset: number | null; model: ChatModel; timer: ReturnType<typeof setInterval> | null; busy: boolean; again: boolean; dead: boolean; logged?: boolean }

export type RemoteChat = {
  /** 원격 탭(띄울 때·붙을 때) — 디코더. */
  bind(id: string, agent: AgentId): void
  has(id: string): boolean
  /** 서버 훅 페이로드 — transcript_path 를 기억하고, 열린 화면이면 바로 읽는다(/clear 뒤 새 파일이면 처음부터). */
  hook(id: string, payload: Record<string, unknown>): void
  open(id: string): Promise<AgentChatSnapshot>
  close(id: string): void
  forget(id: string): void
  stop(): void
}

export function createRemoteChat(deps: { read: (id: string, path: string, offset: number | null) => Promise<TranscriptSlice>; push: (e: AgentChatEvent) => void; pollMs?: number; log?: (msg: string) => void }): RemoteChat {
  const agents = new Map<string, AgentId>()
  const paths = new Map<string, string>()
  const open = new Map<string, Open>()
  const fresh = (id: string): ChatModel => createChatModel(undefined, DECODERS[agents.get(id) ?? 'claude'])

  /** 한 번 읽어 모델에 넣는다. 처음 읽기(offset null)의 메시지는 open 의 스냅숏으로 가므로 밀지 않는다. */
  const pull = async (id: string, o: Open, first = false): Promise<void> => {
    const path = paths.get(id)
    if (!path || o.dead) return
    if (o.busy) {
      o.again = true
      return
    }
    o.busy = true
    try {
      const r = await deps.read(id, path, o.offset)
      if (open.get(id) !== o || paths.get(id) !== path) return
      // 꼬리부터 다시 읽었으면(새 파일·줄어든 파일) 화면을 통째로 바꾼다.
      const reset = r.reset || o.offset === null
      if (r.reset) o.model = fresh(id)
      o.offset = r.next
      const added = o.model.add(takeLines('', r.text).lines)
      if (first) return
      if (reset) deps.push({ sessionId: id, messages: o.model.messages(), reset: true })
      else if (added.length) deps.push({ sessionId: id, messages: added })
    } catch (e) {
      // 왜 비었는지 남긴다(화면 하나에 한 번 — 1초마다 쌓이지 않게).
      if (!o.logged) {
        o.logged = true
        deps.log?.(`remote chat read ${id} ${path}: ${e instanceof Error ? e.message : String(e)}`)
      }
      // 옛 orcad 는 read 를 모른다 — 그 화면은 더 묻지 않는다. 끊김·경로 거절은 다음 차례에 다시(경로는 훅이 바꿀 수 있다).
      if (e instanceof Error && e.message === 'unknown request') o.dead = true
    } finally {
      o.busy = false
      if (o.again && open.get(id) === o) {
        o.again = false
        void pull(id, o)
      }
    }
  }

  const close = (id: string): void => {
    const o = open.get(id)
    if (o?.timer) clearInterval(o.timer)
    open.delete(id)
  }

  return {
    bind(id, agent) {
      agents.set(id, agent)
    },
    has: (id) => agents.has(id),
    hook(id, payload) {
      const path = transcriptHint(payload).path
      const o = open.get(id)
      if (path && paths.get(id) !== path) {
        paths.set(id, path)
        if (o) {
          // 새 파일(/clear·resume) — 처음부터(꼬리) 다시, 화면은 통째로 바꾼다.
          o.offset = null
          o.model = fresh(id)
        }
      }
      if (o) void pull(id, o)
    },
    async open(id) {
      close(id)
      const o: Open = { offset: null, model: fresh(id), timer: null, busy: false, again: false, dead: false }
      open.set(id, o)
      await pull(id, o, true)
      if (!o.dead && open.get(id) === o) o.timer = setInterval(() => void pull(id, o), deps.pollMs ?? REMOTE_CHAT_POLL_MS)
      return { messages: o.model.messages(), file: paths.get(id) ?? null }
    },
    close,
    forget(id) {
      close(id)
      agents.delete(id)
      paths.delete(id)
    },
    stop() {
      for (const id of [...open.keys()]) close(id)
    }
  }
}
