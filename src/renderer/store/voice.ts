import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_UTTER_MS,
  SPEECH_LEVEL,
  bars as barsOf,
  isStopPhrase,
  rms,
  vadStep,
  wakePlan,
  type VoiceState
} from '@shared/voice'
import type { AraChatEvent } from '../../main/ai/AraChat'

// 음성 모드 — 마이크에서 아라까지의 한 바퀴(2026-08-27).
//
// **판단은 여기 없다.** 언제 듣고 언제 멈추나는 shared/voice.ts 의 순수 함수가 정하고(검사 18개),
// 이 파일은 그 판단을 마이크·네트워크·소리에 연결하기만 한다. 그래서 이 파일에는 상수도 규칙도
// 거의 없다 — 규칙이 두 곳에 있으면 화면과 검사가 갈라진다.
//
// 한 바퀴:
//   ① 깨우는 말(로컬) → ② 한 마디 녹음 → ③ 받아쓰기 → ④ 아라(지금 채팅과 **같은 길**) → ⑤ 읽어 주기
// ③④⑤ 만 밖으로 나간다. ①② 는 이 PC 안이다.

/** 막대 개수. 화면 폭에 맞춘 값이고, 너무 많으면 하나하나가 안 보인다. */
const BAR_COUNT = 40
/** 화면 갱신 주기. 60fps 로 리액트 상태를 흔들 이유가 없다(막대는 CSS 가 부드럽게 잇는다). */
const UI_MS = 50

export type VoiceUi = {
  state: VoiceState
  /** 0~1 막대 높이. 준영님 선택 = 막대 파형. */
  bars: number[]
  /** 내가 한 말(받아쓰기 결과). */
  heard: string
  /** 아라의 답 — 흐르는 대로 쌓인다. */
  answer: string
  /** 이번 턴에 쓴 도구 이름들(자막에 알약으로 붙는다). */
  tools: string[]
  error: string | null
}

const EMPTY: VoiceUi = { state: 'off', bars: [], heard: '', answer: '', tools: [], error: null }

export type VoiceOpts = {
  /** 설정에서 켰나. 끄면 마이크를 아예 열지 않는다. */
  enabled: boolean
  wakeWord: string
  ttsVoice: string
  /** 답을 소리로 읽을까. 끄면 자막만. */
  speakBack: boolean
  /** 깨우는 말을 알아들을 로컬 엔진. 없으면 단축키로만 연다. */
  makeWake?: () => Promise<WakeEngine | null>
}

/** 로컬 받아쓰기 엔진(깨우는 말 전용). 이 인터페이스 밖으로는 아무것도 나가지 않는다. */
export type WakeEngine = {
  /** 마이크 원본을 그대로 먹인다. 밖으로 보내지 않고 이 PC 안에서만 돈다. */
  feed(chunk: Float32Array, sampleRate: number): void
  /** 한 마디가 끝날 때마다 들린 글. */
  onText(cb: (text: string) => void): void
  dispose(): void
}

export function useVoiceMode(opts: VoiceOpts): {
  ui: VoiceUi
  /** 단축키·버튼으로 바로 듣기(깨우는 말 없이). */
  open: () => void
  /** 닫기 — 녹음을 버리고 잠으로 돌아간다. */
  close: () => void
} {
  const [ui, setUi] = useState<VoiceUi>(EMPTY)
  // 화면 밖 상태는 전부 ref 다 — 오디오 콜백은 1초에 수십 번 돈다(리렌더로 흘리면 안 된다).
  const st = useRef({
    state: 'off' as VoiceState,
    stream: null as MediaStream | null,
    ctx: null as AudioContext | null,
    analyser: null as AnalyserNode | null,
    tap: null as ScriptProcessorNode | null,
    rec: null as MediaRecorder | null,
    chunks: [] as Blob[],
    audio: null as HTMLAudioElement | null,
    wake: null as WakeEngine | null,
    startedAt: 0,
    spokeAt: 0,
    lastSound: 0,
    heard: '',
    answer: '',
    tools: [] as string[]
  })

  const patch = useCallback((p: Partial<VoiceUi>) => setUi((u) => ({ ...u, ...p })), [])
  const go = useCallback(
    (state: VoiceState, p: Partial<VoiceUi> = {}) => {
      st.current.state = state
      patch({ state, ...p })
    },
    [patch]
  )

  // ── 녹음 한 마디 ───────────────────────────────────────────────────────────
  const stopRec = useCallback((keep: boolean) => {
    const r = st.current.rec
    st.current.rec = null
    if (!r) return
    if (!keep) st.current.chunks = []
    if (r.state !== 'inactive') r.stop()
  }, [])

  /** 담은 클립을 밖으로 보낸다 — **여기서부터 PC 밖이다**. */
  const sendClip = useCallback(
    async (blob: Blob) => {
      go('thinking', { answer: '', tools: [], error: null })
      st.current.answer = ''
      st.current.tools = []
      const buf = new Uint8Array(await blob.arrayBuffer())
      const r = await window.ev?.voice.transcribe(buf, blob.type || 'audio/webm').catch(() => null)
      if (!r?.ok) {
        go('asleep', { error: r && !r.ok ? r.message : '받아쓰기에 실패했습니다' })
        return
      }
      const text = r.text.trim()
      if (text === '') {
        go('asleep')
        return
      }
      if (isStopPhrase(text)) {
        go('asleep', { heard: text })
        return
      }
      st.current.heard = text
      patch({ heard: text })
      // 아라에게는 **지금 채팅과 같은 길**로 보낸다 — 같은 도구, 같은 승인, 같은 기록.
      await window.ev?.ara.open().catch(() => null)
      await window.ev?.ara.send(text).catch(() => null)
    },
    [go, patch]
  )

  const startRec = useCallback(() => {
    const s = st.current
    if (!s.stream || s.rec) return
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const rec = new MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined)
    s.chunks = []
    s.startedAt = performance.now()
    s.spokeAt = 0
    s.lastSound = performance.now()
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) s.chunks.push(e.data)
    }
    rec.onstop = () => {
      const parts = s.chunks
      s.chunks = []
      // 담긴 게 없으면(불러 놓고 말이 없었다) 아무것도 보내지 않는다 — 조용히 잠으로.
      if (parts.length === 0) {
        if (s.state === 'listening') go('asleep')
        return
      }
      void sendClip(new Blob(parts, { type: parts[0].type || 'audio/webm' }))
    }
    rec.start(250)
    s.rec = rec
    go('listening', { heard: '', answer: '', tools: [], error: null })
  }, [go, sendClip])

  // ── 읽어 주기 ──────────────────────────────────────────────────────────────
  const speakOut = useCallback(
    async (text: string) => {
      if (!opts.speakBack || text.trim() === '') {
        go('asleep')
        return
      }
      go('speaking')
      const r = await window.ev?.voice.speak(text, opts.ttsVoice).catch(() => null)
      if (!r?.ok) {
        go('asleep', { error: r && !r.ok ? r.message : null })
        return
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(r.audio)], { type: r.mime }))
      const el = new Audio(url)
      st.current.audio = el
      const done = () => {
        URL.revokeObjectURL(url)
        st.current.audio = null
        if (st.current.state === 'speaking') go('asleep')
      }
      el.onended = done
      el.onerror = done
      void el.play().catch(done)
    },
    [go, opts.speakBack, opts.ttsVoice]
  )

  const shutUp = useCallback(() => {
    const el = st.current.audio
    if (el) {
      el.pause()
      st.current.audio = null
    }
  }, [])

  // ── 아라의 답을 받는다(채팅 패널이 쓰는 그 사건 흐름) ──────────────────────
  useEffect(() => {
    if (!opts.enabled) return
    const off = window.ev?.ara.onEvent((e: AraChatEvent) => {
      const s = st.current
      if (s.state !== 'thinking' && s.state !== 'speaking') return // 음성으로 물은 턴만 본다
      if (e.t === 'text') {
        s.answer += e.text
        patch({ answer: s.answer })
      } else if (e.t === 'tool') {
        if (!s.tools.includes(e.name)) {
          s.tools = [...s.tools, e.name]
          patch({ tools: s.tools })
        }
      } else if (e.t === 'turn') {
        const text = e.text || s.answer
        s.answer = text
        patch({ answer: text })
        void speakOut(text)
      } else if (e.t === 'error') {
        go('asleep', { error: e.message })
      }
    })
    return () => off?.()
  }, [opts.enabled, patch, speakOut, go])

  // ── 마이크 · 파형 · VAD ────────────────────────────────────────────────────
  useEffect(() => {
    if (!opts.enabled) {
      go('off', { ...EMPTY })
      return
    }
    let dead = false
    let timer: number | null = null

    const boot = async (): Promise<void> => {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
      } catch {
        go('off', { error: '마이크를 쓸 수 없습니다 — 윈도우 설정에서 이 앱의 마이크 권한을 켜 주세요' })
        return
      }
      if (dead) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const s = st.current
      s.stream = stream
      const ctx = new AudioContext()
      s.ctx = ctx
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 512
      an.smoothingTimeConstant = 0.72 // 막대가 튀지 않게 — 상용 서비스의 그 감촉이 여기서 난다
      src.connect(an)
      s.analyser = an

      // 깨우는 말 엔진에 **원본을 그대로** 먹인다(로컬). 없으면 단축키로만 열린다.
      if (opts.makeWake) {
        const wake = await opts.makeWake().catch(() => null)
        if (wake && !dead) {
          s.wake = wake
          const tap = ctx.createScriptProcessor(4096, 1, 1)
          tap.onaudioprocess = (e) => {
            if (st.current.state === 'off') return
            wake.feed(e.inputBuffer.getChannelData(0), ctx.sampleRate)
          }
          src.connect(tap)
          // ScriptProcessor 는 목적지에 붙어야 돈다. 소리를 내면 안 되므로 볼륨 0 으로 잇는다.
          const mute = ctx.createGain()
          mute.gain.value = 0
          tap.connect(mute)
          mute.connect(ctx.destination)
          s.tap = tap
          wake.onText((heard) => {
            const cur = st.current.state
            // 말하는 중에도 "그만" 이 먹는다(준영님 목업) — 로컬 엔진이 이미 듣고 있으니 공짜다.
            if (isStopPhrase(heard)) {
              shutUp()
              stopRec(false)
              go('asleep', { heard })
              return
            }
            if (cur !== 'asleep') return
            const plan = wakePlan(heard, opts.wakeWord)
            if (plan.kind === 'ignore') return
            if (plan.kind === 'ack') {
              // 부르기만 했다 → 짧게 대답하고 다음 말을 기다린다.
              chime(ctx)
              startRec()
            } else {
              // 한 호흡에 다 말했다 → 대답 없이 바로 처리한다.
              st.current.heard = plan.command
              patch({ heard: plan.command })
              void (async () => {
                go('thinking', { answer: '', tools: [], error: null })
                st.current.answer = ''
                st.current.tools = []
                await window.ev?.ara.open().catch(() => null)
                await window.ev?.ara.send(plan.command).catch(() => null)
              })()
            }
          })
        }
      }

      go('asleep')
      const time = new Uint8Array(an.fftSize)
      const freq = new Uint8Array(an.frequencyBinCount)
      timer = window.setInterval(() => {
        const cur = st.current
        an.getByteTimeDomainData(time)
        an.getByteFrequencyData(freq)
        const level = rms(time)
        // 잠자는 중에도 막대는 산다 — 마이크가 살아 있다는 유일한 신호다(다만 아주 낮게).
        const scale = cur.state === 'listening' ? 1 : cur.state === 'asleep' ? 0.35 : 0.6
        patch({ bars: barsOf(freq, BAR_COUNT).map((v) => v * scale) })

        if (cur.state !== 'listening') return
        const now = performance.now()
        if (level >= SPEECH_LEVEL) {
          cur.lastSound = now
          if (cur.spokeAt === 0) cur.spokeAt = now
        }
        const step = vadStep({
          level,
          spokenMs: cur.spokeAt ? now - cur.spokeAt : 0,
          silenceMs: now - cur.lastSound,
          elapsedMs: now - cur.startedAt
        })
        if (step === 'send' || step === 'cut') stopRec(true)
        else if (step === 'giveup') {
          stopRec(false)
          go('asleep')
        }
      }, UI_MS)
    }

    void boot()
    return () => {
      dead = true
      if (timer) clearInterval(timer)
      const s = st.current
      shutUp()
      stopRec(false)
      s.wake?.dispose()
      s.wake = null
      s.tap?.disconnect()
      s.tap = null
      s.stream?.getTracks().forEach((t) => t.stop())
      s.stream = null
      void s.ctx?.close().catch(() => {})
      s.ctx = null
      s.analyser = null
      st.current.state = 'off'
      setUi(EMPTY)
    }
    // wakeWord/ttsVoice 가 바뀌어도 마이크를 다시 열 이유는 없다 — 의존성을 enabled 하나로 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled])

  const open = useCallback(() => {
    if (st.current.state === 'asleep') startRec()
  }, [startRec])

  const close = useCallback(() => {
    shutUp()
    stopRec(false)
    if (st.current.state !== 'off') go('asleep', { error: null })
  }, [go, shutUp, stopRec])

  return { ui, open, close }
}

/**
 * 깨어났다는 짧은 소리. **API 를 부르지 않는다** — "네?" 를 매번 읽히면 왕복이 하나 더 붙고
 * 그만큼 늦다. 두 음(A5→E6)을 그 자리에서 만든다: 사람은 이 소리를 "듣고 있다"로 읽는다.
 */
function chime(ctx: AudioContext): void {
  const now = ctx.currentTime
  for (const [i, hz] of [880, 1318.5].entries()) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = hz
    g.gain.setValueAtTime(0, now + i * 0.08)
    g.gain.linearRampToValueAtTime(0.06, now + i * 0.08 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.22)
    osc.connect(g)
    g.connect(ctx.destination)
    osc.start(now + i * 0.08)
    osc.stop(now + i * 0.08 + 0.24)
  }
}

export { MAX_UTTER_MS }
