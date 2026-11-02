// M15 R1 연동 — GitLab REST(모의 HTTP 서버) · Slack Socket Mode(모의 Slack API + 모의 WebSocket 서버) · 명령. 진짜 GitLab·slack.com 에 닿지 않는다.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { integrationsPrefsOf, normalizeBaseUrl, parseGitRemote, projectPathFor, slackUsersOf } from '../src/shared/integrations'
import { createGitLabClient, type FetchLike } from '../src/main/integrations/gitlab'
import { startSlackSocket, type SlackFetch, type SlackMessage } from '../src/main/integrations/slack'
import { cleanSlackText, describeTurnEnd, isSlackCommand, runSlackCommand, type SlackTab } from '../src/main/integrations/slackCommands'
import { createConnectorSeam, redactSecrets, turnResult, TURN_RESULT_MAX_CHARS, type ConnectorHost } from '../src/main/integrations/connector'

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

describe('Slack 명령 → 커넥터 이음새(IN-02b)', () => {
  const approval = JSON.stringify({ approval: { tool: 'Write', summary: 'a.txt' } })
  const question = JSON.stringify({ questions: [{ question: '어느 쪽?', multiSelect: false, options: [{ label: '왼쪽' }, { label: '오른쪽' }] }] })
  function fakeHost(allowRun = false) {
    const tabs: SlackTab[] = [
      { n: 1, sessionId: 's1', label: 'Claude Code · app', agent: 'claude', state: 'blocked', ask: approval },
      { n: 2, sessionId: 's2', label: 'Codex · web', agent: 'codex', state: 'blocked', ask: question },
      { n: 3, sessionId: 's3', label: 'Claude Code · x', agent: 'claude', state: 'working' }
    ]
    const calls: unknown[][] = []
    let screen = ''
    const host: ConnectorHost = {
      tabs: () => tabs,
      answer: (id, groups) => (calls.push(['answer', id, groups]), { ok: true }),
      followUp: (id, text) => (calls.push(['send', id, text]), { ok: true }),
      screen: async () => screen,
      launch: async (req) => {
        calls.push(['launch', req])
        if (req.worktree === 'nope') return { ok: false, error: '작업 단위를 못 찾았습니다: nope' }
        tabs.push({ n: 4, sessionId: 's4', label: 'Claude Code · feat', agent: req.agent, state: 'working' })
        return { ok: true, sessionId: 's4' }
      }
    }
    const seam = createConnectorSeam(host, { allowRun: () => allowRun })
    return { tabs, calls, seam, setScreen: (t: string) => (screen = t) }
  }
  const ctx = (thread: string, ts = thread) => ({ key: { source: 'slack', externalId: `C1 ${thread}` }, deliveryId: ts })

  it('상태·질문·도움 · 채널 명령 판별 · Slack 꾸밈 벗기기', async () => {
    const { seam } = fakeHost()
    expect(await runSlackCommand('<@UBOT> 상태', seam, ctx('1'))).toContain('[3] Claude Code · x — 일하는 중')
    const q = await runSlackCommand('질문', seam, ctx('1'))
    expect(q).toContain('Write 실행을 허용할까요?')
    expect(q).toContain('2. 오른쪽')
    expect(await runSlackCommand('rm -rf', seam, ctx('1'))).toContain('아라 명령')
    expect(isSlackCommand('안녕하세요')).toBe(false)
    expect(isSlackCommand('<@UBOT> status')).toBe(true)
    expect(isSlackCommand('시작 a claude 해')).toBe(true)
    expect(cleanSlackText('지시 1 &lt;b&gt; &amp; <https://x.y/a|x.y/a>')).toBe('지시 1 <b> & https://x.y/a')
  })

  it('답 — 승인 허용 1 / 거부 Esc, 질문은 그 에이전트의 키, 범위 밖·답 대기 아님은 거절', async () => {
    const { seam, calls } = fakeHost()
    expect(await runSlackCommand('답 1 허용', seam, ctx('1'))).toContain('[1] 허용했습니다')
    expect(await runSlackCommand('answer 1 deny', seam, ctx('2'))).toContain('거부했습니다')
    expect(await runSlackCommand('답 2 2', seam, ctx('3'))).toContain('"오른쪽" 로 답했습니다')
    expect(await runSlackCommand('답 2 5', seam, ctx('4'))).toContain('1~2 중')
    expect(await runSlackCommand('답 3 허용', seam, ctx('5'))).toContain('지금 답을 기다리지 않습니다')
    expect(await runSlackCommand('답 9 허용', seam, ctx('6'))).toContain('그 번호의 탭이 없습니다')
    expect(await runSlackCommand('답 허용', seam, ctx('7'))).toContain('이어진 탭이 없습니다')
    expect(calls).toEqual([
      ['answer', 's1', [{ raw: '1' }]],
      ['answer', 's1', [{ raw: '\x1b' }]],
      ['answer', 's2', [{ raw: '2' }]]
    ])
  })

  it('시작·지시는 스위치가 꺼져 있으면 거절(아무것도 띄우거나 쓰지 않는다)', async () => {
    const { seam, calls } = fakeHost(false)
    expect(await runSlackCommand('시작 feat claude 고쳐 줘', seam, ctx('10'))).toContain('꺼져 있습니다')
    expect(await runSlackCommand('지시 3 더 해 줘', seam, ctx('11'))).toContain('꺼져 있습니다')
    expect(calls).toEqual([])
  })

  it('시작 → 스레드에 이음 → 지시(번호 없이)·취소(Esc)·같은 글 두 번은 한 번만 · 턴 결과는 그 스레드 키로', async () => {
    const { seam, calls, tabs, setScreen } = fakeHost(true)
    await seam.tick() // 기준
    expect(await runSlackCommand('시작 feat claude 테스트 고쳐 줘\n둘째 줄', seam, ctx('20'))).toContain('시작했습니다')
    expect(calls[0]).toEqual(['launch', { agent: 'claude', worktree: 'feat', prompt: '테스트 고쳐 줘\n둘째 줄' }])
    expect(await runSlackCommand('시작 nope claude x', seam, ctx('21'))).toContain('시작하지 못했습니다 — 작업 단위를 못 찾았습니다')
    expect(await runSlackCommand('시작 feat bash x', seam, ctx('22'))).toContain('claude·codex·gemini')
    expect(await runSlackCommand('지시 이어서 해', seam, ctx('20', '20.1'))).toContain('[4] 보냈습니다')
    expect(await runSlackCommand('지시 이어서 해', seam, ctx('20', '20.1'))).toContain('[4] 보냈습니다')
    expect(calls.filter((c) => c[0] === 'send')).toEqual([['send', 's4', '이어서 해']])
    expect(await runSlackCommand('지시 해', seam, ctx('99'))).toContain('이어진 탭이 없습니다')
    expect(await runSlackCommand('지시 1 해', seam, ctx('98'))).toContain('먼저 `답`')
    expect(await runSlackCommand('취소', seam, ctx('20', '20.2'))).toContain('[4] 취소했습니다')
    expect(calls.at(-1)).toEqual(['answer', 's4', [{ raw: '\x1b' }]])
    expect(await runSlackCommand('취소 1', seam, ctx('30'))).toContain('[1] 취소했습니다')
    expect(calls.at(-1)).toEqual(['answer', 's1', [{ raw: '\x1b' }]])
    expect(await runSlackCommand('취소 2', seam, ctx('31'))).toContain('아라에서 답하세요')
    // 턴 끝 → 이어진 스레드 키 + 화면 뒤쪽(비밀 가림·테두리 뺌)
    await seam.tick()
    tabs[3]!.state = 'idle'
    setScreen('앞 출력\n╭────╮\n결과: 통과 12건\nTOKEN=abc123\nxoxb-123456789012-abcdefabcdef\n│ > │\n╰────╯\n')
    const ev = await seam.tick()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'turn-ended', key: { source: 'slack', externalId: 'C1 20' } })
    const out = (ev[0] as { lastOutput: string }).lastOutput
    expect(out).toContain('결과: 통과 12건')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('xoxb-123')
    expect(out).not.toContain('╭')
    expect(describeTurnEnd(tabs[3]!, out)).toContain('끝났습니다.\n```')
  })

  it('턴 결과 길이 상한 · 토큰 가림', () => {
    const long = Array.from({ length: 40 }, (_, i) => `${i} ${'가'.repeat(200)}`).join('\n')
    const r = turnResult(long)
    expect(r.length).toBeLessThanOrEqual(TURN_RESULT_MAX_CHARS + 1)
    expect(r).toContain('39 ')
    expect(redactSecrets('glpat-abcdefghijklmnop ghp_abcdefghijklmnop')).toBe('**** ****')
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
  it('IN-02b 왕복 — 모의 Socket Mode 로 시작 → 스레드 지시 → 같은 봉투 재전송은 한 번만 → 답 글은 그 스레드로', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    servers.push(wss)
    await new Promise<void>((r) => wss.on('listening', () => r()))
    const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const ev = (id: string, text: string, ts: string, thread?: string) =>
      JSON.stringify({ envelope_id: id, type: 'events_api', payload: { event: { type: 'message', user: 'U1', channel: 'C1', channel_type: 'channel', text, ts, ...(thread ? { thread_ts: thread } : {}) } } })
    wss.on('connection', (c) => {
      c.send(JSON.stringify({ type: 'hello' }))
      c.send(ev('e1', '시작 feat codex 테스트 돌려', '100.1'))
      setTimeout(() => {
        c.send(ev('e2', '지시 &lt;이어서&gt;', '100.2', '100.1'))
        c.send(ev('e2', '지시 &lt;이어서&gt;', '100.2', '100.1')) // Slack 재전송
      }, 150)
    })
    const api = await mockHttp((s) => (s.url.endsWith('apps.connections.open') ? { status: 200, body: { ok: true, url: wsUrl } } : { status: 200, body: { ok: true } }))
    const calls: unknown[][] = []
    const tabs: SlackTab[] = []
    const seam = createConnectorSeam(
      {
        tabs: () => tabs,
        answer: () => ({ ok: true }),
        followUp: (id, text) => (calls.push(['send', id, text]), { ok: true }),
        screen: async () => '',
        launch: async (req) => {
          calls.push(['launch', req])
          tabs.push({ n: 1, sessionId: 's9', label: 'Codex · feat', agent: req.agent, state: 'working' })
          return { ok: true, sessionId: 's9' }
        }
      },
      { allowRun: () => true }
    )
    const sock = startSlackSocket({
      fetch: fetchLike,
      appToken: 'xapp-1',
      botToken: 'xoxb-1',
      apiBase: api.base,
      onLink: () => {},
      onMessage: (m) => {
        const thread = m.threadTs ?? m.ts
        void runSlackCommand(m.text, seam, { key: { source: 'slack', externalId: `${m.channel} ${thread}` }, deliveryId: m.ts }).then((t) => sock.post(m.channel, t, thread))
      }
    })
    const posts = () => api.seen.filter((s) => s.url.endsWith('chat.postMessage')).map((s) => JSON.parse(s.body) as { channel: string; text: string; thread_ts: string })
    await expect.poll(() => posts().length, { timeout: 5000 }).toBe(3)
    expect(calls).toEqual([
      ['launch', { agent: 'codex', worktree: 'feat', prompt: '테스트 돌려' }],
      ['send', 's9', '<이어서>']
    ])
    expect(posts().every((p) => p.channel === 'C1' && p.thread_ts === '100.1')).toBe(true)
    expect(posts()[0]!.text).toContain('시작했습니다')
    expect(posts()[1]!.text).toContain('[1] 보냈습니다')
    sock.stop()
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
