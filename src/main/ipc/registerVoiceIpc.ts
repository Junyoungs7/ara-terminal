// 음성 모드 IPC — 받아쓰기·읽어 주기 두 개뿐이다.
//
// **키는 여기서 한 발짝도 안 나간다**(registerAiIpc 의 주석과 같은 선): 렌더러는 오디오와 글자만
// 주고받고, 키를 읽는 채널은 계약에 존재하지 않는다. `voice:ready` 도 "쓸 수 있나"만 답한다.
//
// 어느 키를 쓰나: 받아쓰기·읽어 주기는 **OpenAI 포맷**이라 openai 키를 먼저 보고, 없으면
// compatible(사내 게이트웨이·Azure)로 떨어진다. 앤트로픽·구글 키만 있으면 음성은 못 켠다 —
// 그 사실을 설정 화면이 그 자리에서 말한다.
import { handle } from './handle'
import { aiKeyVaultId, type KeyVault } from '../ai/AraSession'
import { speak, speakable, transcribe, type VoiceKeys } from '../ai/voice'

export type VoiceDeps = {
  vault: KeyVault
  /** compatible 프로바이더의 baseUrl(설정에서 사용자가 넣은 값). openai 키가 있으면 안 쓴다. */
  getCompatibleBaseUrl: () => string
}

function keysOf(d: VoiceDeps): VoiceKeys {
  const openai = d.vault.get(aiKeyVaultId('openai'))
  if (openai) return { key: openai }
  const compat = d.vault.get(aiKeyVaultId('compatible'))
  const base = d.getCompatibleBaseUrl()
  return compat && base ? { key: compat, baseUrl: base } : { key: '' }
}

export function registerVoiceIpc(deps: VoiceDeps): void {
  handle('voice:ready', () => {
    const k = keysOf(deps)
    return k.key ? { ok: true } : { ok: false, why: 'noKey' as const }
  })

  handle('voice:transcribe', async ({ audio, mime }) => {
    const buf = Buffer.from(audio instanceof Uint8Array ? audio : new Uint8Array())
    // 빈 클립은 왕복을 만들지 않는다(무음만 담겼을 때 돈을 쓸 이유가 없다).
    if (buf.byteLength < 1024) return { ok: false as const, reason: 'empty', message: '들린 말이 없습니다' }
    const r = await transcribe(keysOf(deps), buf, typeof mime === 'string' ? mime : 'audio/webm')
    return r.ok ? { ok: true as const, text: r.text } : { ok: false as const, reason: r.reason, message: r.message }
  })

  handle('voice:speak', async ({ text, voice }) => {
    // 코드블록·표·URL 은 덜어 내고 읽는다 — 자막에는 원문이 그대로 남는다.
    const body = speakable(typeof text === 'string' ? text : '')
    const r = await speak(keysOf(deps), body, typeof voice === 'string' && voice ? voice : 'alloy')
    return r.ok
      ? { ok: true as const, audio: new Uint8Array(r.audio), mime: r.mime }
      : { ok: false as const, reason: r.reason, message: r.message }
  })
}
