// Gemini Live(BidiGenerateContent) 메시지 — 만들기·읽기만 하는 순수 함수(소켓·키를 모른다).
// 모양은 ai.google.dev/api/live (2026-10 확인): 클라이언트는 setup·realtimeInput·clientContent·toolResponse 중 하나,
// 서버는 setupComplete·serverContent·toolCall·toolCallCancellation·goAway·sessionResumptionUpdate 중 하나 + usageMetadata.
import type { VoiceSpeed, VoiceTokens } from '@shared/voice'

export const LIVE_MODEL = 'gemini-3.8-live'
const LIVE_HOST = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** 🔴 키가 든 URL — 로그·사건·오류 문구 어디에도 싣지 않는다. 소켓을 여는 한 줄에서만 쓴다. */
export const liveUrl = (key: string): string => `${LIVE_HOST}?key=${encodeURIComponent(key)}`

const SPEED_LINE: Record<VoiceSpeed, string> = {
  slow: '말은 천천히, 또박또박 해 주세요.',
  normal: '말은 보통 빠르기로 또렷하게 해 주세요.',
  fast: '말은 조금 빠르게, 군더더기 없이 해 주세요.'
}

/** 시스템 지시 — 한국어 고정(네이티브 오디오는 languageCode 를 안 받는다, live-guide). */
export function systemText(speed: VoiceSpeed, callName: string): string {
  return [
    '당신은 아라(A.R.A), 사내 서버 관리 터미널의 음성 비서입니다.',
    '항상 한국어로, 짧게 말로 답하세요. 목록·코드·표는 읽어 주지 말고 요점만 말하세요.',
    callName ? `사용자를 "${callName}"(이)라고 부르세요.` : '',
    SPEED_LINE[speed]
  ]
    .filter(Boolean)
    .join('\n')
}

export type SetupOpts = { voiceName: string; speed: VoiceSpeed; callName?: string; handle?: string | null }

export function buildSetup(o: SetupOpts): Record<string, unknown> {
  return {
    setup: {
      model: `models/${LIVE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voiceName } } }
      },
      systemInstruction: { parts: [{ text: systemText(o.speed, o.callName ?? '') }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      // 처음엔 빈 객체(핸들 발급만 요청), 재접속 땐 받은 핸들.
      sessionResumption: o.handle ? { handle: o.handle } : {}
      // 다음 라운드(도구): 여기에 tools: [{ functionDeclarations }] 가 붙는다.
    }
  }
}

export const audioMsg = (base64: string): Record<string, unknown> => ({
  realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } }
})

/** 누르고 말하기를 뗐다 — 서버 VAD 에게 "마이크 끝"을 알린다. */
export const audioEndMsg = (): Record<string, unknown> => ({ realtimeInput: { audioStreamEnd: true } })

export const textTurnMsg = (text: string): Record<string, unknown> => ({
  clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true }
})

export type LiveIn =
  | { t: 'setupComplete' }
  | { t: 'audio'; data: string }
  | { t: 'inText'; text: string }
  | { t: 'outText'; text: string }
  | { t: 'interrupted' }
  | { t: 'generationComplete' }
  | { t: 'turnComplete' }
  | { t: 'goAway'; timeLeftMs: number | null }
  | { t: 'resume'; handle: string | null }
  | { t: 'usage'; tokens: VoiceTokens }
  // 이번 라운드는 도구를 선언하지 않아 오지 않는다 — 오면 이름만 알린다(다음 라운드 자리).
  | { t: 'toolCall'; ids: string[] }
  | { t: 'toolCancel'; ids: string[] }

/** protobuf Duration JSON("1.5s") → ms. 모양이 아니면 null. */
export function durationMs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v)
  return m ? Math.round(Number(m[1]) * 1000) : null
}

type Detail = { modality?: string; tokenCount?: number }
function sumTokens(details: unknown, audioKey: 'audioIn' | 'audioOut', textKey: 'textIn' | 'textOut', into: VoiceTokens): void {
  if (!Array.isArray(details)) return
  for (const d of details as Detail[]) {
    const n = typeof d?.tokenCount === 'number' ? d.tokenCount : 0
    if (d?.modality === 'AUDIO') into[audioKey] += n
    else into[textKey] += n
  }
}

/** 서버 프레임(문자열 또는 바이트 — 서버는 JSON 을 바이너리 프레임으로도 보낸다) → 사건 목록. 깨진 프레임은 []. */
export function parseServer(frame: string | ArrayBuffer | Uint8Array): LiveIn[] {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(typeof frame === 'string' ? frame : new TextDecoder().decode(frame))
  } catch {
    return []
  }
  if (!j || typeof j !== 'object') return []
  const out: LiveIn[] = []
  if (j.setupComplete) out.push({ t: 'setupComplete' })
  const sc = j.serverContent as Record<string, unknown> | undefined
  if (sc) {
    if (sc.interrupted === true) out.push({ t: 'interrupted' })
    const it = (sc.inputTranscription as { text?: unknown } | undefined)?.text
    if (typeof it === 'string' && it) out.push({ t: 'inText', text: it })
    const parts = (sc.modelTurn as { parts?: unknown } | undefined)?.parts
    if (Array.isArray(parts)) {
      for (const p of parts as { inlineData?: { data?: unknown; mimeType?: unknown } }[]) {
        const d = p?.inlineData?.data
        if (typeof d === 'string' && d) out.push({ t: 'audio', data: d })
      }
    }
    const ot = (sc.outputTranscription as { text?: unknown } | undefined)?.text
    if (typeof ot === 'string' && ot) out.push({ t: 'outText', text: ot })
    if (sc.generationComplete === true) out.push({ t: 'generationComplete' })
    if (sc.turnComplete === true) out.push({ t: 'turnComplete' })
  }
  const ga = j.goAway as { timeLeft?: unknown } | undefined
  if (ga) out.push({ t: 'goAway', timeLeftMs: durationMs(ga.timeLeft) })
  const ru = j.sessionResumptionUpdate as { newHandle?: unknown; resumable?: unknown } | undefined
  if (ru) out.push({ t: 'resume', handle: ru.resumable === true && typeof ru.newHandle === 'string' && ru.newHandle ? ru.newHandle : null })
  const tc = j.toolCall as { functionCalls?: { id?: unknown }[] } | undefined
  if (tc) out.push({ t: 'toolCall', ids: (tc.functionCalls ?? []).map((f) => String(f?.id ?? '')) })
  const tx = j.toolCallCancellation as { ids?: unknown[] } | undefined
  if (tx) out.push({ t: 'toolCancel', ids: (tx.ids ?? []).map(String) })
  const um = j.usageMetadata as Record<string, unknown> | undefined
  if (um) {
    const tokens: VoiceTokens = { textIn: 0, audioIn: 0, textOut: 0, audioOut: 0 }
    sumTokens(um.promptTokensDetails, 'audioIn', 'textIn', tokens)
    sumTokens(um.responseTokensDetails, 'audioOut', 'textOut', tokens)
    // 세부가 없고 합계만 오면 글자 단가로 센다(보수적으로 낮게 — 오디오 단가가 4배 비싸다).
    if (tokens.textIn + tokens.audioIn === 0 && typeof um.promptTokenCount === 'number') tokens.textIn = um.promptTokenCount
    if (tokens.textOut + tokens.audioOut === 0 && typeof um.responseTokenCount === 'number') tokens.textOut = um.responseTokenCount
    out.push({ t: 'usage', tokens })
  }
  return out
}

/** 서버가 닫은 이유 문구에서 키처럼 보이는 것을 지운다(문구는 화면·로그로 간다). */
export function safeReason(s: string): string {
  return s
    .replace(/key=[^&\s]+/gi, 'key=***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '***')
    .slice(0, 200)
}
