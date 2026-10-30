// 2.1 음성 — Live 메시지 모양, GoAway 갈아타기, 끼어들기, bypass 비저장, 키 비유출.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const ons = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => ons.set(ch, fn)
  }
}))

import { audioEndMsg, audioMsg, buildSetup, durationMs, liveUrl, parseServer, safeReason } from '../src/main/voice/liveProtocol'
import { LiveClient, type LiveSocket } from '../src/main/voice/LiveClient'
import { VoiceLog, VoiceUsageFile } from '../src/main/voice/voiceFiles'
import { registerVoiceIpc } from '../src/main/ipc/registerVoiceIpc'
import { DEFAULT_VOICE, voiceCost, voiceOf, type VoiceEvent } from '../src/shared/voice'

class FakeSocket implements LiveSocket {
  sent: Record<string, unknown>[] = []
  closed: number | null = null
  onopen: (() => void) | null = null
  onmessage: ((f: string | Uint8Array) => void) | null = null
  onclose: ((code: number, reason: string) => void) | null = null
  constructor(readonly url: string) {}
  send(d: string): void {
    this.sent.push(JSON.parse(d))
  }
  close(code = 1000): void {
    if (this.closed !== null) return
    this.closed = code
    this.onclose?.(code, '')
  }
  /** 서버 쪽 — 바이너리 프레임으로 보낸다(실서버도 그렇게 온다). */
  srv(j: unknown): void {
    this.onmessage?.(new TextEncoder().encode(JSON.stringify(j)))
  }
  drop(code: number, reason = ''): void {
    this.closed = code
    this.onclose?.(code, reason)
  }
}

function rig(key: string | null = 'test-key') {
  const socks: FakeSocket[] = []
  const events: VoiceEvent[] = []
  const turns: [string, string][] = []
  const c = new LiveClient({
    getKey: () => key,
    config: () => ({ voiceName: 'Kore', speed: 'slow', callName: '' }),
    open: (url) => {
      const s = new FakeSocket(url)
      socks.push(s)
      return s
    },
    emit: (e) => events.push(e),
    onTurn: (me, ara) => turns.push([me, ara])
  })
  /** 마지막 소켓을 열고 setupComplete 까지. */
  const ready = (): FakeSocket => {
    const s = socks[socks.length - 1]
    s.onopen?.()
    s.srv({ setupComplete: {} })
    return s
  }
  const statuses = () => events.filter((e) => e.t === 'status').map((e) => (e as { status: string }).status)
  return { c, socks, events, turns, ready, statuses }
}

describe('Live 메시지 직렬화', () => {
  it('setup — 모델·AUDIO·목소리·받아쓰기 둘·압축·재개, 속도는 지시문에', () => {
    const s = buildSetup({ voiceName: 'Kore', speed: 'slow', handle: null }).setup as Record<string, any>
    expect(s.model).toBe('models/gemini-3.8-live')
    expect(s.generationConfig.responseModalities).toEqual(['AUDIO'])
    expect(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore')
    expect(s.inputAudioTranscription).toEqual({})
    expect(s.outputAudioTranscription).toEqual({})
    expect(s.contextWindowCompression).toEqual({ slidingWindow: {} })
    expect(s.sessionResumption).toEqual({})
    expect(s.systemInstruction.parts[0].text).toContain('천천히')
    expect(s.tools).toBeUndefined()
    const r = buildSetup({ voiceName: 'Kore', speed: 'normal', handle: 'h9' }).setup as Record<string, any>
    expect(r.sessionResumption).toEqual({ handle: 'h9' })
  })

  it('마이크 조각·끝 표시', () => {
    expect(audioMsg('AAA=')).toEqual({ realtimeInput: { audio: { data: 'AAA=', mimeType: 'audio/pcm;rate=16000' } } })
    expect(audioEndMsg()).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(liveUrl('a b')).toMatch(/BidiGenerateContent\?key=a%20b$/)
  })

  it('서버 프레임 읽기 — 글자·바이트 둘 다, 깨진 건 빈 목록', () => {
    const f = JSON.stringify({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQI=' } }] },
        inputTranscription: { text: '디스크' },
        outputTranscription: { text: '봅니다' },
        turnComplete: true
      },
      usageMetadata: {
        promptTokensDetails: [
          { modality: 'AUDIO', tokenCount: 100 },
          { modality: 'TEXT', tokenCount: 10 }
        ],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 50 }]
      }
    })
    const ev = parseServer(new TextEncoder().encode(f))
    expect(ev.map((e) => e.t)).toEqual(['inText', 'audio', 'outText', 'turnComplete', 'usage'])
    expect(ev.find((e) => e.t === 'usage')).toEqual({ t: 'usage', tokens: { textIn: 10, audioIn: 100, textOut: 0, audioOut: 50 } })
    expect(parseServer('{"serverContent":{"interrupted":true}}')).toEqual([{ t: 'interrupted' }])
    expect(parseServer('{"goAway":{"timeLeft":"12.5s"}}')).toEqual([{ t: 'goAway', timeLeftMs: 12500 }])
    expect(parseServer('{"sessionResumptionUpdate":{"newHandle":"h1","resumable":true}}')).toEqual([{ t: 'resume', handle: 'h1' }])
    expect(parseServer('{"sessionResumptionUpdate":{"newHandle":"","resumable":false}}')).toEqual([{ t: 'resume', handle: null }])
    expect(parseServer('{"setupComplete":{}}')).toEqual([{ t: 'setupComplete' }])
    expect(parseServer('not json')).toEqual([])
    expect(durationMs('3s')).toBe(3000)
    expect(durationMs(5)).toBeNull()
  })

  it('닫힘 이유에서 키 모양을 지운다', () => {
    expect(safeReason('bad key=AIzaSyXXXXXXXXXXXXXXXX&x')).not.toContain('AIzaSy')
    expect(safeReason('API key AIzaSyABCDEFGHIJKLMNOP invalid')).not.toContain('ABCDEFGHIJ')
  })
})

describe('LiveClient — 연결·GoAway·끼어들기', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('키가 없으면 열지 않는다', () => {
    const r = rig(null)
    expect(r.c.start()).toEqual({ ok: false, reason: 'noKey' })
    expect(r.socks).toHaveLength(0)
  })

  it('연결 → 듣는 중, 말 → 말하는 중, 차례 끝 → 듣는 중 + 기록', () => {
    const r = rig()
    r.c.start()
    const s = r.ready()
    expect((s.sent[0] as any).setup.model).toBe('models/gemini-3.8-live')
    s.srv({ serverContent: { inputTranscription: { text: '안녕' } } })
    s.srv({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=' } }] }, outputTranscription: { text: '네' } } })
    s.srv({ serverContent: { turnComplete: true } })
    expect(r.statuses()).toEqual(['connecting', 'listening', 'speaking', 'listening'])
    const audio = r.events.find((e) => e.t === 'audio') as { pcm: Uint8Array }
    expect(Array.from(audio.pcm)).toEqual([1, 2])
    expect(r.turns).toEqual([['안녕', '네']])
  })

  it('GoAway → 핸들로 새 연결, 그사이 마이크는 쌓았다 새 연결로, 상태는 그대로', () => {
    const r = rig()
    r.c.start()
    const a = r.ready()
    a.srv({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })
    a.srv({ goAway: { timeLeft: '10s' } })
    expect(r.socks).toHaveLength(2)
    const b = r.socks[1]
    b.onopen?.()
    expect((b.sent[0] as any).setup.sessionResumption).toEqual({ handle: 'h1' })
    // 옛 연결이 먼저 끊겨도 사용자에게 오류가 아니다 — 새 연결을 기다린다.
    a.drop(1001)
    r.c.sendAudio(new Uint8Array([9, 9]))
    expect(b.sent).toHaveLength(1)
    b.srv({ setupComplete: {} })
    expect(b.sent[1]).toEqual(audioMsg(Buffer.from([9, 9]).toString('base64')))
    expect(r.statuses()).toEqual(['connecting', 'listening'])
  })

  it('말하는 중의 GoAway 는 차례가 끝난 뒤 갈아탄다', () => {
    const r = rig()
    r.c.start()
    const a = r.ready()
    a.srv({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=' } }] } } })
    a.srv({ goAway: { timeLeft: '5s' } })
    expect(r.socks).toHaveLength(1)
    a.srv({ serverContent: { turnComplete: true } })
    expect(r.socks).toHaveLength(2)
    r.socks[1].onopen?.()
    r.socks[1].srv({ setupComplete: {} })
    expect(a.closed).toBe(1000)
  })

  it('예고 없이 끊기면 다시 붙고, 세 번 실패하면 오류', () => {
    const r = rig()
    r.c.start()
    const a = r.ready()
    a.drop(1006)
    expect(r.statuses().at(-1)).toBe('connecting')
    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(2000)
      r.socks[r.socks.length - 1].drop(1006)
    }
    expect(r.socks).toHaveLength(4)
    expect(r.statuses().at(-1)).toBe('error')
  })

  it('키 거절(1008)은 다시 붙지 않고 이유를 알린다 — 이유에 키는 없다', () => {
    const r = rig('AIzaSySECRETSECRETSECRET')
    r.c.start()
    r.socks[0].drop(1008, 'API key not valid: key=AIzaSySECRETSECRETSECRET')
    const last = r.events.at(-1) as { status: string; reason: string }
    expect(last.status).toBe('error')
    expect(last.reason).not.toContain('SECRET')
    expect(r.socks).toHaveLength(1)
  })

  it('끼어들기 → 렌더러에 재생 중단 통지, 듣는 중으로', () => {
    const r = rig()
    r.c.start()
    const s = r.ready()
    s.srv({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=' } }] } } })
    s.srv({ serverContent: { interrupted: true } })
    const i = r.events.findIndex((e) => e.t === 'interrupted')
    expect(i).toBeGreaterThan(-1)
    expect(r.statuses().at(-1)).toBe('listening')
  })

  it('누르고 말하기를 떼면 끝 표시를 보내고 생각 중', () => {
    const r = rig()
    r.c.start()
    const s = r.ready()
    r.c.endAudio()
    expect(s.sent.at(-1)).toEqual(audioEndMsg())
    expect(r.statuses().at(-1)).toBe('thinking')
  })
})

describe('설정 — bypass 는 저장되지 않는다', () => {
  it('voiceOf 는 bypass 칸을 버린다 · 모르는 값은 기본으로', () => {
    const v = voiceOf({ bypass: true, voiceName: 'Nope', captionLines: 9, keep: '30', listen: 'always' })
    expect('bypass' in v).toBe(false)
    expect(v.voiceName).toBe(DEFAULT_VOICE.voiceName)
    expect(v.captionLines).toBe(2)
    expect(v.keep).toBe('30')
    expect(v.listen).toBe('always')
  })
})

describe('registerVoiceIpc — 키는 렌더러로 안 나간다 · bypass 는 메모리 값', () => {
  const SENTINEL = 'AIzaSyKEYSENTINEL0123456789'
  let dir: string
  beforeEach(() => {
    handlers.clear()
    ons.clear()
    dir = mkdtempSync(join(tmpdir(), 'voice-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function boot() {
    const pushed: [string, unknown][] = []
    const wc = { isDestroyed: () => false, send: (ch: string, p: unknown) => pushed.push([ch, p]) }
    const socks: FakeSocket[] = []
    const vault = new Map<string, string>([['ai.apiKey.google', SENTINEL]])
    const rt = registerVoiceIpc({
      vault: {
        get: (k) => vault.get(k) ?? null,
        set: (k, v) => void vault.set(k, v),
        delete: (k) => void vault.delete(k),
        has: (k) => vault.has(k)
      },
      prefs: () => voiceOf({ keep: '7' }),
      callName: () => '',
      dir,
      getWebContents: () => wc as never,
      open: (url) => {
        const s = new FakeSocket(url)
        socks.push(s)
        return s
      }
    })
    const call = (ch: string, req?: unknown) => handlers.get(ch)!({}, req)
    return { rt, pushed, socks, call }
  }

  it('한 바퀴 돌려도 IPC 응답·push 어디에도 키가 없다', async () => {
    const { pushed, socks, call } = boot()
    const outs: unknown[] = []
    outs.push(await call('voice:state'))
    outs.push(await call('voice:start'))
    expect(socks[0].url).toContain(encodeURIComponent(SENTINEL)) // 키는 소켓 URL 에만
    socks[0].onopen?.()
    socks[0].srv({ setupComplete: {} })
    ons.get('voice:audio')!({}, { pcm: new Uint8Array([1, 2, 3, 4]) })
    socks[0].srv({ serverContent: { inputTranscription: { text: '서버 상태' }, modelTurn: { parts: [{ inlineData: { data: 'AQI=' } }] } } })
    socks[0].srv({ serverContent: { outputTranscription: { text: '정상입니다' }, turnComplete: true } })
    socks[0].drop(1008, `key=${SENTINEL} rejected`)
    outs.push(await call('voice:usage'))
    outs.push(await call('voice:preview'))
    outs.push(await call('voice:stop'))
    const all = JSON.stringify([outs, pushed.map(([ch, p]) => [ch, p instanceof Object && 'pcm' in (p as object) ? 'pcm' : p])])
    expect(all).not.toContain(SENTINEL)
    expect(all).not.toContain('KEYSENTINEL')
    expect((outs[0] as { hasKey: boolean }).hasKey).toBe(true)
    // 대화 기록 — 글만 남는다.
    const logDir = join(dir, 'log')
    const files = readdirSync(logDir)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(logDir, files[0]), 'utf8').trim())).toMatchObject({ me: '서버 상태', ara: '정상입니다' })
  })

  it('bypass — 켜면 알리고, 디스크 어디에도 안 남고, 다시 등록하면 꺼져 있다', async () => {
    const a = boot()
    expect(await a.call('voice:setBypass', { on: true })).toEqual({ bypass: true })
    expect(a.rt.bypass()).toBe(true)
    expect(a.pushed).toContainEqual(['voice:bypass', { on: true }])
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      const p = join(dir, f)
      if (existsSync(p) && f.endsWith('.json')) expect(readFileSync(p, 'utf8')).not.toContain('bypass')
    }
    // "앱 재시작" = 모듈 값을 새로 만드는 것.
    const b = boot()
    expect(b.rt.bypass()).toBe(false)
    expect(((await b.call('voice:state')) as { bypass: boolean }).bypass).toBe(false)
  })
})

describe('사용량·기록 파일', () => {
  it('이번 달만 센다 · 토큰이 없으면 시간×단가', () => {
    const d = mkdtempSync(join(tmpdir(), 'vu-'))
    let now = new Date(2026, 9, 15).getTime()
    const u = new VoiceUsageFile(join(d, 'usage.json'), () => now)
    u.add({ seconds: 3600 })
    expect(voiceCost(u.get())).toEqual({ by: 'time', low: 0.6, high: 0.7 })
    u.add({ tokens: { textIn: 0, audioIn: 1_000_000, textOut: 0, audioOut: 0 } })
    expect(voiceCost(u.get())).toMatchObject({ by: 'tokens', low: 3 })
    now = new Date(2026, 10, 2).getTime()
    expect(u.get().seconds).toBe(0)
    rmSync(d, { recursive: true, force: true })
  })

  it('기간 지난 날 파일만 지운다 · 보관 안 함이면 쓰지 않는다', () => {
    const d = mkdtempSync(join(tmpdir(), 'vl-'))
    const now = new Date(2026, 9, 30).getTime()
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, '2026-10-01.jsonl'), '{}\n')
    writeFileSync(join(d, '2026-10-29.jsonl'), '{}\n')
    new VoiceLog(d, () => '7', () => now).sweep()
    expect(readdirSync(d)).toEqual(['2026-10-29.jsonl'])
    const off = new VoiceLog(d, () => 'off', () => now)
    off.write('a', 'b')
    expect(readdirSync(d)).toEqual(['2026-10-29.jsonl'])
    off.sweep()
    expect(readdirSync(d)).toEqual([])
    rmSync(d, { recursive: true, force: true })
  })
})
