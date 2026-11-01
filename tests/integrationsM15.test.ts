// M15 R1 연동 — GitLab REST(모의 HTTP 서버) · Slack Socket Mode(모의 Slack API + 모의 WebSocket 서버) · 명령. 진짜 GitLab·slack.com 에 닿지 않는다.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { integrationsPrefsOf, normalizeBaseUrl, parseGitRemote, projectPathFor, slackUsersOf } from '../src/shared/integrations'
import { createGitLabClient, type FetchLike } from '../src/main/integrations/gitlab'
import { startSlackSocket, type SlackFetch, type SlackMessage } from '../src/main/integrations/slack'
import { isSlackCommand, runSlackCommand, type SlackTab } from '../src/main/integrations/slackCommands'

const servers: { close(cb?: () => void): void }[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string }
async function mockHttp(reply: (s: Seen) => { status: number; body: unknown }): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const srv: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
      seen.push(s)
      const r = reply(s)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  servers.push(srv)
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen }
}
const fetchLike = ((url: string, init: RequestInit) => fetch(url, init)) as unknown as FetchLike & SlackFetch

describe('shared/integrations', () => {
  it('기본 꺼짐 · 모양이 아닌 값은 버린다', () => {
    const p = integrationsPrefsOf(null)
    expect(p.gitlab.enabled).toBe(false)
    expect(p.slack.enabled).toBe(false)
    expect(integrationsPrefsOf({ slack: { channel: 'not a channel', users: 'U111, bad u, U222 U111' } }).slack).toMatchObject({ channel: '', users: ['U111', 'U222'] })
    expect(slackUsersOf(['U1A', 3, 'x'])).toEqual(['U1A'])
  })
  it('주소 정리', () => {
    expect(normalizeBaseUrl(' https://git.corp.kr/ ')).toBe('https://git.corp.kr')
    expect(normalizeBaseUrl('ftp://x')).toBe('')
    expect(normalizeBaseUrl('nope')).toBe('')
  })
  it('원격 → 프로젝트 경로, 다른 호스트면 null(토큰을 보내지 않는다)', () => {
    expect(parseGitRemote('git@git.corp.kr:grp/sub/app.git')).toEqual({ host: 'git.corp.kr', path: 'grp/sub/app' })
    expect(parseGitRemote('ssh://git@git.corp.kr:2222/grp/app.git')).toEqual({ host: 'git.corp.kr', path: 'grp/app' })
    expect(projectPathFor('https://git.corp.kr', 'https://git.corp.kr/grp/app.git')).toBe('grp/app')
    expect(projectPathFor('https://git.corp.kr/gitlab', 'https://git.corp.kr/gitlab/grp/app.git')).toBe('grp/app')
    expect(projectPathFor('https://git.corp.kr', 'git@github.com:grp/app.git')).toBeNull()
    expect(projectPathFor('', 'git@git.corp.kr:grp/app.git')).toBeNull()
  })
})

describe('GitLab 클라이언트(모의 서버)', () => {
  it('MR 목록 — 토큰 머리·인코딩된 프로젝트·상태 매핑', async () => {
    const m = await mockHttp(() => ({
      status: 200,
      body: [{ iid: 7, title: 'Draft: 로그인 고침', state: 'opened', web_url: 'http://x/7', source_branch: 'fix', target_branch: 'main', author: { username: 'jy' }, head_pipeline: { status: 'running' }, detailed_merge_status: 'mergeable' }]
    }))
    const r = await createGitLabClient(fetchLike, m.base, 'tok-123').listMrs('grp/app', 'opened')
    expect(r.ok && r.mrs[0]).toMatchObject({ iid: 7, draft: true, pipeline: 'running', merge: 'mergeable', author: 'jy', source: 'fix' })
    expect(m.seen[0]!.url).toContain('/api/v4/projects/grp%2Fapp/merge_requests?')
    expect(m.seen[0]!.url).toContain('state=opened')
    expect(m.seen[0]!.headers['private-token']).toBe('tok-123')
  })
  it('MR 만들기 — POST 본문, 409 는 exists, 401 은 token, 오류 글에 토큰이 없다', async () => {
    let status = 201
    const m = await mockHttp((s) => (s.method === 'POST' ? { status, body: status === 201 ? { iid: 9, title: 't', web_url: 'http://x/9' } : { message: ['Another open merge request already exists'] } } : { status: 401, body: { message: '401 Unauthorized' } }))
    const c = createGitLabClient(fetchLike, m.base, 'secret-tok')
    const ok = await c.createMr('grp/app', { source: 'fix', target: 'main', title: 't', description: 'd' })
    expect(ok.ok && ok.mr.iid).toBe(9)
    expect(JSON.parse(m.seen[0]!.body)).toEqual({ source_branch: 'fix', target_branch: 'main', title: 't', description: 'd' })
    status = 409
    const dup = await c.createMr('grp/app', { source: 'fix', target: 'main', title: 't', description: '' })
    expect(dup).toMatchObject({ ok: false, error: 'exists' })
    const v = await c.viewer()
    expect(v).toMatchObject({ ok: false, error: 'token' })
    expect(JSON.stringify([dup, v])).not.toContain('secret-tok')
  })
  it('닿지 못하면 network', async () => {
    const r = await createGitLabClient(fetchLike, 'http://127.0.0.1:1', 't').viewer()
    expect(r).toMatchObject({ ok: false, error: 'network' })
  })
})

describe('Slack 명령', () => {
  const approval = JSON.stringify({ approval: { tool: 'Write', summary: 'a.txt' } })
  const question = JSON.stringify({ questions: [{ question: '어느 쪽?', multiSelect: false, options: [{ label: '왼쪽' }, { label: '오른쪽' }] }] })
  const tabs: SlackTab[] = [
    { n: 1, sessionId: 's1', label: 'Claude Code · app', agent: 'claude', state: 'blocked', ask: approval },
    { n: 2, sessionId: 's2', label: 'Codex · web', agent: 'codex', state: 'blocked', ask: question },
    { n: 3, sessionId: 's3', label: 'Claude Code · x', agent: 'claude', state: 'working' }
  ]
  it('상태·질문·도움', () => {
    expect(runSlackCommand('<@UBOT> 상태', tabs).text).toContain('[3] Claude Code · x — 일하는 중')
    const q = runSlackCommand('질문', tabs).text
    expect(q).toContain('Write 실행을 허용할까요?')
    expect(q).toContain('2. 오른쪽')
    expect(runSlackCommand('rm -rf', tabs).text).toContain('아라 명령')
    expect(isSlackCommand('안녕하세요')).toBe(false)
    expect(isSlackCommand('<@UBOT> status')).toBe(true)
  })
  it('승인 답 = 허용 1 / 거부 Esc, 질문 답 = 그 에이전트의 키', () => {
    expect(runSlackCommand('답 1 허용', tabs).answer).toEqual({ sessionId: 's1', groups: [{ raw: '1' }] })
    expect(runSlackCommand('answer 1 deny', tabs).answer?.groups).toEqual([{ raw: '\x1b' }])
    expect(runSlackCommand('답 2 2', tabs).answer).toEqual({ sessionId: 's2', groups: [{ raw: '2' }] })
    expect(runSlackCommand('답 2 5', tabs).answer).toBeUndefined()
    expect(runSlackCommand('답 3 허용', tabs).answer).toBeUndefined()
    expect(runSlackCommand('답 9 허용', tabs).answer).toBeUndefined()
  })
})

describe('Slack Socket Mode(모의 서버)', () => {
  it('열기 → hello → 봉투 받음 응답 → 메시지 전달(봇 글 무시) → 글 올리기 · disconnect 뒤 다시 붙음', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    servers.push(wss)
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const acks: string[] = []
    let conns = 0
    wss.on('connection', (c) => {
      conns++
      c.on('message', (d) => acks.push(JSON.parse(String(d)).envelope_id))
      c.send(JSON.stringify({ type: 'hello' }))
      if (conns === 1) {
        c.send(JSON.stringify({ envelope_id: 'e0', type: 'events_api', payload: { event: { type: 'message', bot_id: 'B1', user: 'U1', channel: 'C1', text: 'x', ts: '1' } } }))
        c.send(JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', user: 'U1', channel: 'C1', channel_type: 'channel', text: '상태', ts: '2' } } }))
        setTimeout(() => c.send(JSON.stringify({ type: 'disconnect' })), 100)
      }
    })
    const api = await mockHttp((s) => (s.url.endsWith('apps.connections.open') ? { status: 200, body: { ok: true, url: wsUrl } } : { status: 200, body: { ok: true } }))
    const links: string[] = []
    const msgs: SlackMessage[] = []
    const sock = startSlackSocket({ fetch: fetchLike, appToken: 'xapp-1', botToken: 'xoxb-1', apiBase: api.base, onLink: (l) => links.push(l), onMessage: (m) => msgs.push(m) })
    await expect.poll(() => conns, { timeout: 5000 }).toBe(2)
    await expect.poll(() => msgs.length).toBe(1)
    expect(msgs[0]).toMatchObject({ user: 'U1', channel: 'C1', text: '상태' })
    expect(acks).toEqual(expect.arrayContaining(['e0', 'e1']))
    expect(links).toContain('connected')
    expect(await sock.post('C1', '안녕', '2')).toBe(true)
    const post = api.seen.find((s) => s.url.endsWith('chat.postMessage'))!
    expect(post.headers.authorization).toBe('Bearer xoxb-1')
    expect(JSON.parse(post.body)).toEqual({ channel: 'C1', text: '안녕', thread_ts: '2' })
    expect(api.seen.find((s) => s.url.endsWith('apps.connections.open'))!.headers.authorization).toBe('Bearer xapp-1')
    sock.stop()
    expect(links.at(-1)).toBe('off')
  })
  it('토큰 오류(invalid_auth)는 다시 붙지 않고 error', async () => {
    const api = await mockHttp(() => ({ status: 200, body: { ok: false, error: 'invalid_auth' } }))
    const links: string[] = []
    const sock = startSlackSocket({ fetch: fetchLike, appToken: 'x', botToken: 'y', apiBase: api.base, onLink: (l) => links.push(l), onMessage: () => {} })
    await expect.poll(() => links.at(-1)).toBe('error')
    await new Promise((r) => setTimeout(r, 1200))
    expect(api.seen.length).toBe(1)
    sock.stop()
  })
})
