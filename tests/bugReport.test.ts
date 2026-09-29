// #206 오류 신고 — 아라 쪽. 계약 docs/bug-report-api.md · 기획 docs/plan-bug-report.md.
// 실서버에 붙지 않는다: POST 는 가짜 fetch 로만 잰다.
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReport,
  deviceId,
  DEVICE_ID_FILE,
  logTail,
  postReport,
  safeSettings,
  sessionShape,
  tamperedOf
} from '../src/main/report/BugReport'
import { installErrorRing, recentErrors, RENDERER_ERRORS_MAX } from '../src/renderer/store/errorRing'
import type { Session, UiState } from '../src/shared/types'
import type { ReportSendReq } from '../src/shared/bugReport'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-report-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const req = (over: Partial<ReportSendReq> = {}): ReportSendReq => ({
  title: '제목',
  what: '',
  happened: '일어난 일',
  expected: '',
  name: '',
  gpu: 'webgl · Intel',
  ...over
})

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

describe('수집물 — 호스트·경로·제목이 없다', () => {
  it('가짜 세션·설정에 web-01 · /srv/secret 을 넣어도 결과 어디에도 안 나온다', () => {
    const sessions = [
      { id: 'a', type: 'ssh', title: 'web-01', serverKey: 'web-01', cwd: '/srv/secret' },
      { id: 'b', type: 'ssh', title: 'root@web-01:/srv/secret', serverKey: 'web-01' },
      { id: 'c', type: 'local', title: '/srv/secret', serverKey: 'local', cwd: '/srv/secret' }
    ] as Session[]
    const ui = {
      font: { term: 'D2Coding', sizePx: 14, lineHeight: 1.2 },
      locale: 'ko',
      scrollback: 5000,
      sessionLogDir: '/srv/secret',
      appLogDir: '/srv/secret',
      araCallName: 'web-01',
      aiCompatibleBaseUrl: 'http://web-01/srv/secret',
      groups: ['web-01'],
      workProfiles: [{ id: 'w', name: 'web-01', path: '/srv/secret' }],
      araChatNames: { x: 'web-01' }
    } as unknown as UiState
    const settings = safeSettings(ui)
    const shape = sessionShape(sessions, 1)
    expect(shape).toEqual({ ssh: 2, local: 1, rdp: 0, windows: 1 })

    const { body, sent } = buildReport(req({ settings: true }), {
      deviceId: 'dev',
      version: '1.0.13',
      os: 'Windows',
      electron: '31',
      sessions: shape,
      settings
    })
    // 본문 + 첨부를 풀어 낸 것 전부를 훑는다(base64 안에 숨으면 grep 이 못 본다).
    const all = body + [...sent.values()].map((b) => b.toString('utf8')).join('\n')
    expect(all).not.toContain('web-01')
    expect(all).not.toContain('/srv/secret')
    expect(JSON.parse(settings)).toMatchObject({ locale: 'ko', scrollback: 5000 })
  })
})

describe('main-error.log 꼬리', () => {
  it('200줄만, 마스킹해서', () => {
    const p = join(tmp(), 'main-error.log')
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`)
    lines[290] = 'mysql -pSECRET -h db'
    writeFileSync(p, lines.join('\n'))
    const out = logTail(p)
    expect(out.split('\n')).toHaveLength(200)
    expect(out).not.toContain('SECRET')
    expect(out).toContain('-p****')
    expect(out).toContain('line 299')
    expect(out).not.toContain('line 99\n')
  })

  it('파일이 없으면 빈 문자열', () => {
    expect(logTail(join(tmp(), 'none.log'))).toBe('')
  })

  it('보낼 때도 한 번 더 건다(렌더러를 거쳐 돌아온 값)', () => {
    const { sent } = buildReport(req({ log: 'mysql -pSECRET' }), ctx())
    expect(sent.get('main-error.log')!.toString()).not.toContain('SECRET')
  })

  it('렌더러 오류는 보낼 때 마스킹한다', () => {
    const { sent } = buildReport(
      req({ rendererErrors: [{ at: 1, message: 'TOKEN=abc123', stack: 'at x (--password=hunter2)' }] }),
      ctx()
    )
    const txt = sent.get('renderer-errors.json')!.toString()
    expect(txt).not.toContain('abc123')
    expect(txt).not.toContain('hunter2')
  })
})

const ctx = () => ({ deviceId: 'dev', version: '1', os: 'w', electron: '31', sessions: {}, settings: '{}' })

describe('기기 ID', () => {
  it('없으면 만들고, 있으면 같은 값', () => {
    const d = tmp()
    const a = deviceId(d)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(join(d, DEVICE_ID_FILE), 'utf8')).toBe(a)
    expect(deviceId(d)).toBe(a)
  })

  it('깨진 파일은 새로 만든다', () => {
    const d = tmp()
    writeFileSync(join(d, DEVICE_ID_FILE), 'garbage')
    const a = deviceId(d)
    expect(a).not.toBe('garbage')
    expect(deviceId(d)).toBe(a)
  })

  it('🔴 렌더러·preload 소스 어디에도 deviceId 가 없다(main 만 안다)', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n)
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []
      })
    const hits = [...walk('src/renderer'), 'src/preload/index.ts'].filter((f) => /deviceId|device-id/.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })
})

describe('hashes 대조', () => {
  const sent = new Map([
    ['capture.png', Buffer.from('png-bytes')],
    ['main-error.log', Buffer.from('log')]
  ])
  it('같으면 tampered: []', () => {
    expect(tamperedOf(sent, { 'capture.png': sha(Buffer.from('png-bytes')), 'main-error.log': sha(Buffer.from('log')) })).toEqual([])
  })
  it('하나 다르면 그 이름', () => {
    expect(tamperedOf(sent, { 'capture.png': sha(Buffer.from('오피스키퍼')), 'main-error.log': sha(Buffer.from('log')) })).toEqual([
      'capture.png'
    ])
  })
  it('해시가 빠지면 그것도 알린다', () => {
    expect(tamperedOf(sent, { 'main-error.log': sha(Buffer.from('log')) })).toEqual(['capture.png'])
  })
})

describe('postReport — 가짜 fetch', () => {
  const built = () => buildReport(req({ capture: Buffer.from('png').toString('base64'), log: 'hello' }), ctx())

  it('201 → 번호 + 서버 해시로 대조', async () => {
    const b = built()
    const hashes = Object.fromEntries([...b.sent].map(([n, v]) => [n, sha(v)]))
    hashes['main-error.log'] = sha(Buffer.from('바뀐 것'))
    const fake = (async () => new Response(JSON.stringify({ id: 'r-1', number: 12, hashes }), { status: 201 })) as typeof fetch
    expect(await postReport('http://x', b, fake)).toEqual({ ok: true, id: 'r-1', number: 12, tampered: ['main-error.log'] })
  })

  it('계약대로 싣는다 — 허용 목록 이름·mime·deviceId', async () => {
    let got: Record<string, unknown> = {}
    let url = ''
    const fake = (async (u: string, init: RequestInit) => {
      url = u
      got = JSON.parse(String(init.body))
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    await postReport('http://x', built(), fake)
    expect(url).toBe('http://x/api/reports')
    expect(got.deviceId).toBe('dev')
    expect(got.attachments).toEqual([
      { name: 'capture.png', mime: 'image/png', base64: Buffer.from('png').toString('base64') },
      { name: 'main-error.log', mime: 'text/plain', base64: Buffer.from('hello').toString('base64') }
    ])
  })

  it('실패는 서버 문장 그대로, 다시 보내지 않는다', async () => {
    let calls = 0
    const fake = (async () => {
      calls++
      return new Response(JSON.stringify({ error: '신고가 너무 잦습니다.' }), { status: 429 })
    }) as typeof fetch
    expect(await postReport('http://x', built(), fake)).toEqual({ ok: false, reason: 'server', error: '신고가 너무 잦습니다.' })
    expect(calls).toBe(1)
  })

  it('닿지 못하면 network, 한 번만', async () => {
    let calls = 0
    const fake = (async () => {
      calls++
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await postReport('http://x', built(), fake)).toEqual({ ok: false, reason: 'network' })
    expect(calls).toBe(1)
  })

  it('문장 없는 거절은 http + 상태', async () => {
    const fake = (async () => new Response('<html>', { status: 502 })) as typeof fetch
    expect(await postReport('http://x', built(), fake)).toEqual({ ok: false, reason: 'http', status: 502 })
  })
})

describe('렌더러 오류 링버퍼', () => {
  it(`${RENDERER_ERRORS_MAX}건 상한 — 오래된 것부터 버린다`, () => {
    const target = new EventTarget()
    installErrorRing(target)
    for (let i = 0; i < 60; i++) {
      const ev = new Event('error')
      Object.assign(ev, { message: `e${i}`, error: Object.assign(new Error(`e${i}`), { stack: 'x'.repeat(5000) }) })
      target.dispatchEvent(ev)
    }
    const rej = new Event('unhandledrejection')
    Object.assign(rej, { reason: 'plain string' })
    target.dispatchEvent(rej)
    const got = recentErrors()
    expect(got).toHaveLength(RENDERER_ERRORS_MAX)
    expect(got[0].message).toBe('e11')
    expect(got.at(-1)!.message).toBe('plain string')
    expect(got[0].stack).toHaveLength(2000)
  })
})

/**
 * 🔴 순서 — 캡처(report.prepare)가 신고 창(setPrepared)보다 **먼저**다.
 * 소스에서 잰다: open() 본문 안에서 prepare 호출이 창을 여는 setPrepared 보다 앞에 있고, 그 값을 받아 연다.
 */
function captureBeforeOpen(src: string): boolean {
  const start = src.indexOf('const open = useCallback(')
  if (start < 0) return false
  const body = src.slice(start, src.indexOf('}, [])', start))
  const cap = body.indexOf('report.prepare(')
  const openAt = body.indexOf('setPrepared(') // 처음 여는 자리(무엇으로 열든)
  // prepare 결과를 기다린 뒤 연다 — await 없이 부르면 순서가 소스상 앞이어도 실제론 동시다.
  return cap >= 0 && openAt > cap && /await\s+window\.ev\.report\s*\.prepare\(/.test(body)
}

describe('🔴 캡처가 신고 창보다 먼저', () => {
  const src = readFileSync('src/renderer/components/BugReportModal.tsx', 'utf8')
  it('지금 소스는 지킨다', () => {
    expect(captureBeforeOpen(src)).toBe(true)
    // 창은 prepared 가 있을 때만 그린다(비어 있는 채로 먼저 뜨지 않는다).
    expect(src).toMatch(/node: prepared \?/)
  })
  it('순서를 뒤집은 소스는 문다', () => {
    const bad = src.replace(
      /(const p = await window\.ev\.report\.prepare\([^\n]*\n)(\s*)setPrepared\(p\)/,
      '$2setPrepared({ capture: null, log: "", settings: "" })\n$1$2setPrepared(p)'
    )
    expect(bad).not.toBe(src)
    expect(captureBeforeOpen(bad)).toBe(false)
  })
  it('await 를 뺀 소스는 문다', () => {
    const bad = src.replace('await window.ev.report.prepare(', 'window.ev.report.prepare(')
    expect(bad).not.toBe(src)
    expect(captureBeforeOpen(bad)).toBe(false)
  })
})

// 오류 신고 #6: 바깥 클릭으로 닫히면 써 둔 글이 사라진다.
describe('신고 창은 바깥 클릭으로 닫히지 않는다', () => {
  const src = readFileSync('src/renderer/components/BugReportModal.tsx', 'utf8')
  const closesOnBackdrop = (s: string): boolean => /className="overlay open"\s+onClick=/.test(s)
  it('지금 소스는 지킨다', () => expect(closesOnBackdrop(src)).toBe(false))
  it('바깥 클릭 닫기를 되살린 소스는 문다', () => {
    const bad = src.replace('<div className="overlay open">', '<div className="overlay open" onClick={onClose}>')
    expect(bad).not.toBe(src)
    expect(closesOnBackdrop(bad)).toBe(true)
  })
})
