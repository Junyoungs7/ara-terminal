// R16 [내 신고] — main 쪽(MyReports.ts)을 **진짜 서버**(server/reports/server.mjs, 임시 포트·임시 폴더)에 붙여 본다.
// 새 것 판정 · 한 번만 알림 · 읽음 · 내 답글은 새 것이 아님 · 보낸 적 없으면 안 묻는다 · 닿지 못하면 조용히.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkMine, fetchDetail, MY_REPORTS_FILE, newsKind, postReply, recordSent } from '../src/main/report/MyReports'

const ADMIN = 'r16-test-only-pw'
const DEVICE = '22222222-3333-4444-8555-666666666666'
const OTHER = '99999999-3333-4444-8555-666666666666'
const admin = { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }
let dir = ''
let ud = ''
let api = ''
let proc: ChildProcess | null = null

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ara-mine-srv-'))
  ud = mkdtempSync(join(tmpdir(), 'ara-mine-ud-'))
  await new Promise<void>((ok, fail) => {
    proc = spawn(process.execPath, [resolve('server/reports/server.mjs')], {
      env: { ...process.env, ARA_REPORTS_PORT: '0', ARA_REPORTS_DIR: dir, ARA_REPORTS_ADMIN_PW: ADMIN },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    proc.stdout!.on('data', (d) => {
      out += d
      const m = /listening on (\d+)/.exec(out)
      if (m) {
        api = `http://127.0.0.1:${m[1]}`
        ok()
      }
    })
    proc.on('exit', (c) => fail(new Error(`서버가 죽음(${c}): ${out}`)))
  })
})

afterAll(() => {
  proc?.removeAllListeners('exit')
  proc?.kill()
  rmSync(dir, { recursive: true, force: true })
  rmSync(ud, { recursive: true, force: true })
})

const send = async (deviceId: string, title: string): Promise<string> => {
  const r = await fetch(`${api}/api/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, happened: '안 된다', deviceId })
  })
  return ((await r.json()) as { id: string }).id
}
const adminComment = (id: string, body: string) =>
  fetch(`${api}/api/reports/${id}/comments`, { method: 'POST', headers: admin, body: JSON.stringify({ body }) })
const adminPatch = (id: string, b: object) =>
  fetch(`${api}/api/reports/${id}`, { method: 'PATCH', headers: admin, body: JSON.stringify(b) })

/** 폴링을 흉내 — 나오는 fetch 를 센다(보낸 적 없으면 0번이어야 한다). */
let calls = 0
const counted: typeof fetch = (input, init) => {
  calls++
  return fetch(input, init)
}

describe('R16 내 신고 — main ↔ 진짜 서버', () => {
  let mine = ''

  it('보낸 신고가 없으면 서버에 묻지 않는다', async () => {
    mine = await send(DEVICE, '내 신고')
    await send(OTHER, '남의 신고')
    calls = 0
    expect(await checkMine(api, DEVICE, ud, counted)).toEqual({ ok: true, items: [], news: [] })
    expect(calls).toBe(0)
  })

  it('보낸 뒤: 내 것만 나오고, 막 보낸 것은 새 것이 아니다', async () => {
    recordSent(ud, mine)
    const r = await checkMine(api, DEVICE, ud, counted)
    expect(calls).toBe(1)
    expect(r.ok && r.items.map((i) => i.id)).toEqual([mine])
    expect(r.ok && r.items[0].fresh).toBe(false)
    expect(r.ok && r.news).toEqual([])
  })

  it('관리자 댓글 → 한 번만 알린다 · 읽기 전까지 점은 남는다', async () => {
    await adminComment(mine, '확인해 보겠습니다')
    const a = await checkMine(api, DEVICE, ud)
    expect(a.ok && a.news.map((n) => n.kind)).toEqual(['comment'])
    expect(a.ok && a.items[0].fresh).toBe(true)
    const b = await checkMine(api, DEVICE, ud)
    expect(b.ok && b.news).toEqual([]) // 같은 것은 두 번 안 띄운다
    expect(b.ok && b.items[0].fresh).toBe(true)
  })

  it('상세를 열면 읽음 — 점이 사라지고, 내 답글은 새 것이 아니다', async () => {
    const d = await fetchDetail(api, DEVICE, ud, mine)
    expect(d.ok && d.report.comments.map((c) => c.author)).toEqual(['admin'])
    expect(await checkMine(api, DEVICE, ud)).toMatchObject({ ok: true, items: [{ fresh: false }], news: [] })
    const rep = await postReply(api, DEVICE, mine, '감사합니다')
    expect(rep.ok && rep.comment.author).toBe('reporter')
    const after = await checkMine(api, DEVICE, ud)
    expect(after).toMatchObject({ ok: true, items: [{ fresh: false, comments: 2 }], news: [] })
  })

  it('상태·고친 판 변경도 새 것이다', async () => {
    await adminPatch(mine, { status: 'fixed', fixedIn: '1.0.16' })
    const r = await checkMine(api, DEVICE, ud)
    expect(r.ok && r.news).toEqual([{ id: mine, number: 1, kind: 'status', status: 'fixed', fixedIn: '1.0.16' }])
  })

  it('남의 기기로는 답글이 거절되고, 이상한 id 는 주소에 붙지도 않는다', async () => {
    const r = await postReply(api, OTHER, mine, '끼어들기')
    expect(r).toMatchObject({ ok: false, reason: 'server' })
    calls = 0
    expect(await fetchDetail(api, DEVICE, ud, '../admin/check', counted)).toMatchObject({ ok: false })
    expect(await postReply(api, DEVICE, 'r-1/../../x', 'x', counted)).toMatchObject({ ok: false })
    expect(calls).toBe(0)
  })

  it('닿지 못하면 조용히 ok:false', async () => {
    expect(await checkMine('http://127.0.0.1:1', DEVICE, ud)).toEqual({ ok: false })
  })

  it('🔴 저장 파일·돌려준 값 어디에도 기기 ID 가 없다', async () => {
    const r = await checkMine(api, DEVICE, ud)
    const d = await fetchDetail(api, DEVICE, ud, mine)
    for (const s of [JSON.stringify(r), JSON.stringify(d), readFileSync(join(ud, MY_REPORTS_FILE), 'utf8')]) {
      expect(s).not.toContain(DEVICE)
      expect(s).not.toContain('deviceId')
    }
  })
})

describe('newsKind', () => {
  const base = { id: 'r-1', number: 1, title: 't', status: 'open', fixedIn: null, updatedAt: 5, lastAdminCommentAt: null, comments: 0 }
  it('본 적 없고 그대로면 새 것이 아니다', () => expect(newsKind(base)).toBeNull())
  it('관리자 댓글이 본 시각보다 뒤면 comment', () =>
    expect(newsKind({ ...base, lastAdminCommentAt: 9 }, { at: 3, status: 'open', fixedIn: null })).toBe('comment'))
  it('같은 시각이면 아니다', () =>
    expect(newsKind({ ...base, lastAdminCommentAt: 9 }, { at: 9, status: 'open', fixedIn: null })).toBeNull())
  it('fixedIn 만 바뀌어도 status', () =>
    expect(newsKind({ ...base, fixedIn: '1.0.16' }, { at: 0, status: 'open', fixedIn: null })).toBe('status'))
})

describe('🔴 [내 신고] 창 — 소스 규칙', () => {
  const src = readFileSync('src/renderer/components/MyReportsModal.tsx', 'utf8')
  // 서버 글을 HTML 로 그리는 길 · 바깥 클릭으로 닫는 길(신고 #6) — 둘 다 없어야 한다.
  const bad = (s: string): string[] => [
    ...(/dangerouslySetInnerHTML|innerHTML\s*=/.test(s) ? ['html'] : []),
    ...(/className="overlay open"\s+onClick=/.test(s) ? ['backdrop'] : [])
  ]
  it('지금 소스는 지킨다', () => expect(bad(src)).toEqual([]))
  it('위반을 심은 소스는 문다', () => {
    expect(bad(src.replace('<p className="mr-text">{c.body}</p>', '<p dangerouslySetInnerHTML={{ __html: c.body }} />'))).toEqual(['html'])
    expect(bad(src.replace('<div className="overlay open">', '<div className="overlay open" onClick={onClose}>'))).toEqual(['backdrop'])
  })
})
