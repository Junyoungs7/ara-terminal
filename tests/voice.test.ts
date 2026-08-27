/**
 * 음성 모드의 판단 규칙(2026-08-27 준영님 요청 — "아라야 라고 부르면 그때 반응").
 *
 * 이 검사가 지키는 것은 **언제 듣고 언제 멈추나** 하나다. 마이크·네트워크 없이 확인할 수 있는
 * 유일한 부분이고, 여기가 틀리면 말을 두 번 하게 되거나(너무 일찍 끊음) 마이크가 열린 채로
 * 붙잡힌다(안 끊음).
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_UTTER_MS,
  MIN_UTTER_MS,
  SILENCE_MS,
  WAKE_GRACE_MS,
  afterWake,
  bars,
  isStopPhrase,
  matchWake,
  normalizeHeard,
  rms,
  vadStep,
  wakePlan
} from '../src/shared/voice'

describe('깨우는 말', () => {
  it('띄어쓰기·문장부호가 어떻게 붙어도 알아듣는다', () => {
    for (const heard of ['아라야', '아라야,', '아라 야', ' 아라야! ', '어 아라야 있잖아']) {
      expect(matchWake(heard), heard).toBe(true)
    }
  })

  it('부르지 않았으면 깨지 않는다 — 이게 이 기능의 전부다', () => {
    for (const heard of ['오늘 날씨 좋네', '아라비아 숫자', '', '   ']) {
      expect(matchWake(heard), heard).toBe(false)
    }
    // '아라비아' 는 '아라' 를 품는다 — 짧은 깨우는 말을 고르면 이런 오작동이 는다는 근거.
    expect(matchWake('아라비아 숫자', '아라')).toBe(true)
  })

  it('★ 한 호흡에 말한 명령은 그대로 이어 받는다 — 두 번 말하게 하지 않는다', () => {
    expect(afterWake('아라야, KVT 에서 8000 포트 로그 보여줘')).toBe('KVT 에서 8000 포트 로그 보여줘')
    expect(afterWake('아라 야 프로세스 목록')).toBe('프로세스 목록')
    expect(afterWake('아라야')).toBe('') // 부르기만 했으면 빈 문자열 → 그 뒤를 기다린다
    expect(afterWake('그냥 혼잣말')).toBe('')
  })

  it('닫으라는 말은 섞여 있어도 받는다', () => {
    expect(isStopPhrase('그만')).toBe(true)
    expect(isStopPhrase('아 됐어')).toBe(true)
    expect(isStopPhrase('중지해 줘')).toBe(true)
    expect(isStopPhrase('그냥 계속해')).toBe(false)
  })

  it('정규화는 한글·영문·숫자만 남긴다', () => {
    expect(normalizeHeard('아라야, KVT #8000!')).toBe('아라야kvt8000')
  })
})

describe('★ 한 호흡 · 두 호흡 (2026-08-27 준영님 지적)', () => {
  it('두 호흡 — 부르기만 하면 대답하고 기다린다', () => {
    expect(wakePlan('아라야')).toEqual({ kind: 'ack' })
    expect(wakePlan('아라야.')).toEqual({ kind: 'ack' })
  })

  it('한 호흡 — 다 말했으면 대답 없이 바로 일한다', () => {
    expect(wakePlan('아라야, KVT 로그 보여줘')).toEqual({ kind: 'run', command: 'KVT 로그 보여줘' })
    expect(wakePlan('아라야 이거 해줘')).toEqual({ kind: 'run', command: '이거 해줘' })
  })

  it('부른 적 없으면 아무 일도 없다', () => {
    expect(wakePlan('오늘 점심 뭐 먹지')).toEqual({ kind: 'ignore' })
  })

  it('두 호흡의 둘째 마디는 그냥 명령이다 — 다시 부르지 않아도 된다', () => {
    // 깨어난 뒤에는 wakePlan 을 거치지 않는다. 들린 말이 곧 명령이고, 멈추는 규칙만 VAD 가 본다.
    expect(vadStep({ level: 0.2, spokenMs: 1500, silenceMs: SILENCE_MS, elapsedMs: 2600 })).toBe('send')
  })

  it('두 호흡인데 둘째 마디가 안 오면 조용히 도로 잠든다(아무것도 안 보낸다)', () => {
    expect(vadStep({ level: 0, spokenMs: 0, silenceMs: WAKE_GRACE_MS, elapsedMs: WAKE_GRACE_MS })).toBe('giveup')
  })
})

describe('언제 멈추나(VAD)', () => {
  const base = { level: 0, spokenMs: 0, silenceMs: 0, elapsedMs: 0 }

  it('말이 이어지는 동안은 계속 담는다', () => {
    expect(vadStep({ ...base, spokenMs: 1200, silenceMs: 120, elapsedMs: 1400 })).toBe('go')
  })

  it('★ 무음이 이어지면 보낸다 — 사람이 버튼을 안 눌러도 끝난다', () => {
    expect(vadStep({ ...base, spokenMs: 1200, silenceMs: SILENCE_MS, elapsedMs: 2100 })).toBe('send')
  })

  it('짧은 잡음은 말로 치지 않는다(문 닫는 소리·기침)', () => {
    expect(vadStep({ ...base, spokenMs: MIN_UTTER_MS - 50, silenceMs: SILENCE_MS, elapsedMs: 1500 })).toBe('giveup')
  })

  it('★ 상한에 걸리면 거기까지만 보낸다 — 마이크가 열린 채로 붙잡히지 않는다', () => {
    expect(vadStep({ ...base, spokenMs: 9000, silenceMs: 0, elapsedMs: MAX_UTTER_MS })).toBe('cut')
  })

  it('깨웠는데 아무 말이 없으면 도로 잠든다(아무것도 안 보낸다)', () => {
    expect(vadStep({ ...base, spokenMs: 0, silenceMs: 3000, elapsedMs: WAKE_GRACE_MS })).toBe('giveup')
    expect(vadStep({ ...base, spokenMs: 0, elapsedMs: WAKE_GRACE_MS - 500 })).toBe('go')
  })
})

describe('파형', () => {
  it('막대는 요청한 개수만큼, 0~1 로 나온다', () => {
    const freq = new Uint8Array(512).map((_, i) => (i < 60 ? 200 : 10))
    const b = bars(freq, 28)
    expect(b).toHaveLength(28)
    expect(Math.min(...b)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...b)).toBeLessThanOrEqual(1)
    // 로그 간격이라 낮은 대역(사람 목소리)이 왼쪽 막대에 몰린다 — 오른쪽이 늘 죽어 있으면 안 된다.
    expect(b[0]).toBeGreaterThan(b[27])
  })

  it('빈 입력에도 죽지 않는다', () => {
    expect(bars(new Uint8Array(0), 10)).toEqual([])
    expect(bars(new Uint8Array(64), 0)).toEqual([])
    expect(rms([])).toBe(0)
  })

  it('RMS 는 무음에서 0, 큰 소리에서 커진다', () => {
    expect(rms(new Uint8Array(128).fill(128))).toBe(0)
    expect(rms(new Uint8Array(128).map((_, i) => (i % 2 ? 255 : 0)))).toBeGreaterThan(0.9)
  })
})
