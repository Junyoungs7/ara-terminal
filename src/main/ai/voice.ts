// 음성 모드의 바깥 왕복 두 개 — **받아쓰기(말→글)** 와 **읽어 주기(글→말)**.
//
// 왜 main 에 있나: 키 때문이다. AraSession 의 불변식 1("API 키는 이 파일 밖으로 나가지 않는다")과
// 같은 선을 지킨다 — 렌더러는 오디오와 글자만 주고받고 키는 구경도 못 한다.
//
// **OpenAI 포맷만 쓴다.** 받아쓰기·읽어 주기는 프로바이더마다 계약이 제각각이라(앤트로픽·구글은
// 아예 없다) 여기서 갈래를 넷으로 늘리면 검증 못 한 길이 셋 생긴다. openai 키를 쓰고, 없으면
// compatible(사내 게이트웨이·Azure)로 떨어진다 — 둘 다 같은 와이어 포맷이다.
import { joinUrl, validateBaseUrl } from '@shared/aiBaseUrl'

const OPENAI_HOST = 'https://api.openai.com/v1'
/** 한 번 왕복 상한. 받아쓰기는 15초짜리 클립이라 이보다 오래 걸리면 뭔가 잘못된 것이다. */
const TIMEOUT_MS = 30_000
/** 읽어 줄 글의 상한. 답이 길면 앞부분만 읽고 나머지는 자막으로 본다(말로 5분을 듣지는 않는다). */
export const SPEAK_MAX_CHARS = 900

export type VoiceKeys = {
  /** openai 키(우선) 또는 compatible 키. 없으면 음성 기능 자체가 안 켜진다. */
  key: string
  /** compatible 일 때만. openai 면 undefined. */
  baseUrl?: string
}

export type VoiceFail = { ok: false; reason: 'noKey' | 'timeout' | 'http' | 'network'; message: string }
export type SttResult = { ok: true; text: string } | VoiceFail
export type TtsResult = { ok: true; audio: Buffer; mime: string } | VoiceFail

function baseOf(k: VoiceKeys): string {
  if (!k.baseUrl) return OPENAI_HOST
  const v = validateBaseUrl(k.baseUrl)
  if (!v.ok) throw new Error(v.message)
  return v.url.toString().replace(/\/+$/, '')
}

const fail = (reason: VoiceFail['reason'], message: string): VoiceFail => ({ ok: false, reason, message })

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T | VoiceFail> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    return await run(ac.signal)
  } catch (err) {
    const e = err as Error
    return e.name === 'AbortError' ? fail('timeout', '응답이 없습니다') : fail('network', e.message)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 말 → 글. 깨어난 뒤 담은 **클립 하나만** 보낸다(상시 스트리밍이 아니다 — 설계의 핵심).
 * 언어를 ko 로 못박는다: 짧은 클립은 언어 추정이 잘 틀리고, 틀리면 엉뚱한 로마자가 나온다.
 */
export async function transcribe(
  keys: VoiceKeys,
  audio: Buffer,
  mime = 'audio/webm',
  model = 'gpt-4o-mini-transcribe'
): Promise<SttResult> {
  if (!keys.key) return fail('noKey', 'API 키가 없습니다')
  return (await withTimeout(async (signal) => {
    const form = new FormData()
    // Buffer → Blob. 파일 이름은 확장자만 맞으면 된다(서버가 컨테이너를 그걸로 가른다).
    const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'mp4' : 'webm'
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `clip.${ext}`)
    form.append('model', model)
    form.append('language', 'ko')
    const res = await fetch(joinUrl(baseOf(keys), 'audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.key}` },
      body: form,
      signal
    })
    if (!res.ok) return fail('http', `받아쓰기 실패 (${res.status})`)
    const json = (await res.json()) as { text?: unknown }
    return { ok: true as const, text: typeof json.text === 'string' ? json.text.trim() : '' }
  })) as SttResult
}

/**
 * 글 → 말. 준영님 선택: **API 로 읽는다**(윈도우 내장 음성은 안 쓴다).
 * 돌아온 mp3 를 그대로 렌더러에 넘기고 재생은 화면 쪽이 한다.
 */
export async function speak(
  keys: VoiceKeys,
  text: string,
  voice = 'alloy',
  model = 'gpt-4o-mini-tts'
): Promise<TtsResult> {
  if (!keys.key) return fail('noKey', 'API 키가 없습니다')
  const body = text.slice(0, SPEAK_MAX_CHARS)
  if (body.trim() === '') return fail('http', '읽을 내용이 없습니다')
  return (await withTimeout(async (signal) => {
    const res = await fetch(joinUrl(baseOf(keys), 'audio/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${keys.key}` },
      body: JSON.stringify({ model, voice, input: body, response_format: 'mp3' }),
      signal
    })
    if (!res.ok) return fail('http', `읽어 주기 실패 (${res.status})`)
    return { ok: true as const, audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' }
  })) as TtsResult
}

/**
 * 답변 글에서 **읽을 부분만** 남긴다. 코드블록·표·URL 을 그대로 읽으면 30초 동안 기호를 듣는다.
 * 자막에는 원문이 그대로 남으므로 여기서 덜어 내도 잃는 것이 없다.
 */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' 코드는 화면으로 보여 드렸습니다. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' 링크 ')
    .replace(/[*_#>]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
