// 2.1 음성 — 화면 쪽 상태 하나(패널은 화면에 하나뿐이다). 연결·키는 main 이 쥐고, 여기는
// 마이크를 열어 조각을 보내고 받은 소리를 틀고 자막을 모은다.
import { useSyncExternalStore } from 'react'
import { DEFAULT_VOICE, type VoiceEvent, type VoicePrefs, type VoiceStatus } from '@shared/voice'
import { openMic, Player, type MicHandle } from '../voice/audio'

export type Caption = { who: 'me' | 'ara'; text: string; done: boolean }

export type VoiceView = {
  open: boolean
  status: VoiceStatus
  reason: string
  /** Google 키가 없어 시작하지 못했다. */
  noKey: boolean
  muted: boolean
  /** 누르고 말하기 키를 누르고 있다. */
  talking: boolean
  captions: Caption[]
  /** 승인 생략 — main 메모리 값의 거울. */
  bypass: boolean
}

const CAPTION_KEEP = 20

let view: VoiceView = { open: false, status: 'off', reason: '', noKey: false, muted: false, talking: false, captions: [], bypass: false }
let prefs: VoicePrefs = DEFAULT_VOICE
let mic: MicHandle | null = null
const player = new Player()
const subs = new Set<() => void>()
let wired = false

function set(p: Partial<VoiceView>): void {
  view = { ...view, ...p }
  subs.forEach((f) => f())
}

/** 자막 조각을 잇는다 — 같은 사람이 이어 말하면 그 줄에 붙이고, 차례가 끝났거나 사람이 바뀌면 새 줄. */
export function addCaption(list: Caption[], who: 'me' | 'ara', text: string): Caption[] {
  const last = list[list.length - 1]
  const next = last && last.who === who && !last.done ? [...list.slice(0, -1), { ...last, text: last.text + text }] : [...list, { who, text, done: false }]
  return next.slice(-CAPTION_KEEP)
}

function onEvent(e: VoiceEvent): void {
  switch (e.t) {
    case 'status':
      set({ status: e.status, reason: e.reason ?? '' })
      if (e.status === 'error' || e.status === 'off') closeMic()
      return
    case 'audio':
      player.push(e.pcm)
      return
    case 'interrupted':
      player.clear()
      return
    case 'caption': {
      // 상대가 말을 시작하면 앞 사람 줄은 끝난 것이다.
      const list = view.captions.map((c) => (c.who !== e.who ? { ...c, done: true } : c))
      set({ captions: addCaption(list, e.who, e.text) })
      return
    }
    case 'turnEnd':
      set({ captions: view.captions.map((c) => ({ ...c, done: true })) })
      return
  }
}

function wire(): void {
  if (wired || !window.ev?.voice) return
  wired = true
  window.ev.voice.onEvent(onEvent)
  window.ev.voice.onBypass((bypass) => set({ bypass }))
  void window.ev.voice
    .state()
    .then((s) => set({ bypass: s.bypass }))
    .catch(() => {})
}

const sending = (): boolean => !view.muted && (prefs.listen === 'always' || view.talking)

function closeMic(): void {
  mic?.stop()
  mic = null
}

export async function openVoice(): Promise<void> {
  wire()
  if (view.open) return
  set({ open: true, status: 'connecting', reason: '', noKey: false, muted: false, talking: false, captions: [] })
  const r = await window.ev.voice.start().catch(() => ({ ok: false as const, reason: 'noKey' as const }))
  if (!r.ok) {
    set({ status: 'error', noKey: true })
    return
  }
  try {
    const m = await openMic(prefs.inputDeviceId, (pcm) => sending() && window.ev.voice.audio(pcm), () => {})
    if (!view.open) m.stop()
    else mic = m
  } catch {
    set({ status: 'error', reason: 'mic' })
    void window.ev.voice.stop()
  }
}

export function closeVoice(): void {
  closeMic()
  player.clear()
  set({ open: false, talking: false })
  void window.ev?.voice?.stop()
}

export const toggleVoice = (): void => (view.open ? closeVoice() : void openVoice())

export function toggleMute(): void {
  set({ muted: !view.muted })
}

export function pttDown(): void {
  if (!view.open || view.talking) return
  // 말하는 도중에 누르면 그 말을 끊는 것이 사람의 뜻이다 — 서버 VAD 를 기다리지 않고 바로 멈춘다.
  player.clear()
  set({ talking: true })
}

export function pttUp(): void {
  if (!view.talking) return
  set({ talking: false })
  if (!view.muted) window.ev.voice.audioEnd()
}

/** 설정이 바뀌면 MainArea 가 넣는다. 듣는 방식·장치는 다음 연결부터. */
export function setVoicePrefs(p: VoicePrefs): void {
  prefs = p
}

/** 지금 나가는 소리의 순간 음량(0~1). 얼굴 자리(이번엔 상태 막대)가 프레임마다 읽는다. */
export const outputLevel = (): number => player.level()

/** 설정 [들어보기] — 대화 중이 아니어도 소리는 같은 재생기로 나온다. */
export async function previewVoice(): Promise<boolean> {
  wire()
  const r = await window.ev.voice.preview().catch(() => ({ ok: false as const }))
  return r.ok
}

export async function setBypass(on: boolean): Promise<void> {
  wire()
  const r = await window.ev.voice.setBypass(on)
  set({ bypass: r.bypass })
}

export function useVoice(): VoiceView {
  wire()
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => view
  )
}

// 상태바 "승인 생략 켜짐" 칩 → 설정 › 음성. 설정 창의 주인(MainArea)이 열어 주는 함수를 넣는다.
let openSettings: (() => void) | null = null
export const setVoiceSettingsOpener = (fn: (() => void) | null): void => {
  openSettings = fn
}
export const openVoiceSettings = (): void => openSettings?.()

/** 지금 값(이벤트 처리기용 — 훅 밖에서 읽는다). */
export const voiceView = (): VoiceView => view
