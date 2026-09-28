// #206 세 갈래가 **서로 맞물리는가** — 아라의 보내는 코드(buildReport·postReport)로 **진짜 서버**
// (server/reports/server.mjs)를 친다.
//
// 왜 따로 있나: 서버 시험은 fetch 로 손수 만든 본문을 보내고, 아라 시험은 가짜 fetch 를 쓴다.
// 둘 다 초록이어도 **서로 다른 계약을 믿고 있으면** 실제로는 안 붙는다. 여기가 둘을 한 번에 본다.
// 실서버는 안 친다 — 임시 포트·임시 폴더에 서버를 자식 프로세스로 띄운다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, postReport } from '../src/main/report/BugReport'

const PORT = 18897
const API = `http://127.0.0.1:${PORT}`
const ADMIN = 'e2e-only-not-a-real-password'
const DEVICE = '11111111-2222-4333-8444-555555555555'
let dir = ''
let proc: ChildProcess | null = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-reports-e2e-'))
  proc = spawn(process.execPath, [join(__dirname, '..', 'server', 'reports', 'server.mjs')], {
    env: { ...process.env, ARA_REPORTS_PORT: String(PORT), ARA_REPORTS_DIR: dir, ARA_REPORTS_ADMIN_PW: ADMIN },
    stdio: 'ignore'
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${API}/api/reports`)).ok) return
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('서버가 안 떴다')
})

afterAll(() => {
  proc?.kill()
  rmSync(dir, { recursive: true, force: true })
})

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

describe('#206 아라 → 진짜 서버', () => {
  let id = ''

  it('아라가 만든 본문을 서버가 받는다 — 번호가 나오고, 보낸 첨부가 하나도 바뀌지 않았다', async () => {
    const built = buildReport(
      {
        title: '떼어낸 창에서 재접속 실패',
        what: '탭을 새 창으로 뺐다',
        happened: '눌러도 아무 일이 없다',
        expected: '',
        name: '시험',
        gpu: 'test',
        capture: png,
        log: 'line1\nmysql -pSECRET\n',
        rendererErrors: [{ at: 1, message: 'boom', stack: 'at x' }],
        settings: true
      },
      { deviceId: DEVICE, version: '1.0.13', os: 'test', electron: '31', sessions: { ssh: 1 }, settings: '{}' }
    )
    const res = await postReport(API, built)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.number).toBe(1)
    expect(res.tampered).toEqual([]) // 🔴 계약의 해시와 아라의 해시가 같은 방식이어야 이렇게 된다
    id = res.id
  })

  it('🔴 목록·상세 어디에도 기기 ID 가 없다', async () => {
    const list = await (await fetch(`${API}/api/reports`)).text()
    const detail = await (await fetch(`${API}/api/reports/${id}`)).text()
    expect(list).toContain('떼어낸 창에서 재접속 실패')
    expect(list + detail).not.toContain(DEVICE)
  })

  it('🔴 로그는 마스킹된 채로 저장됐다(관리자로 열어 본다)', async () => {
    const r = await fetch(`${API}/api/reports/${id}/files/main-error.log`, {
      headers: { Authorization: `Bearer ${ADMIN}` }
    })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).not.toContain('SECRET')
  })

  it('첨부는 같은 기기면 열리고, 다른 기기·익명은 막힌다', async () => {
    const at = (h: Record<string, string>) => fetch(`${API}/api/reports/${id}/files/capture.png`, { headers: h })
    expect((await at({ 'X-ARA-Device': DEVICE })).status).toBe(200)
    expect((await at({ 'X-ARA-Device': '99999999-2222-4333-8444-555555555555' })).status).toBe(403)
    expect((await at({})).status).toBe(403)
  })

  it('서버가 꺼져 있으면 network 로 돌아온다 — 다시 보내지 않는다', async () => {
    const built = buildReport(
      { title: 'x', what: '', happened: 'y', expected: '', name: '', gpu: '' },
      { deviceId: DEVICE, version: '1', os: '', electron: '', sessions: {}, settings: '{}' }
    )
    let calls = 0
    const counting = ((...a: Parameters<typeof fetch>) => {
      calls++
      return fetch(...a)
    }) as typeof fetch
    const res = await postReport('http://127.0.0.1:1', built, counting)
    expect(res).toEqual({ ok: false, reason: 'network' })
    expect(calls).toBe(1)
  })
})
