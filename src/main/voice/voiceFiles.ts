// 음성의 디스크 쪽 — 실제 소켓(ws), 이번 달 사용량, 대화 기록(자막 글만). 소리는 어디에도 저장하지 않는다.
import WebSocket from 'ws'
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { emptyTokens, monthOf, type VoiceKeep, type VoiceTokens, type VoiceUsage } from '@shared/voice'
import type { LiveSocket } from './LiveClient'

/**
 * 실물 소켓. Electron 31 의 main 은 Node 20 이라 내장 WebSocket 이 없다(플래그 뒤) — 이미 쓰는 ws(RdpRelay)를 쓴다.
 * 'error' 는 듣기만 한다(안 들으면 ws 가 던진다). 바로 뒤에 close(1006)가 온다. 오류 객체엔 URL(=키)이 실릴 수 있어 남기지 않는다.
 */
export function openWs(url: string): LiveSocket {
  const ws = new WebSocket(url)
  const s: LiveSocket = {
    send: (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d)
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason)
      } catch {
        ws.terminate()
      }
    },
    onopen: null,
    onmessage: null,
    onclose: null
  }
  ws.on('open', () => s.onopen?.())
  ws.on('message', (data: Buffer, isBinary: boolean) => s.onmessage?.(isBinary ? new Uint8Array(data) : data.toString('utf8')))
  ws.on('close', (code: number, reason: Buffer) => s.onclose?.(code, reason.toString('utf8')))
  ws.on('error', () => {})
  return s
}

/** 이번 달 사용량 — 달이 바뀌면 0부터. */
export class VoiceUsageFile {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  get(): VoiceUsage {
    const month = monthOf(this.now())
    const u = readJsonWithBackup<VoiceUsage | null>(this.path, null)
    if (!u || u.month !== month || typeof u.seconds !== 'number' || !u.tokens) return { month, seconds: 0, tokens: emptyTokens() }
    return { month, seconds: u.seconds, tokens: { ...emptyTokens(), ...u.tokens } }
  }

  add(p: { seconds?: number; tokens?: VoiceTokens }): void {
    const u = this.get()
    u.seconds += p.seconds ?? 0
    if (p.tokens) for (const k of Object.keys(u.tokens) as (keyof VoiceTokens)[]) u.tokens[k] += p.tokens[k] ?? 0
    writeJsonAtomic(this.path, u)
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${monthOf(ms)}-${String(d.getDate()).padStart(2, '0')}`
}

/** 대화 기록 — 하루 한 파일(jsonl). keep='off' 면 쓰지 않는다. */
export class VoiceLog {
  constructor(
    private readonly dir: string,
    private readonly keep: () => VoiceKeep,
    private readonly now: () => number = Date.now
  ) {}

  write(me: string, ara: string): void {
    if (this.keep() === 'off' || (!me && !ara)) return
    mkdirSync(this.dir, { recursive: true })
    const at = this.now()
    appendFileSync(join(this.dir, `${dayOf(at)}.jsonl`), JSON.stringify({ at, me, ara }) + '\n', 'utf8')
  }

  /** 기간 지난 파일 정리. '0' = 무제한, 'off' = 지금 남은 것도 지운다(보관 안 함을 고른 뜻). */
  sweep(): void {
    const keep = this.keep()
    if (keep === '0') return
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    const cutoff = keep === 'off' ? Infinity : dayOf(this.now() - Number(keep) * 86_400_000)
    for (const n of names) {
      const m = DAY_FILE.exec(n)
      if (m && (cutoff === Infinity || m[1] < cutoff)) rmSync(join(this.dir, n), { force: true })
    }
  }
}
