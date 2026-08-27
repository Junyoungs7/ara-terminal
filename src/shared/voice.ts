// 음성 모드 — **판단만** 여기 있다(2026-08-27 준영님 요청: "아라야 라고 부르면 반응").
//
// 마이크·네트워크·화면은 전부 밖에 있고, 이 파일은 순수 함수뿐이라 검사가 쉽다. 음성 기능에서
// 제일 자주 깨지는 것이 **언제 듣기 시작하고 언제 멈추나**인데, 그 규칙이 여기 모여 있다.
//
// 소리가 어디까지 나가는지가 이 기능의 핵심이다(준영님: *"켜 있는 상태에서 모든 사운드를 다
// 처리하면 안 되잖아"*):
//   깨우는 말 판정 = **이 PC 안**(로컬 엔진). 그 전 소리는 저장도 전송도 하지 않는다.
//   깨어난 뒤의 **한 마디만** 받아쓰기로 보낸다 — 상시 스트리밍이 아니다.

export type VoiceState =
  /** 기능이 꺼져 있다(마이크를 아예 열지 않는다). */
  | 'off'
  /** 마이크는 열려 있지만 깨우는 말만 기다린다. 아무것도 밖으로 안 나간다. */
  | 'asleep'
  /** 깨어나서 한 마디를 담는 중. */
  | 'listening'
  /** 받아쓰기 + 아라 처리 중. */
  | 'thinking'
  /** 답을 읽어 주는 중. */
  | 'speaking'

/** 고를 수 있는 깨우는 말. 자유 입력을 받지 않는다 — 짧고 흔한 말은 오작동이 잦다. */
export const WAKE_WORDS = ['아라야', '아라', '헤이 아라'] as const
export type WakeWord = (typeof WAKE_WORDS)[number]
export const DEFAULT_WAKE: WakeWord = '아라야'

/** 말이 끝났다고 보는 무음 길이. 짧으면 말 중간에 끊기고, 길면 답이 굼떠 보인다. */
export const SILENCE_MS = 800
/** 한 마디의 상한. 여기까지 오면 그냥 끊고 보낸다(마이크가 열린 채로 붙잡히지 않게). */
export const MAX_UTTER_MS = 15_000
/** 이보다 짧으면 말이 아니라 잡음으로 본다(문 닫는 소리·기침). */
export const MIN_UTTER_MS = 350
/** 깨운 뒤 이 시간 동안 아무 말이 없으면 도로 잠든다. */
export const WAKE_GRACE_MS = 6_000

/** 말로 닫는 말. 답을 읽는 중에도 먹는다. */
export const STOP_WORDS = ['그만', '그만해', '멈춰', '됐어', '취소', '중지'] as const

/**
 * 비교용 정규화. 받아쓰기는 띄어쓰기·문장부호를 제멋대로 붙인다("아라야," / "아라 야") —
 * 한글·영문·숫자만 남기고 붙여 버린 뒤 비교한다.
 */
export function normalizeHeard(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-z가-힣]/g, '')
}

/** 들린 말에 깨우는 말이 들어 있나. */
export function matchWake(heard: string, wake: string = DEFAULT_WAKE): boolean {
  const w = normalizeHeard(wake)
  return w !== '' && normalizeHeard(heard).includes(w)
}

/**
 * 깨우는 말 **뒤에 붙은 명령**을 떼어 낸다.
 *
 * 사람은 "아라야" 하고 기다렸다 말하기도 하지만, 대개 *"아라야, KVT 로그 보여줘"* 처럼 한 호흡에
 * 말한다. 그때 뒷부분을 버리고 다시 물으면 두 번 말하게 된다 — 있으면 그대로 명령으로 쓴다.
 * 원문에서 잘라 내므로 띄어쓰기·문장부호는 살아 있다(받아쓰기 결과를 그대로 아라에게 준다).
 */
export function afterWake(heard: string, wake: string = DEFAULT_WAKE): string {
  const w = normalizeHeard(wake)
  if (w === '') return ''
  // 정규화한 문자열에서 찾은 위치를 원문 위치로 되돌린다(정규화가 글자를 지우기만 하므로
  // 원문을 훑으며 남는 글자를 세면 대응이 맞는다).
  const keep = /[0-9a-z가-힣]/
  let seen = ''
  for (let i = 0; i < heard.length; i++) {
    const ch = heard[i].toLowerCase()
    if (keep.test(ch)) seen += ch
    if (seen.endsWith(w)) return heard.slice(i + 1).replace(/^[\s,.!?~…]+/, '').trim()
  }
  return ''
}

/** 닫으라는 말인가. 다른 말에 섞여 있어도 받는다("아 그만" · "그만해"). */
export function isStopPhrase(heard: string): boolean {
  const n = normalizeHeard(heard)
  return n !== '' && STOP_WORDS.some((w) => n.includes(normalizeHeard(w)))
}

export type VadInput = {
  /** 지금 소리 크기 0~1(RMS). */
  level: number
  /** 말이 시작된 뒤 지난 시간(ms). 아직 말이 없었으면 0. */
  spokenMs: number
  /** 마지막으로 소리가 있고 나서 지난 시간(ms). */
  silenceMs: number
  /** 듣기 시작한 뒤 지난 전체 시간(ms). */
  elapsedMs: number
}

/**
 * 지금 멈춰야 하나.
 *  · `send`   — 말이 끝났다(무음이 충분히 이어졌다) → 담은 것을 보낸다
 *  · `cut`    — 상한에 걸렸다 → 거기까지만 보낸다
 *  · `giveup` — 깨웠는데 아무 말이 없었다 → 아무것도 안 보내고 도로 잠든다
 *  · `go`     — 계속 담는다
 */
export function vadStep(v: VadInput): 'go' | 'send' | 'cut' | 'giveup' {
  if (v.elapsedMs >= MAX_UTTER_MS) return v.spokenMs >= MIN_UTTER_MS ? 'cut' : 'giveup'
  if (v.spokenMs === 0) return v.elapsedMs >= WAKE_GRACE_MS ? 'giveup' : 'go'
  if (v.silenceMs < SILENCE_MS) return 'go'
  return v.spokenMs >= MIN_UTTER_MS ? 'send' : 'giveup'
}

/** 소리 크기(0~1) 판정 문턱. 마이크 게인 편차를 감안해 낮게 잡고, 짧은 잡음은 MIN_UTTER_MS 가 거른다. */
export const SPEECH_LEVEL = 0.045

/**
 * 주파수 스펙트럼 → 막대 높이(0~1) n 개. 준영님 선택 = **막대 파형**.
 *
 * 사람 목소리는 낮은 쪽(약 80~1000Hz)에 몰려 있어 전체 대역을 균등하게 나누면 오른쪽 절반이
 * 늘 죽어 있다. 그래서 **로그 간격**으로 뽑는다 — 막대가 고르게 살아 움직인다.
 */
export function bars(freq: Uint8Array | number[], n: number): number[] {
  const out: number[] = []
  const len = freq.length
  if (len === 0 || n <= 0) return out
  for (let i = 0; i < n; i++) {
    const a = Math.floor(Math.pow(i / n, 2) * len)
    const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 2) * len))
    let sum = 0
    for (let k = a; k < b && k < len; k++) sum += freq[k]
    out.push(Math.min(1, sum / (b - a) / 255))
  }
  return out
}

/** RMS(0~1) — 말이 있나 없나 판정용. bars 와 달리 시간영역 샘플을 받는다. */
export function rms(time: Uint8Array | number[]): number {
  let s = 0
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128
    s += v * v
  }
  return time.length ? Math.sqrt(s / time.length) : 0
}
