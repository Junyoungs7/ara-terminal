// Gemini Live 연결 하나 — **main 이 WebSocket 을 쥔다**(voice-research 권장 A).
//
// 불변식:
//   1. 키는 getKey() 로 받아 liveUrl() 한 줄에서만 쓴다. 사건(emit)·오류 문구·로그에 싣지 않는다.
//   2. 연결 약 10분마다 오는 GoAway 는 사용자에게 안 보인다 — 받은 재개 핸들로 새 연결을 미리 열고,
//      준비되면 갈아탄다. 그사이 마이크 소리는 잠깐 쌓았다가 새 연결로 흘린다.
//   3. 끼어들기(interrupted)는 받는 즉시 렌더러로 — 재생 큐를 비우는 건 렌더러 일이다.
import { Buffer } from 'node:buffer'
import type { VoiceEvent, VoiceSpeed, VoiceStatus, VoiceTokens } from '@shared/voice'
import { audioEndMsg, audioMsg, buildSetup, liveUrl, parseServer, safeReason, textTurnMsg, type LiveIn } from './liveProtocol'

/** 소켓의 최소 모양 — 실물은 openWs(ws 패키지), 시험은 가짜. */
export type LiveSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((frame: string | Uint8Array) => void) | null
  onclose: ((code: number, reason: string) => void) | null
}

export type LiveDeps = {
  getKey(): string | null
  config(): { voiceName: string; speed: VoiceSpeed; callName: string }
  open(url: string): LiveSocket
  emit(e: VoiceEvent): void
  /** 한 차례(나/아라 자막)가 끝났다 — 대화 기록 보관. */
  onTurn?(me: string, ara: string): void
  onUsage?(t: VoiceTokens): void
  /** 연결이 끝나며 이번에 붙어 있던 초. */
  onSeconds?(sec: number): void
  now?(): number
}

// 이 코드로 닫히면 다시 붙어도 같은 결과다(키 거절·잘못된 설정) — 재시도하지 않는다.
const FATAL_CLOSE = new Set([1003, 1007, 1008])
const MAX_RETRY = 3
const RETRY_MS = [500, 1000, 2000]
// 갈아타는 동안 쌓아 둘 마이크 조각 상한(64ms 조각 기준 약 3초). 넘치면 오래된 것부터 버린다.
const QUEUE_MAX = 48

export class LiveClient {
  private sock: LiveSocket | null = null
  private next: LiveSocket | null = null
  private status: VoiceStatus = 'off'
  private handle: string | null = null
  private queue: string[] = []
  private retries = 0
  private generating = false
  private moveAfterTurn = false
  private me = ''
  private ara = ''
  private readyAt: number | null = null
  private preview: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly d: LiveDeps) {}

  getStatus(): VoiceStatus {
    return this.status
  }

  /** preview 를 주면 그 글을 한 번 읽게 하고 끝나면 스스로 닫는다(설정 [들어보기]). */
  start(o: { preview?: string } = {}): { ok: true } | { ok: false; reason: 'noKey' } {
    if (!this.d.getKey()) return { ok: false, reason: 'noKey' }
    this.stop()
    this.preview = o.preview ?? null
    this.handle = null
    this.retries = 0
    this.setStatus('connecting')
    this.connect()
    return { ok: true }
  }

  stop(): void {
    this.teardown()
    this.setStatus('off')
  }

  private teardown(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const socks = [this.sock, this.next]
    this.sock = this.next = null
    for (const s of socks) s?.close(1000)
    this.flushTurn()
    this.account()
    this.queue = []
    this.generating = this.moveAfterTurn = false
  }

  /** 마이크 PCM16 16kHz 한 조각. */
  sendAudio(pcm: Uint8Array): void {
    if (this.status === 'off' || this.status === 'error' || this.preview) return
    const msg = JSON.stringify(audioMsg(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')))
    if (this.sock) this.sock.send(msg)
    else {
      this.queue.push(msg)
      if (this.queue.length > QUEUE_MAX) this.queue.shift()
    }
  }

  /** 누르고 말하기를 뗐다. */
  endAudio(): void {
    this.sock?.send(JSON.stringify(audioEndMsg()))
    if (this.status === 'listening') this.setStatus('thinking')
  }

  private setStatus(s: VoiceStatus, reason?: string): void {
    if (s === this.status && !reason) return
    this.status = s
    this.d.emit(reason ? { t: 'status', status: s, reason } : { t: 'status', status: s })
  }

  private connect(): void {
    const key = this.d.getKey()
    if (!key) return this.fail('Google 키가 없습니다')
    const s = this.d.open(liveUrl(key))
    this.next = s
    const { voiceName, speed, callName } = this.d.config()
    s.onopen = () => s.send(JSON.stringify(buildSetup({ voiceName, speed, callName, handle: this.handle })))
    s.onmessage = (f) => {
      for (const ev of parseServer(f)) this.on(s, ev)
    }
    s.onclose = (code, reason) => this.closed(s, code, reason)
  }

  private on(s: LiveSocket, ev: LiveIn): void {
    switch (ev.t) {
      case 'setupComplete': {
        if (s !== this.next) return
        const old = this.sock
        this.sock = s
        this.next = null
        this.retries = 0
        old?.close(1000)
        for (const m of this.queue) s.send(m)
        this.queue = []
        if (this.readyAt === null) this.readyAt = (this.d.now ?? Date.now)()
        if (this.preview) s.send(JSON.stringify(textTurnMsg(this.preview)))
        if (this.status === 'connecting') this.setStatus('listening')
        return
      }
      case 'audio':
        this.generating = true
        this.d.emit({ t: 'audio', pcm: new Uint8Array(Buffer.from(ev.data, 'base64')) })
        this.setStatus('speaking')
        return
      case 'inText':
        this.me += ev.text
        this.d.emit({ t: 'caption', who: 'me', text: ev.text })
        return
      case 'outText':
        this.generating = true
        this.ara += ev.text
        this.d.emit({ t: 'caption', who: 'ara', text: ev.text })
        return
      case 'interrupted':
        this.generating = false
        this.d.emit({ t: 'interrupted' })
        this.flushTurn()
        this.setStatus('listening')
        this.afterTurn()
        return
      case 'generationComplete':
        this.generating = false
        return
      case 'turnComplete':
        this.generating = false
        this.d.emit({ t: 'turnEnd' })
        this.flushTurn()
        if (this.preview) return this.stop()
        this.setStatus('listening')
        this.afterTurn()
        return
      case 'goAway':
        // 말하는 중에 갈아타면 그 말이 끊긴다 — 차례가 끝나기를 기다린다(timeLeft 안에 끝나지 않으면 closed 가 받는다).
        if (this.generating) this.moveAfterTurn = true
        else this.move()
        return
      case 'resume':
        if (ev.handle) this.handle = ev.handle
        return
      case 'usage':
        this.d.onUsage?.(ev.tokens)
        return
      case 'toolCall':
      case 'toolCancel':
        // 다음 라운드(도구) 자리. 지금은 함수 선언을 안 보내므로 오지 않는다.
        return
    }
  }

  private afterTurn(): void {
    if (!this.moveAfterTurn) return
    this.moveAfterTurn = false
    this.move()
  }

  /** 계획된 갈아타기 — 새 연결을 열고, setupComplete 에서 옛 연결을 닫는다. */
  private move(): void {
    if (this.next) return
    this.connect()
  }

  private closed(s: LiveSocket, code: number, reason: string): void {
    if (s === this.next) {
      this.next = null
      return this.retry(code, reason)
    }
    if (s !== this.sock) return // 이미 갈아탄 옛 연결
    this.sock = null
    if (this.next) return // 새 연결이 오는 중 — 그동안 쌓아 둔다
    if (this.preview) return this.stop()
    this.retry(code, reason)
  }

  private retry(code: number, reason: string): void {
    if (this.status === 'off') return
    if (FATAL_CLOSE.has(code) || this.retries >= MAX_RETRY) return this.fail(reason ? safeReason(reason) : `연결이 끊겼습니다 (${code})`)
    const wait = RETRY_MS[this.retries] ?? 2000
    this.retries += 1
    this.setStatus('connecting')
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.status !== 'off' && this.status !== 'error') this.connect()
    }, wait)
  }

  private fail(reason: string): void {
    this.teardown()
    this.setStatus('error', reason)
  }

  private flushTurn(): void {
    if (this.me || this.ara) this.d.onTurn?.(this.me.trim(), this.ara.trim())
    this.me = this.ara = ''
  }

  private account(): void {
    if (this.readyAt === null) return
    this.d.onSeconds?.(((this.d.now ?? Date.now)() - this.readyAt) / 1000)
    this.readyAt = null
  }
}
