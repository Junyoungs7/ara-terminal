/**
 * #206 신고 서버(server/reports/server.mjs) — 계약 docs/bug-report-api.md.
 * 서버를 **실제 프로세스로** 임시 포트(0) + 임시 폴더에 띄워 fetch 로 친다.
 * 다시 띄우기 검사가 있어서 모듈 import 가 아니라 자식 프로세스다.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SERVER = resolve('server/reports/server.mjs')
const PW = 'test-admin-pw'
const DEV = 'dev-7f3a2c91-secret-device-id'
const OTHER = 'dev-other-device'

let dir: string
let proc: ChildProcess | null = null
let base = ''

function start(env: Record<string, string> = {}): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ARA_REPORTS_PORT: '0', ARA_REPORTS_DIR: dir, ARA_REPORTS_ADMIN_PW: PW, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc = p
    let out = ''
    p.stdout!.on('data', (d) => {
      out += d
      const m = /listening on (\d+)/.exec(out)
      if (m) {
        base = `http://127.0.0.1:${m[1]}`
        ok()
      }
    })
    p.on('exit', (code) => fail(new Error(`서버가 떴다가 죽음(${code}): ${out}`)))
  })
}

function stop(): Promise<void> {
  const p = proc
  proc = null
  if (!p || p.exitCode !== null) return Promise.resolve()
  return new Promise((ok) => {
    p.removeAllListeners('exit')
    p.on('exit', () => ok())
    p.kill()
  })
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254])
const log = '줄1\n오류: 무언가\n'

function report(over: Record<string, unknown> = {}) {
  return {
    title: '떼어낸 창에서 재접속이 안 됨',
    what: 'SSH 탭을 새 창으로 뺐다',
    happened: '재접속 버튼이 안 먹는다',
    name: '홍길동',
    deviceId: DEV,
    env: { version: '1.0.13', os: 'Windows 11', electron: '31.7.7', gpu: 'x', sessions: { ssh: 2, local: 1 } },
    attachments: [
      { name: 'capture.png', mime: 'image/png', base64: b64(png) },
      { name: 'main-error.log', mime: 'text/plain', base64: b64(log) }
    ],
    ...over
  }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const patch = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const admin = { Authorization: `Bearer ${PW}` }

/** 응답 본문을 전부 모아 둔다 — 마지막에 기기 ID 가 한 번도 안 나왔는지 훑는다. */
const bodies: string[] = []
async function text(r: Response) {
  const t = await r.text()
  bodies.push(t)
  return t
}
const json = async (r: Response) => JSON.parse(await text(r))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-reports-'))
  await start()
})
afterAll(async () => {
  await stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('ara-reports 서버', () => {
  let id = ''

  it('신고 → hashes 는 받은 바이트의 sha256', async () => {
    const r = await post('/api/reports', report())
    expect(r.status).toBe(201)
    const b = await json(r)
    expect(b.id).toMatch(/^r-\d{8}-0001$/)
    expect(b.number).toBe(1)
    expect(b.hashes).toEqual({ 'capture.png': sha(png), 'main-error.log': sha(log) })
    id = b.id
  })

  it('목록에 뜨고, 서버를 다시 띄워도 남아 있다', async () => {
    const list = await json(await fetch(base + '/api/reports'))
    expect(list.map((x: { id: string }) => x.id)).toEqual([id])
    expect(list[0]).toMatchObject({ number: 1, status: 'open', version: '1.0.13', name: '홍길동', comments: 0, fixedIn: null })

    await stop()
    await start()
    const again = await json(await fetch(base + '/api/reports'))
    expect(again).toEqual(list)
    // 번호도 이어 간다
    const r2 = await json(await post('/api/reports', report({ deviceId: OTHER, attachments: [] })))
    expect(r2.number).toBe(2)
    const top = await json(await fetch(base + '/api/reports'))
    expect(top[0].number).toBe(2) // 최신이 위
  })

  it('상세는 첨부 메타만(내용 없음)', async () => {
    const d = await json(await fetch(`${base}/api/reports/${id}`))
    expect(d.title).toBe('떼어낸 창에서 재접속이 안 됨')
    expect(d.attachments).toEqual([
      { name: 'capture.png', mime: 'image/png', size: png.length },
      { name: 'main-error.log', mime: 'text/plain', size: Buffer.byteLength(log) }
    ])
  })

  it('첨부 본문: 관리자 200 · 같은 기기 200 · 다른 기기 403 · 아무것도 없이 403', async () => {
    const url = `${base}/api/reports/${id}/files/capture.png`
    const a = await fetch(url, { headers: admin })
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await a.arrayBuffer())).toEqual(png)
    expect((await fetch(url, { headers: { 'X-ARA-Device': DEV } })).status).toBe(200)
    expect((await fetch(url, { headers: { 'X-ARA-Device': OTHER } })).status).toBe(403)
    expect((await fetch(url)).status).toBe(403)
    expect((await fetch(url, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(403)
  })

  it('코멘트: 작성자는 서버가 정한다 · 남의 기기는 403', async () => {
    const c1 = await json(await post(`/api/reports/${id}/comments`, { body: '확인 중입니다', author: 'reporter' }, admin))
    expect(c1.comment).toMatchObject({ author: 'admin', body: '확인 중입니다' })
    const r2 = await post(`/api/reports/${id}/comments`, { body: '저도 봤어요', author: 'admin' }, { 'X-ARA-Device': DEV })
    expect(r2.status).toBe(201)
    expect((await json(r2)).comment.author).toBe('reporter')
    expect((await post(`/api/reports/${id}/comments`, { body: 'x' }, { 'X-ARA-Device': OTHER })).status).toBe(403)
    const d = await json(await fetch(`${base}/api/reports/${id}`))
    expect(d.comments.map((c: { author: string }) => c.author)).toEqual(['admin', 'reporter'])
  })

  it('PATCH: 관리자만 · 상태 값 · fixedIn 모양', async () => {
    const ok = await patch(`/api/reports/${id}`, { status: 'fixed', fixedIn: '1.0.13' }, admin)
    expect(ok.status).toBe(200)
    expect((await json(ok)).report).toMatchObject({ status: 'fixed', fixedIn: '1.0.13' })
    expect((await patch(`/api/reports/${id}`, { status: 'done' }, admin)).status).toBe(400)
    expect((await patch(`/api/reports/${id}`, { fixedIn: '1.0' }, admin)).status).toBe(400)
    expect((await patch(`/api/reports/${id}`, { status: 'open' }, { 'X-ARA-Device': DEV })).status).toBe(403)
    const fixed = await json(await fetch(base + '/api/reports?status=fixed'))
    expect(fixed.map((x: { id: string }) => x.id)).toEqual([id])
  })

  it('허용 목록 밖 첨부 이름 · 틀린 mime · 깨진 base64 · 필수 누락 → 400', async () => {
    const bad = async (over: Record<string, unknown>) => {
      const r = await post('/api/reports', report({ deviceId: 'dev-bad', ...over }))
      expect(r.status).toBe(400)
      expect(typeof (await json(r)).error).toBe('string')
    }
    await bad({ attachments: [{ name: '../x', mime: 'text/plain', base64: b64('x') }] })
    await bad({ attachments: [{ name: 'a.exe', mime: 'text/plain', base64: b64('x') }] })
    await bad({ attachments: [{ name: 'capture.png', mime: 'text/html', base64: b64('x') }] })
    await bad({ attachments: [{ name: 'main-error.log', mime: 'text/plain', base64: '!!!!' }] })
    await bad({ title: '' })
    await bad({ title: 'x'.repeat(201) })
    await bad({ happened: undefined })
    await bad({ deviceId: undefined })
    // 첨부 파일 경로로 폴더 밖을 못 읽는다
    const r = await fetch(`${base}/api/reports/${id}/files/..%2F..%2Fx`, { headers: admin })
    expect(r.status).toBe(404)
  })

  it('분당 6번째 신고는 429', async () => {
    const dev = { deviceId: 'dev-rate', attachments: [] }
    for (let i = 0; i < 5; i++) expect((await post('/api/reports', report(dev))).status).toBe(201)
    const r = await post('/api/reports', report(dev))
    expect(r.status).toBe(429)
    expect((await json(r)).error).toBeTruthy()
  })

  it('R14 관리자 확인: 맞으면 200 {ok:true} · 틀리거나 없으면 403 · GET 만', async () => {
    const check = (h: Record<string, string> = {}, method = 'GET') => fetch(base + '/api/admin/check', { method, headers: h })
    const ok = await check(admin)
    expect(ok.status).toBe(200)
    expect(await json(ok)).toEqual({ ok: true })
    expect((await check({ Authorization: 'Bearer wrong' })).status).toBe(403)
    expect((await check()).status).toBe(403)
    expect((await check({ 'X-ARA-Device': DEV })).status).toBe(403)
    expect((await check(admin, 'POST')).status).toBe(405)
  })

  it('CORS: 사이트 출처만 연다', async () => {
    const pre = await fetch(base + '/api/reports', {
      method: 'OPTIONS',
      headers: { Origin: 'http://192.168.100.56:8899', 'Access-Control-Request-Method': 'PATCH' }
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://192.168.100.56:8899')
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-ARA-Device')
    const evil = await fetch(base + '/api/reports', { headers: { Origin: 'http://evil.example' } })
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('🔴 어떤 응답 본문에도 기기 ID 가 없다', async () => {
    // 목록·상세·코멘트를 한 번 더 모아 둔 뒤 전부 훑는다
    await text(await fetch(base + '/api/reports'))
    await text(await fetch(`${base}/api/reports/${id}`))
    await text(await post(`/api/reports/${id}/comments`, { body: '끝' }, { 'X-ARA-Device': DEV }))
    expect(bodies.length).toBeGreaterThan(20)
    for (const b of bodies) {
      expect(b).not.toContain(DEV)
      expect(b).not.toContain('dev-rate')
      expect(b).not.toContain('deviceId')
    }
  })

  it('🔴 관리 비밀번호가 비면 PATCH 는 거절된다(빈 Bearer 로도)', async () => {
    await stop()
    await start({ ARA_REPORTS_ADMIN_PW: '' })
    for (const h of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer' }, admin]) {
      expect((await patch(`/api/reports/${id}`, { status: 'closed' }, h)).status).toBe(403)
    }
    expect((await fetch(`${base}/api/reports/${id}/files/capture.png`, { headers: { Authorization: 'Bearer ' } })).status).toBe(403)
    // R14: 확인 API 도 빈 비밀번호 설정에선 늘 403 — 사이트가 "관리자로 보는 중"을 못 띄운다
    for (const h of [{}, { Authorization: 'Bearer ' }, admin]) {
      expect((await fetch(base + '/api/admin/check', { headers: h })).status).toBe(403)
    }
    expect((await json(await fetch(`${base}/api/reports/${id}`))).status).toBe('fixed')
  })
})
