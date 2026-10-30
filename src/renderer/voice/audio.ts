// 2.1 음성 — 렌더러의 소리 두 가닥. 마이크(16kHz PCM16 조각)와 스피커(24kHz PCM16 재생 큐).
// 네트워크는 모른다 — 조각을 넘기고 받은 조각을 틀 뿐이다(연결은 main 의 LiveClient).
import workletUrl from './pcm-worklet.js?url'

export type MicHandle = { stop(): void }

/**
 * 마이크를 연다. onChunk 는 64ms 마다 PCM16 바이트, onLevel 은 그 조각의 RMS(0~1).
 * micId 가 빈 값이면 기본 장치. 장치가 사라졌으면 기본 장치로 다시 연다.
 */
export async function openMic(micId: string, onChunk: (pcm: Uint8Array) => void, onLevel: (rms: number) => void): Promise<MicHandle> {
  const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { ...audio, deviceId: { exact: micId } } : audio })
  } catch (e) {
    if (!micId) throw e
    stream = await navigator.mediaDevices.getUserMedia({ audio })
  }
  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.audioWorklet.addModule(workletUrl)
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture')
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    onLevel(e.data.rms)
    onChunk(new Uint8Array(e.data.pcm))
  }
  src.connect(node)
  return {
    stop: () => {
      node.port.onmessage = null
      src.disconnect()
      node.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

/** 입력 장치 목록(라벨은 마이크 권한을 한 번 받은 뒤에야 채워진다). */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ id: d.deviceId, label: d.label }))
}

const OUT_RATE = 24000

/**
 * 재생 큐 — 받은 조각을 끊김 없이 이어 붙인다. clear() 는 끼어들기: 예약된 것까지 즉시 멈춘다.
 * level() 은 지금 나가는 소리의 순간 음량(0~1) — 다음 라운드 얼굴(입 열림)이 이 값을 읽는다.
 */
export class Player {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private at = 0
  private live = new Set<AudioBufferSourceNode>()
  private buf: Float32Array<ArrayBuffer> | null = null

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: OUT_RATE })
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
    }
    return this.ctx
  }

  push(pcm: Uint8Array): void {
    const ctx = this.ensure()
    const n = pcm.byteLength >> 1
    if (n === 0) return
    const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
    const ab = ctx.createBuffer(1, n, OUT_RATE)
    const ch = ab.getChannelData(0)
    for (let i = 0; i < n; i += 1) ch[i] = view.getInt16(i * 2, true) / 0x8000
    const src = ctx.createBufferSource()
    src.buffer = ab
    src.connect(this.analyser!)
    // 큐가 비어 있었으면 지금(아주 조금 뒤)부터, 아니면 앞 조각 끝에 이어 붙인다.
    this.at = Math.max(this.at, ctx.currentTime + 0.02)
    src.start(this.at)
    this.at += ab.duration
    this.live.add(src)
    src.onended = () => this.live.delete(src)
  }

  clear(): void {
    for (const s of this.live) {
      try {
        s.stop()
      } catch {
        /* 이미 끝난 조각 */
      }
    }
    this.live.clear()
    this.at = 0
  }

  playing(): boolean {
    return this.live.size > 0
  }

  level(): number {
    if (!this.analyser || this.live.size === 0) return 0
    if (!this.buf || this.buf.length !== this.analyser.fftSize) this.buf = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(this.buf)
    let sq = 0
    for (const v of this.buf) sq += v * v
    return Math.sqrt(sq / this.buf.length)
  }

  close(): void {
    this.clear()
    void this.ctx?.close()
    this.ctx = this.analyser = null
  }
}
