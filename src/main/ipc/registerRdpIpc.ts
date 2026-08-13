// rdp 도메인 IPC — 앱 내장 RDP(F25)의 릴레이 수명만 맡는다.
//
// 2026-08-09: OS 클라이언트 외부 실행(`rdp:launch`, W4sat F21)을 통째로 걷어냈다. F25 로 더블클릭이
// 내장 뷰가 된 뒤 UI 진입점이 사라져 죽은 채널이었고, 준영님이 "mstsc 를 쓸 이유가 없다"로 닫았다(A-40).
// 되살릴 일이 생기면 git 이력에서 rdpLaunch.ts 를 꺼내면 된다 — 인자 화이트리스트까지 붙어 있었다.
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { pushSend } from '../util/windowPush'
import { handle } from './handle'
import type { ProfileStore } from '../secrets/ProfileStore'
import { startRdpRelay, type RdpRelayHandle } from '../rdp/RdpRelay'
import { closeRdpSpanWindow, listDisplays, openRdpSpanWindow, rdpSpanPlan } from '../rdp/RdpWindows'

// 살아 있는 릴레이. 세션당 하나이고, 렌더러가 닫거나 앱이 끝나면 정리한다.
const relays = new Map<string, RdpRelayHandle>()
// 릴레이가 왜 끝났는지. push 는 클라이언트 오류와 경합해 늦게 도착할 수 있어, relayStop 응답으로도
// 확정적으로 돌려준다(렌더러는 실패 직후 이 값을 읽는다).
const lastReason = new Map<string, string>()
let relaySeq = 0

export function stopAllRdpRelays(): void {
  for (const r of relays.values()) r.close()
  relays.clear()
}

export function registerRdpIpc(profiles: ProfileStore, getWebContents?: () => WebContents | null): void {
  // F25 앱 내장 RDP: 프로필로만 대상을 정한다(렌더러는 host/port 를 말할 수 없다).
  handle('rdp:relay', async ({ profileId }) => {
    const profile = profiles.get(profileId)
    if (!profile) return { ok: false as const, message: '프로필을 찾을 수 없습니다.' }
    if (profile.type !== 'rdp') return { ok: false as const, message: 'RDP 프로필이 아닙니다.' }
    const relayId = `rdp-relay:${(relaySeq += 1)}`
    try {
      const handle = await startRdpRelay({
        host: profile.host,
        port: profile.port,
        // 릴레이 쪽 실패(TCP·TLS·프로토콜)는 클라이언트엔 "general error" 로만 보인다 —
        // 실제 사유를 렌더러로 올려 사용자가 원인을 알 수 있게 한다.
        onClosed: (reason) => {
          relays.delete(relayId)
          if (reason) {
            lastReason.set(relayId, reason)
            pushSend(getWebContents?.() ?? null, 'rdp:relayClosed', { relayId, reason })
          }
        }
      })
      relays.set(relayId, handle)
      // 저장해 둔 비밀번호가 있으면 함께 내려 준다(없으면 렌더러가 입력받는다). vault 참조가
      // 끊긴 경우(orphanSecret)도 "없음"으로 떨어뜨려 입력 화면으로 보낸다 — 여기서 실패시키면
      // 사용자가 비밀번호를 다시 저장할 방법 없이 막힌다.
      const secret = profile.secretRef ? profiles.lookupSecret(profile) : null
      return {
        ok: true as const,
        relayId,
        url: handle.url,
        token: handle.token,
        destination: `${profile.host}:${profile.port}`,
        username: profile.username,
        ...(secret?.ok && secret.secret ? { password: secret.secret } : {})
      }
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) }
    }
  })

  // 다중 모니터: 모니터 목록 → 렌더러가 고름 → 감싸는 자리에 창 하나.
  handle('rdp:displays', () => ({ displays: listDisplays() }))

  handle('rdp:openSpan', ({ profileId, name, displayIds }) => {
    const profile = profiles.get(profileId)
    if (!profile) return { ok: false as const, message: '프로필을 찾을 수 없습니다.' }
    if (profile.type !== 'rdp') return { ok: false as const, message: 'RDP 프로필이 아닙니다.' }
    // 창 제목은 프로필 이름으로 고정한다 — 렌더러가 준 name 을 그대로 쓰면 창 제목에 임의 문자열이 들어간다.
    return openRdpSpanWindow(profileId, profile.name || name, displayIds, () => {
      const wc = getWebContents?.() ?? null
      return wc ? BrowserWindow.fromWebContents(wc) : null
    })
  })

  handle('rdp:spanPlan', ({ profileId }) => ({ plan: rdpSpanPlan(profileId) }))

  handle('rdp:closeSpan', ({ profileId }) => {
    closeRdpSpanWindow(profileId)
    return { ok: true as const }
  })

  handle('rdp:relayStop', ({ relayId }) => {
    relays.get(relayId)?.close()
    relays.delete(relayId)
    const reason = lastReason.get(relayId)
    lastReason.delete(relayId)
    return reason ? { ok: true as const, reason } : { ok: true as const }
  })
}
