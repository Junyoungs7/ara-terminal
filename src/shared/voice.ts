// 2.1 음성(Gemini Live) — main·렌더러·시험이 같이 보는 값과 순수 함수.
//
// 결정은 agent_talk/PLAN-v2-voice.md. 여기에 없는 것:
//  · API 키 — vault(`ai.apiKey.google`)에서 main 안에서만 꺼낸다(main/voice/LiveClient).
//  · bypass(승인 생략) — **저장하지 않는다.** 앱을 다시 켜면 꺼져 있어야 해서 main 메모리 값이다
//    (main/ipc/registerVoiceIpc). 그래서 VoicePrefs 에 칸이 없고, voiceOf 가 들어온 값을 버린다.

export const VOICE_FACES = ['photo', 'plexus', 'none'] as const
export type VoiceFace = (typeof VOICE_FACES)[number]

export const VOICE_SPEEDS = ['slow', 'normal', 'fast'] as const
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number]

export const VOICE_LISTEN = ['ptt', 'always'] as const
export type VoiceListen = (typeof VOICE_LISTEN)[number]

export const VOICE_CAPTION_LINES = [1, 2, 3] as const

/** 대화 기록 보관. 'off' = 안 남김, 숫자 = 그 날수 지나면 정리, '0' = 무제한(로그 보존과 같은 선택지). */
export const VOICE_KEEP = ['off', '7', '30', '90', '0'] as const
export type VoiceKeep = (typeof VOICE_KEEP)[number]

/**
 * 목소리 — 이름은 Gemini prebuilt 이름 그대로(speech-generation 문서), 설명은 문서의 한 낱말을 한국어로.
 * 문서에 성별 표기는 없다. 시안의 "차분한 여성"은 Kore 에 준영님이 붙인 말이라 Kore 만 그대로 둔다.
 * ponytail: 30개 중 고른 8개. 더 필요하면 이 표에 줄만 더한다(이름은 문서 표기 그대로).
 */
export const VOICES: readonly { name: string; ko: string }[] = [
  { name: 'Kore', ko: '차분한 여성' },
  { name: 'Aoede', ko: '산뜻한' },
  { name: 'Leda', ko: '젊은' },
  { name: 'Zephyr', ko: '밝은' },
  { name: 'Sulafat', ko: '따뜻한' },
  { name: 'Charon', ko: '또렷한 안내' },
  { name: 'Puck', ko: '경쾌한' },
  { name: 'Orus', ko: '단단한' }
]

export type VoicePrefs = {
  enabled: boolean
  face: VoiceFace
  voiceName: string
  speed: VoiceSpeed
  /** 빈 문자열 = 기본 장치. */
  inputDeviceId: string
  listen: VoiceListen
  captionLines: 1 | 2 | 3
  keep: VoiceKeep
}

export const DEFAULT_VOICE: VoicePrefs = {
  enabled: true,
  face: 'photo',
  voiceName: 'Kore',
  speed: 'normal',
  inputDeviceId: '',
  listen: 'ptt',
  captionLines: 2,
  keep: '7'
}

const pick = <T>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d)

/** 신뢰 경계 밖(파일·렌더러) 값을 확정값으로. 모르는 칸(bypass 포함)은 버린다. */
export function voiceOf(raw: unknown): VoicePrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_VOICE.enabled,
    face: pick(VOICE_FACES, o.face, DEFAULT_VOICE.face),
    voiceName: pick(
      VOICES.map((v) => v.name),
      o.voiceName,
      DEFAULT_VOICE.voiceName
    ),
    speed: pick(VOICE_SPEEDS, o.speed, DEFAULT_VOICE.speed),
    inputDeviceId: typeof o.inputDeviceId === 'string' ? o.inputDeviceId.slice(0, 200) : '',
    listen: pick(VOICE_LISTEN, o.listen, DEFAULT_VOICE.listen),
    captionLines: pick(VOICE_CAPTION_LINES, o.captionLines, DEFAULT_VOICE.captionLines),
    keep: pick(VOICE_KEEP, o.keep, DEFAULT_VOICE.keep)
  }
}

/** 화면 상태 글자. muted 는 렌더러만 안다(마이크를 안 보낼 뿐 연결은 그대로). */
export type VoiceStatus = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

/** main → 렌더러 사건(`voice:event`). 키·URL 은 어떤 모양으로도 실리지 않는다. */
export type VoiceEvent =
  | { t: 'status'; status: VoiceStatus; reason?: string }
  | { t: 'audio'; pcm: Uint8Array }
  /** 끼어들기 — 재생 큐를 즉시 비운다. */
  | { t: 'interrupted' }
  | { t: 'caption'; who: 'me' | 'ara'; text: string }
  /** 한 차례가 끝났다(자막 줄 끊기). */
  | { t: 'turnEnd' }

// ── 비용 (voice-research-done.md · 3.8 Live, 100만 토큰당 달러) ──
export const LIVE_PRICE = { textIn: 0.75, audioIn: 3, textOut: 4.5, audioOut: 12 } as const
/** 토큰 메타데이터가 없을 때 쓰는 시간당 추정(마이크 60분 + 발화 15~20분). */
export const LIVE_HOURLY_USD = [0.6, 0.7] as const

export type VoiceTokens = { textIn: number; audioIn: number; textOut: number; audioOut: number }
export type VoiceUsage = { month: string; seconds: number; tokens: VoiceTokens }

export const emptyTokens = (): VoiceTokens => ({ textIn: 0, audioIn: 0, textOut: 0, audioOut: 0 })

/** 추정 비용(달러) — 토큰이 하나라도 있으면 그걸로 한 값, 없으면 시간×단가 범위. */
export function voiceCost(u: Pick<VoiceUsage, 'seconds' | 'tokens'>): { by: 'tokens' | 'time'; low: number; high: number } {
  const k = u.tokens
  if (k.textIn + k.audioIn + k.textOut + k.audioOut > 0) {
    const usd =
      (k.textIn * LIVE_PRICE.textIn + k.audioIn * LIVE_PRICE.audioIn + k.textOut * LIVE_PRICE.textOut + k.audioOut * LIVE_PRICE.audioOut) /
      1_000_000
    return { by: 'tokens', low: usd, high: usd }
  }
  const h = u.seconds / 3600
  return { by: 'time', low: h * LIVE_HOURLY_USD[0], high: h * LIVE_HOURLY_USD[1] }
}

/** 이 PC 시간대의 달(`2026-10`) — 청구 달과 하루 어긋날 수 있다(추정치라 맞춘다고 얻는 게 없다). */
export function monthOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
