// W3 F16 아라 IPC 핸들러. 채널명은 shared/ipc.ts 계약과 일치한다.
// **키를 반환하는 핸들러가 없다** — 계약에 그런 채널이 없으므로 여기에도 만들 자리가 없다.
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { AiEnd } from '@shared/types'
import { AraSession, type AiPrefs, type KeyVault } from '../ai/AraSession'
import { pushSend } from '../util/windowPush'

// getWebContents: 창이 파괴된 뒤 도착하는 델타를 흘려보내기 위한 접근자(다른 도메인과 같은 패턴).
export function registerAiIpc(
  vault: KeyVault,
  getPrefs: () => AiPrefs,
  getWebContents: () => WebContents | null
): AraSession {
  const push = (channel: string, payload: unknown) => pushSend(getWebContents(), channel, payload)
  const ara = new AraSession(vault, getPrefs, {
    delta: (turnId, text) => push('ai:delta', { turnId, text }),
    end: (e: AiEnd) => push('ai:end', e)
  })

  handle('ai:getState', () => ara.getState())
  handle('ai:setKey', ({ key }) => ara.setKey(typeof key === 'string' ? key : ''))
  // setKey 와 같은 형태의 방어(보안 리뷰 L1) — text/context 는 문자열이 아니면 조용히 거절한다.
  // env 는 여기서 검증하지 않아도 안전하다: prompt.ts 의 normalizeEnv 가 어떤 값이 실려도
  // 화이트리스트 밖은 안전 기본값으로 떨어뜨리는 실제 관문이다(M1).
  handle('ai:send', (req) =>
    ara.send({
      text: typeof req.text === 'string' ? req.text : '',
      ...(typeof req.context === 'string' ? { context: req.context } : {}),
      ...(req.env ? { env: req.env } : {})
    })
  )
  handle('ai:cancel', () => {
    ara.cancel()
    return { ok: true } as const
  })
  handle('ai:clear', () => {
    ara.clear()
    return { ok: true } as const
  })
  return ara
}
