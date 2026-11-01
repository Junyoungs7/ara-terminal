// M15 IN-02 Slack Socket Mode — 사내 Slack 앱에 **나가는 연결만** 연다(받는 포트 없음, 결정 :113).
// 1) apps.connections.open(app-level 토큰 xapp-) → wss 주소 2) WebSocket 으로 붙어 봉투마다 envelope_id 로 바로 받았다고 답한다
// 3) events_api 의 message 만 넘긴다(봇·고친 글 등 subtype 은 버림) 4) 'disconnect' 봉투·끊김이면 다시 붙는다(1→30초).
// 글 올리기는 Slack 의 chat 글 올리기 API(bot 토큰 xoxb-). 토큰은 이 파일 밖으로 나가지 않는다.
import WebSocket from 'ws'
import type { SlackLink } from '@shared/integrations'

export type SlackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ json(): Promise<unknown> }>

export type SlackMessage = { user: string; channel: string; channelType: string; text: string; ts: string; threadTs?: string }

const TIMEOUT_MS = 15_000
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000
/** 다시 붙어도 소용없는 오류 — 사람이 토큰·앱 설정을 고쳐야 한다. */
const FATAL = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'not_allowed_token_type', 'missing_scope'])

export type SlackSocket = {
  stop(): void
  post(channel: string, text: string, threadTs?: string): Promise<boolean>
}

export function startSlackSocket(deps: {
  fetch: SlackFetch
  appToken: string
  botToken: string
  onLink(link: SlackLink, error?: string): void
  onMessage(m: SlackMessage): void
  /** 시험용 — 모의 서버 주소. */
  apiBase?: string
}): SlackSocket {
  const api = deps.apiBase ?? 'https://slack.com/api'
  let stopped = false
  let current: WebSocket | null = null
  let retry = RETRY_MIN_MS
  let timer: ReturnType<typeof setTimeout> | null = null

  const callApi = async (method: string, token: string, body?: unknown): Promise<{ ok?: boolean; error?: string; url?: string }> => {
    try {
      const res = await deps.fetch(`${api}/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      return ((await res.json()) ?? {}) as { ok?: boolean; error?: string; url?: string }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'network' }
    }
  }

  const later = (error?: string): void => {
    if (stopped) return
    deps.onLink('connecting', error)
    timer = setTimeout(() => void connect(), retry)
    retry = Math.min(retry * 2, RETRY_MAX_MS)
  }

  const connect = async (): Promise<void> => {
    timer = null
    if (stopped) return
    deps.onLink('connecting')
    const r = await callApi('apps.connections.open', deps.appToken)
    if (stopped) return
    if (!r.ok || !r.url) {
      if (FATAL.has(r.error ?? '')) return deps.onLink('error', r.error)
      return later(r.error)
    }
    const ws = new WebSocket(r.url)
    current = ws
    ws.on('message', (data) => {
      let env: { envelope_id?: string; type?: string; payload?: { event?: Record<string, unknown> } }
      try {
        env = JSON.parse(String(data))
      } catch {
        return
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }))
      if (env.type === 'hello') {
        retry = RETRY_MIN_MS
        deps.onLink('connected')
      } else if (env.type === 'disconnect') {
        ws.close()
      } else if (env.type === 'events_api') {
        const ev = env.payload?.event
        if (!ev || ev['type'] !== 'message' || ev['subtype'] || ev['bot_id']) return
        const str = (k: string): string => (typeof ev[k] === 'string' ? (ev[k] as string) : '')
        if (!str('user') || !str('channel')) return
        deps.onMessage({ user: str('user'), channel: str('channel'), channelType: str('channel_type'), text: str('text'), ts: str('ts'), ...(str('thread_ts') ? { threadTs: str('thread_ts') } : {}) })
      }
    })
    ws.on('close', () => {
      if (current === ws) current = null
      later()
    })
    ws.on('error', () => {
      /* close 가 뒤따른다 */
    })
  }

  // 돌려준 뒤에 시작한다 — 부른 쪽이 첫 onLink 전에 이 객체를 쥐고 있게.
  queueMicrotask(() => void connect())
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      current?.close()
      current = null
      deps.onLink('off')
    },
    async post(channel, text, threadTs) {
      const r = await callApi('chat.postMessage', deps.botToken, { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      return r.ok === true
    }
  }
}
