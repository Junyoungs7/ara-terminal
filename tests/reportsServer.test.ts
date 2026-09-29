/**
 * #206 신고 서버(server/reports/server.mjs) — 계약 docs/bug-report-api.md.
 * 서버를 **실제 프로세스로** 임시 포트(0) + 임시 폴더에 띄워 fetch 로 친다.
 * 다시 띄우기 검사가 있어서 모듈 import 가 아니라 자식 프로세스다.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function start(env: Record<string, string> = {}, server = SERVER): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [server], {
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

/**
 * R16 `/api/mine` 의 두 약속 — 남의 신고가 안 나온다 · 기기 ID 가 안 나온다. 어긋난 것을 문장으로 돌려준다
 * (빈 배열이면 지킨 것). 위반을 심은 서버에도 같은 함수를 대서 이 검사가 헛돌지 않는지 잰다.
 */
async function mineProblems(dev: string, mineIds: string[]): Promise<string[]> {
  const r = await fetch(base + '/api/mine', { headers: { 'X-ARA-Device': dev } })
  const raw = await text(r)
  const out: string[] = []
  if (r.status !== 200) out.push(`상태 ${r.status}`)
  if (raw.includes(dev) || raw.includes('deviceId')) out.push('기기 ID 가 나왔다')
  const ids = (JSON.parse(raw) as { id: string }[]).map((x) => x.id)
  if (JSON.stringify(ids) !== JSON.stringify(mineIds)) out.push(`목록이 다르다: ${ids.join(',')}`)
  return out
}

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

  it('R16 /api/mine: 내 것만 · 기기 ID 없음 · 헤더 없으면 400', async () => {
    const all = await json(await fetch(base + '/api/reports'))
    const otherId = all.find((x: { number: number }) => x.number === 2).id
    expect(await mineProblems(DEV, [id])).toEqual([])
    expect(await mineProblems(OTHER, [otherId])).toEqual([])
    expect(await mineProblems('dev-nobody', [])).toEqual([])
    const mine = await json(await fetch(base + '/api/mine', { headers: { 'X-ARA-Device': DEV } }))
    expect(Object.keys(mine[0]).sort()).toEqual(
      ['comments', 'fixedIn', 'id', 'lastAdminCommentAt', 'number', 'status', 'title', 'updatedAt'].sort()
    )
    const detail = await json(await fetch(`${base}/api/reports/${id}`))
    const adminAt = detail.comments.filter((c: { author: string }) => c.author === 'admin').pop().at
    expect(mine[0]).toMatchObject({ number: 1, status: 'fixed', fixedIn: '1.0.13', comments: 2, lastAdminCommentAt: adminAt })
    for (const h of [{}, { 'X-ARA-Device': '' }] as Record<string, string>[]) {
      const r = await fetch(base + '/api/mine', { headers: h })
      expect(r.status).toBe(400)
      expect(typeof (await json(r)).error).toBe('string')
    }
    expect((await fetch(base + '/api/mine', { method: 'POST', headers: { 'X-ARA-Device': DEV } })).status).toBe(405)
  })

  it('R16 /api/mine: 내 답글은 lastAdminCommentAt 을 안 바꾸고, PATCH 는 updatedAt 을 바꾼다', async () => {
    const get = async () => (await json(await fetch(base + '/api/mine', { headers: { 'X-ARA-Device': DEV } })))[0]
    const before = await get()
    await new Promise((r) => setTimeout(r, 5))
    expect((await post(`/api/reports/${id}/comments`, { body: '고맙습니다' }, { 'X-ARA-Device': DEV })).status).toBe(201)
    const afterReply = await get()
    expect(afterReply.lastAdminCommentAt).toBe(before.lastAdminCommentAt)
    expect(afterReply.comments).toBe(before.comments + 1)
    await new Promise((r) => setTimeout(r, 5))
    expect((await patch(`/api/reports/${id}`, { status: 'investigating' }, admin)).status).toBe(200)
    const afterPatch = await get()
    expect(afterPatch.status).toBe('investigating')
    expect(afterPatch.updatedAt).toBeGreaterThan(afterReply.updatedAt)
    // 뒤 시험들이 기대하는 상태로 되돌린다
    expect((await patch(`/api/reports/${id}`, { status: 'fixed' }, admin)).status).toBe(200)
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

  it('🔴 비밀번호가 비었으면 확인 API 가 "설정되지 않았습니다"로 말한다 — 틀림과 가른다', async () => {
    // 위 시험이 빈 비밀번호로 다시 띄워 둔 상태다.
    const r = await fetch(base + '/api/admin/check', { headers: admin })
    expect(r.status).toBe(403)
    expect((await json(r)).error).toContain('설정되지 않았습니다')
  })

  it('🔴 한글이 든 비밀번호도 된다 — 사이트는 b64: 로 싣는다(브라우저는 한글을 헤더에 못 싣는다)', async () => {
    const KO = '아라관리자!@#'
    await stop()
    await start({ ARA_REPORTS_ADMIN_PW: KO })
    const b64 = (s: string) => 'Bearer b64:' + Buffer.from(s, 'utf8').toString('base64')
    const check = (h: Record<string, string>) => fetch(base + '/api/admin/check', { headers: h })
    expect((await check({ Authorization: b64(KO) })).status).toBe(200)
    expect((await check({ Authorization: b64('아라관리자') })).status).toBe(403)
    const wrong = await check({ Authorization: b64('틀림') })
    expect((await json(wrong)).error).toContain('맞지 않습니다')
  })

  it('🔴 위반 심기: /api/mine 이 기기 ID 를 싣거나 남의 신고를 내면 mineProblems 가 문다', async () => {
    const src = readFileSync(SERVER, 'utf8')
    const leak = src.replace('const publicMine = (r) => ({', 'const publicMine = (r) => ({ deviceId: r.deviceId,')
    const everyone = src.replace('.filter((r) => isReporter(req, r))', '.filter(() => true)')
    expect(leak).not.toBe(src)
    expect(everyone).not.toBe(src)
    const all = await json(await fetch(base + '/api/reports'))
    const one = all.find((x: { number: number }) => x.number === 1).id
    for (const [name, bad, want] of [
      ['leak', leak, '기기 ID 가 나왔다'],
      ['everyone', everyone, '목록이 다르다']
    ] as const) {
      const f = join(dir, `server-${name}.mjs`)
      writeFileSync(f, bad)
      await stop()
      await start({}, f)
      const problems = await mineProblems(DEV, [one])
      expect(problems.some((p) => p.startsWith(want))).toBe(true)
      rmSync(f)
    }
  })
})
