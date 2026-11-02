// M15 R1 연동 — 사내 GitLab(IN-01) · Slack Socket Mode(IN-02) · AI 공간 첫 안내(IN-03).
// 🔴 진짜 GitLab·slack.com 에 닿지 않는다: GitLab 주소 = 이 시험이 연 모의 HTTP 서버, Slack = ARA_E2E_SLACK_API 모의 API + 모의 WebSocket.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { test, expect, tempDir, rmDir } from './fixtures'

const drawer = '.settings-page.open'
const side = '.aiws-side'
const scm = '.aiws-scm'

type Hit = { method: string; url: string; headers: Record<string, unknown>; body: string }
async function mockHttp(reply: (h: Hit) => unknown): Promise<{ srv: Server; base: string; hits: Hit[] }> {
  const hits: Hit[] = []
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const h = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
      hits.push(h)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply(h)))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits }
}

function makeRepo(root: string, origin: string): string {
  const repo = join(root, 'gl-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', origin)
  return repo
}

test('IN-M15-1★ GitLab — 꺼져 있으면 요청 0 · 켜고 토큰 저장 → 연결 확인 · 소스 제어 MR 목록', async ({ launch, userDataDir }) => {
  const gl = await mockHttp((h) => (h.url.startsWith('/api/v4/user') ? { username: 'jy' } : [{ iid: 7, title: 'Draft: 로그인 고침', state: 'opened', web_url: 'http://x/7', source_branch: 'fix', target_branch: 'main', head_pipeline: { status: 'success' } }]))
  const root = realpathSync(tempDir('ara-e2e-m15g-'))
  const repo = makeRepo(root, `${gl.base}/grp/app.git`)
  try {
    const { app, page } = await launch(userDataDir)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
    await page.click('.rbar [data-rbar="scm"]')
    await expect(page.locator(scm)).toBeVisible()
    await expect(page.locator(`${scm} [data-scm="gitlab"]`)).toHaveCount(0)
    expect(gl.hits.length).toBe(0)

    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="integrations"]`)
    const pane = page.locator('.sp-pane[data-section="integrations"]')
    await pane.locator('[data-field="gitlab.url"]').fill(gl.base)
    await pane.locator('[data-field="gitlab.token"]').click() // 주소 칸 blur → 저장
    await pane.locator('[data-field="gitlab.token"]').fill('glpat-e2e')
    await pane.locator('[data-action="gitlab.token.save"]').click()
    await expect(pane.locator('[data-item="gitlab.token"] [data-state="has"]')).toBeVisible()
    await pane.locator('[data-item="gitlab.enable"] .set-toggle').click()
    await pane.locator('[data-action="gitlab.test"]').click()
    await expect(pane.locator('[data-gitlab="test"]')).toContainText('@jy')
    expect(gl.hits[0]!.headers['private-token']).toBe('glpat-e2e')
    // 화면 어디에도 토큰 글이 없다.
    expect(await page.content()).not.toContain('glpat-e2e')
    await page.keyboard.press('Escape')

    await page.click(`${scm} [data-scm="gitlabToggle"]`)
    await expect(page.locator(`${scm} [data-mr="7"]`)).toContainText('로그인 고침')
    expect(gl.hits.some((h) => h.url.includes('/api/v4/projects/grp%2Fapp/merge_requests'))).toBe(true)
  } finally {
    gl.srv.close()
    rmDir(root)
  }
})

test('IN-M15-2★ Slack — 모의 Socket Mode 연결 · 지정 사용자 명령만 답 · 다른 사용자는 무시', async ({ launch, userDataDir }) => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.on('listening', () => r()))
  let client: WebSocket | null = null
  let conns = 0
  wss.on('connection', (c) => {
    conns++
    client = c
    c.send(JSON.stringify({ type: 'hello' }))
  })
  const wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  const api = await mockHttp((h) => (h.url.endsWith('apps.connections.open') ? { ok: true, url: wsUrl } : { ok: true }))
  const saved = process.env.ARA_E2E_SLACK_API
  process.env.ARA_E2E_SLACK_API = api.base
  try {
    const { page } = await launch(userDataDir)
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="slack"]`)
    const pane = page.locator('.sp-pane[data-section="slack"]')
    await pane.locator('[data-field="slack.appToken"]').fill('xapp-e2e')
    await pane.locator('[data-action="slack.appToken.save"]').click()
    await pane.locator('[data-field="slack.botToken"]').fill('xoxb-e2e')
    await pane.locator('[data-action="slack.botToken.save"]').click()
    await pane.locator('[data-field="slack.channel"]').fill('C111')
    await pane.locator('[data-field="slack.users"]').click()
    await pane.locator('[data-field="slack.users"]').fill('U111')
    await pane.locator('[data-field="slack.channel"]').click()
    await pane.locator('[data-item="slack.enable"] .set-toggle').click()
    await expect(pane.locator('[data-slack-link="connected"]')).toBeVisible({ timeout: 15_000 })

    const send = (id: string, user: string, text: string): void =>
      client!.send(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { event: { type: 'message', user, channel: 'C111', channel_type: 'channel', text, ts: id } } }))
    send('1', 'U999', '상태')
    send('2', 'U111', '상태')
    await expect.poll(() => api.hits.filter((h) => h.url.endsWith('chat.postMessage')).length, { timeout: 10_000 }).toBe(1)
    const post = api.hits.find((h) => h.url.endsWith('chat.postMessage'))!
    expect(JSON.parse(post.body)).toMatchObject({ channel: 'C111', text: '열린 에이전트 탭이 없습니다.', thread_ts: '2' })
    expect(post.headers['authorization']).toBe('Bearer xoxb-e2e')
    expect(await page.content()).not.toContain('xoxb-e2e')

    // IN-02b 시작·이어 지시 스위치 — 기본 꺼짐(거절 글), 켜면 커넥터가 시작을 시도(없는 작업 단위라 실제 에이전트는 안 뜬다). 경고 문구가 보인다.
    const posts = () => api.hits.filter((h) => h.url.endsWith('chat.postMessage')).map((h) => JSON.parse(h.body) as { text: string; thread_ts: string })
    await expect(pane.locator('[data-item="slack.warning"]')).toContainText('Slack 에 남습니다')
    send('3', 'U111', '시작 없는작업단위 claude 안녕')
    await expect.poll(() => posts().length, { timeout: 10_000 }).toBe(2)
    expect(posts()[1]).toMatchObject({ thread_ts: '3' })
    expect(posts()[1]!.text).toContain('꺼져 있습니다')
    const before = conns
    await pane.locator('[data-item="slack.allowRun"] .set-toggle').click()
    // 설정 저장은 소켓을 다시 연다 — 새 연결에 보낸다.
    await expect.poll(() => conns, { timeout: 15_000 }).toBe(before + 1)
    send('4', 'U111', '시작 없는작업단위 claude 안녕')
    await expect.poll(() => posts().length, { timeout: 10_000 }).toBe(3)
    expect(posts()[2]!.text).toContain('시작하지 못했습니다')
  } finally {
    if (saved === undefined) delete process.env.ARA_E2E_SLACK_API
    else process.env.ARA_E2E_SLACK_API = saved
    wss.close()
    api.srv.close()
  }
})

test('IN-M15-3 AI 공간 첫 안내 — 에이전트·Oriel·관리형 서버 · 다시 보지 않기', async ({ launch, userDataDir }) => {
  const { page } = await launch(userDataDir)
  await page.evaluate(() => localStorage.setItem('aiws.onboarding.test', '1'))
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  const onb = page.locator('[data-aiws="onboarding"]')
  await expect(onb).toBeVisible()
  await expect(onb.locator('[data-onb="agents"] [data-agent="claude"]')).toBeVisible({ timeout: 20_000 })
  await expect(onb.locator('[data-onb="oriel"]')).toBeVisible()
  await expect(onb.locator('[data-onb="managed"]')).toBeVisible()
  await onb.locator('[data-onb="never"]').click()
  await expect(onb).toHaveCount(0)
  await page.reload()
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(`${side}`)).toBeVisible()
  await expect(page.locator('[data-aiws="onboarding"]')).toHaveCount(0)
})
