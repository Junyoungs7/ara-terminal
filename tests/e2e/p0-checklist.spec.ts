// P0 체크리스트(agent_talk/P0-checklist-triage.md)의 B 행 중 e2e 로 닫는 것 — 시험 이름 앞이 체크리스트 번호다.
// 작성만 — 실행은 메인(phase2-common). 단위로 닫은 것(v22-13·46·41·124·126, MCP-18)은 tests/p0Checklist.test.ts.
// 사용자 PC 를 건드리지 않는다: 창은 hide/showInactive(최소화·복원은 복원 때 포커스를 가져간다), 폴더 열기는 spy, 사내 서버 없음(루프백 하네스).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  test,
  expect,
  connectNewSshProfile,
  dialog,
  dialogCancel,
  dialogConfirm,
  focusTerminal,
  makeTelemetry,
  newLocalShell,
  openBottomTool,
  rmDir,
  runCommand,
  sessionIds,
  spyCalls,
  spyShell,
  tempDir,
  expectTermText
} from './fixtures'

// ── v22-3 분할 단축키 연타 ────────────────────────────────────────────────
// SPLIT-4 는 칸이 붙을 때까지 쉬며 누른다. 여기는 **쉬지 않고** 누른다 — 사용자의 연타가 그렇다.
test('v22-3 분할 단축키를 쉬지 않고 연타해도 4칸 상한·세션 중복 없음·입력 유지', async ({ ara }) => {
  const { page } = ara
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const first = await newLocalShell(page)
  await focusTerminal(page)

  for (let i = 0; i < 12; i++) await page.keyboard.press(i % 3 === 2 ? 'Control+Shift+-' : 'Control+Shift+\\')

  // 칸이 다 붙고(칸 수 = xterm 수) 상한을 안 넘는다.
  await expect(page.locator('.pane-grid .pane')).toHaveCount(4, { timeout: 30_000 })
  await expect(page.locator('.pane-grid .pane .xterm')).toHaveCount(4, { timeout: 30_000 })
  await expect(page.locator('.pane-toast')).toHaveText('최대 4분할까지만 가능합니다')
  // 한 세션이 두 칸에 올라가지 않는다(연타가 같은 배경 탭을 두 번 집지 않는다).
  const placed = await page.locator('.pane-grid .pane').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sessionId))
  expect(new Set(placed).size).toBe(4)
  expect(placed).toContain(first)
  // 칸마다 세션이 하나 — 보이지 않게 새는 세션이 없다.
  expect((await sessionIds(page)).length).toBe(4)
  expect(errors).toEqual([])
  // 연타 뒤에도 터미널이 산다 — 입력이 들어간다.
  await runCommand(page, first, 'echo 연타후_살아있음')
  await expectTermText(page, first, /연타후_살아있음/)
})

// ── v22-4 Ctrl+R ─────────────────────────────────────────────────────────
test('v22-4 Ctrl+R 은 앱을 새로고침하지 않는다(기본 메뉴 가속키 없음)', async ({ ara }) => {
  const { app, page } = ara
  const id = await newLocalShell(page)
  const info = await app.evaluate(({ Menu }) => ({ platform: process.platform, menuNull: Menu.getApplicationMenu() === null }))
  // mac 은 편집·창 메뉴를 두되 reload 가 없다(단위 appMenu.test.ts) — Win/Linux 만 메뉴 자체가 없다.
  if (info.platform !== 'darwin') expect(info.menuNull).toBe(true)

  const origin = await page.evaluate(() => performance.timeOrigin) // 새로고침하면 이 값이 바뀐다
  await focusTerminal(page)
  await page.keyboard.press('Control+r')
  await page.waitForTimeout(1_500)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()) // 터미널 밖에서도(사이드바는 레이아웃에 따라 숨어 있다)
  await page.keyboard.press('Control+r')
  await page.waitForTimeout(1_500)
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin)
  await expect(page.locator('.app')).toBeVisible()
  expect(await sessionIds(page)).toContain(id) // 세션은 main 소유라 새로고침에도 살아 남는다 — 새로고침 여부는 위 timeOrigin 이 가른다
})

// ── R11-7·8 떼어낸 창 ────────────────────────────────────────────────────
async function detachTab(ara: { app: ElectronApplication; page: Page }, sessionId: string): Promise<Page> {
  const opened = ara.app.waitForEvent('window')
  await ara.page.locator(`.ttab[data-session-id="${sessionId}"]`).click({ button: 'right' })
  await ara.page.click('.ctx-menu .ctx-item[data-action="session.detach"]')
  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  return win
}

test('R11-7 떼어낸 창에는 File/Edit 같은 OS 메뉴가 없다', async ({ ara }) => {
  const { app, page } = ara
  const a = await newLocalShell(page)
  await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })

  const state = await app.evaluate(({ BrowserWindow, Menu }) => ({
    app: Menu.getApplicationMenu() === null,
    windows: BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), menu: (w as unknown as { menu?: unknown }).menu ?? null }))
  }))
  expect(state.windows.length).toBe(2) // 본창 + 떼어낸 창
  for (const w of state.windows) expect(w.menu).toBeNull()
  if (process.platform !== 'darwin') expect(state.app).toBe(true)
  // 우리 메뉴는 타이틀바 안 HTML 이다 — 떼어낸 창에도 본창과 같은 타이틀바가 있다.
  await expect(win.locator('.titlebar')).toBeVisible()
})

test('R11-8 떼어낸 창에서 Ctrl+W 는 창을 닫지 않고, 탭 닫기(Ctrl+Shift+W)는 그 탭만 닫는다', async ({ ara }) => {
  const { app, page } = ara
  const a = await newLocalShell(page)
  await newLocalShell(page)
  const win = await detachTab(ara, a)
  await expect(win.locator(`.ttab[data-session-id="${a}"]`)).toHaveCount(1, { timeout: 15_000 })
  await win.click('.tterm-add') // 이 창에 탭을 하나 더 — 둘이어야 하나를 닫아도 창이 남는다
  await expect(win.locator('.ttab')).toHaveCount(2)
  await expect(win.locator('.pane-grid .xterm:visible').first()).toBeVisible()
  await win.locator('.pane-grid .pane:visible .term-pane').first().click()

  await win.keyboard.press('Control+w') // 기본 메뉴의 "창 닫기" 가속키 — 없어야 한다
  await win.waitForTimeout(1_500)
  expect(win.isClosed()).toBe(false)
  expect(app.windows().length).toBe(2)
  await expect(win.locator('.ttab')).toHaveCount(2)

  await win.keyboard.press('Control+Shift+W') // 이 칸의 세션 종료(확인 후) = 탭만
  await dialogConfirm(win)
  await expect(win.locator('.ttab')).toHaveCount(1, { timeout: 15_000 })
  expect(win.isClosed()).toBe(false)
  expect(app.windows().length).toBe(2)
})

// ── v22-52 뷰어 PDF·오디오·영상 ──────────────────────────────────────────
const side = '.aiws-side'
const panel = '[data-aiws="explorer"]'
const PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n'
)

/** 0.2초짜리 무음 WAV(8kHz·16bit·모노) — 오디오 뷰어가 실제로 디코드하는지 본다. mp3 는 인코더가 없어 같은 audio 경로의 wav 로 대신한다. */
function wav(): Buffer {
  const n = 1600
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(8000, 24)
  b.writeUInt32LE(16000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  return b
}

function makeMediaRepo(files: Record<string, Buffer>): { root: string; repo: string } {
  const root = realpathSync(tempDir('ara-e2e-p0media-'))
  const repo = join(root, 'media-repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  for (const [name, data] of Object.entries(files)) writeFileSync(join(repo, name), data)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return { root, repo }
}

async function openMediaFile(app: ElectronApplication, page: Page, repo: string, name: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await expect(page.locator(side)).toBeVisible()
  await app.evaluate(({ dialog: d }, picked) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
  await mainRow.click()
  await expect(mainRow).toHaveAttribute('aria-current', 'true')
  await page.click('.rbar [data-rbar="explorer"]')
  await page.locator(`${panel} .frow[data-path="${name}"]`).click()
  await expect(page.locator(`.aiws-tab[data-file-tab="${name}"]`)).toHaveAttribute('aria-selected', 'true')
}

test('v22-52 뷰어 PDF — 틀이 뜨고 CSP 위반·"그릴 수 없음" 안내가 없다(빈 화면 우려)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeMediaRepo({ 'doc.pdf': PDF })
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __csp: string[] }
      w.__csp = []
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    })
    await openMediaFile(app, page, repo, 'doc.pdf')
    const view = page.locator('.media-view[data-media="pdf"]')
    await expect(view).toBeVisible()
    const frame = view.locator('iframe')
    await expect(frame).toBeVisible({ timeout: 15_000 })
    const box = await frame.boundingBox()
    expect(box?.width).toBeGreaterThan(100)
    expect(box?.height).toBeGreaterThan(100)
    await expect(view.locator('.media-note')).toHaveCount(0) // "PDF 보기가 꺼져 있습니다"·읽기 실패가 아니다
    expect(await page.evaluate(() => navigator.pdfViewerEnabled)).toBe(true)
    // 프레임이 blob: 을 읽었거나 Chromium PDF 뷰어(확장) 프레임으로 넘어갔다 — 둘 다 아니면 빈 틀이다.
    await expect.poll(() => page.frames().some((f) => /^(blob:|chrome-extension:)/.test(f.url())), { timeout: 15_000 }).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    await expect(page.locator('.monaco-editor')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})

test('v22-52 뷰어 오디오 — <audio controls> 가 파일을 디코드한다(길이 0.2초)', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeMediaRepo({ 'tone.wav': wav() })
  try {
    await openMediaFile(app, page, repo, 'tone.wav')
    const audio = page.locator('.media-view[data-media="audio"] audio')
    await expect(audio).toHaveAttribute('controls', '')
    await expect.poll(() => audio.evaluate((e) => (e as HTMLAudioElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(await audio.evaluate((e) => (e as HTMLAudioElement).duration)).toBeCloseTo(0.2, 1)
    await expect(page.locator('.media-view .media-note')).toHaveCount(0)
    await expect(page.locator('.monaco-editor')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})

test('v22-52 뷰어 영상 — <video controls> 가 파일을 디코드한다(앱 안에서 MediaRecorder 로 만든 webm)', async ({ ara }) => {
  const { app, page } = ara
  // 샘플 영상을 저장소에 넣지 않는다 — 렌더러(Chromium)가 캔버스를 녹화해 만든다. 이 PC 에서 녹화가 안 되면 건너뛴다.
  const b64 = await page.evaluate(async () => {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported('video/webm')) return null
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')!
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()))
    rec.start()
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `hsl(${i * 30},80%,50%)`
      ctx.fillRect(0, 0, 64, 64)
      await new Promise((r) => setTimeout(r, 60))
    }
    rec.stop()
    await stopped
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    let s = ''
    for (const x of bytes) s += String.fromCharCode(x)
    return btoa(s)
  })
  test.skip(!b64, '이 환경의 Chromium 이 webm 녹화를 못 한다')
  const { root, repo } = makeMediaRepo({ 'clip.webm': Buffer.from(b64 as string, 'base64') })
  try {
    await openMediaFile(app, page, repo, 'clip.webm')
    const video = page.locator('.media-view[data-media="video"] video')
    await expect(video).toHaveAttribute('controls', '')
    await expect.poll(() => video.evaluate((e) => (e as HTMLVideoElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(await video.evaluate((e) => (e as HTMLVideoElement).videoWidth)).toBe(64)
    await expect(page.locator('.media-view .media-note')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})

// ── v22-58 Ctrl+Shift+Backspace ──────────────────────────────────────────
// 실제 워크트리를 지우는 쪽은 WT-M10(worktreesM10.spec.ts:89). 여기는 **눌러도 취소하면 아무것도 안 지워진다**와 **다른 키 조합은 반응이 없다**.
test('v22-58 Ctrl+Shift+Backspace 만 확인 창을 띄우고, 취소하면 그대로다', async ({ ara }) => {
  const { app, page } = ara
  const { root, repo } = makeMediaRepo({})
  try {
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect(page.locator(side)).toBeVisible()
    await app.evaluate(({ dialog: d }, picked) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    const mainRow = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
    await mainRow.click()
    await expect(mainRow).toHaveAttribute('aria-current', 'true')

    // 양성 대조를 뒤에 둔다 — 아래 둘이 "안 떴다"가 키를 못 눌러서가 아님을 같은 자리의 정식 조합이 보인다.
    for (const key of ['Control+Backspace', 'Shift+Backspace', 'Control+Shift+Delete']) {
      await page.keyboard.press(key)
      await page.waitForTimeout(400)
      await expect(dialog(page)).toHaveCount(0)
    }
    await page.keyboard.press('Control+Shift+Backspace')
    await expect(dialog(page)).toContainText('목록에서 뺍니다')
    await dialogCancel(page)
    await expect(mainRow).toBeVisible()
    await expect(page.locator(`${side} .aiws-grp`)).toContainText('media-repo')
  } finally {
    rmDir(root)
  }
})

// ── MCP-24 감사 로그 자리 ────────────────────────────────────────────────
test('MCP-24 MCP 도구를 부르면 [로그 폴더 열기]가 여는 폴더에 mcp-actions_*.jsonl 이 생긴다', async ({ ara }) => {
  const { app, page, userData } = ara
  const { port, token } = await page.evaluate(async () => {
    const s = await window.ev.mcp.getState()
    const t = await window.ev.mcp.issueToken()
    return { port: s.port, token: t.token }
  })
  const client = new Client({ name: 'p0-checklist', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  try {
    await client.connect(transport)
    // 읽기 전용 도구 — 승인 창 없이 실행돼 감사 줄이 남는다.
    await client.callTool({ name: 'ara_call', arguments: { tool: 'session_list', args: {} } })
  } finally {
    await client.close().catch(() => {})
  }

  const logDir = join(userData, 'logs')
  await expect
    .poll(() => (readdirSync(logDir).filter((f) => /^mcp-actions_\d{8}\.jsonl$/.test(f)).length), { timeout: 15_000 })
    .toBe(1)
  const file = readdirSync(logDir).find((f) => /^mcp-actions_\d{8}\.jsonl$/.test(f)) as string
  expect(readFileSync(join(logDir, file), 'utf8')).toContain('session_list')

  // 설정 › 로그 › [폴더 열기](SLOG-4)가 여는 곳과 같은 폴더다.
  await spyShell(app)
  await page.keyboard.press('Control+,')
  await page.click('.settings-page.open .sp-nav [data-section="log"]')
  await page.click('.settings-page.open [data-action="log.reveal"]')
  await expect.poll(async () => (await spyCalls(app)).paths, { timeout: 10_000 }).toEqual([logDir])
})

// ── #147 보는 창이 없으면 원격 폴링 정지 ─────────────────────────────────
// 최소화 대신 hide/showInactive — 둘 다 같은 syncTelemetryPolling 을 타고(index.ts), 복원(restore)은 포커스를 가져가 사용자 PC 를 건드린다.
// isMinimized 판정 자체는 단위(telemetry.test.ts '#147 창 가시성 판정')가 본다.
test('#147 모든 창이 안 보이면 원격 수집이 멈추고, 다시 보이면 즉시 이어진다', async ({ ara, ssh }) => {
  const { app, page } = ara
  const tele = makeTelemetry()
  const h = await ssh({ password: 'pw-p0-147', execHandler: tele.exec })
  await connectNewSshProfile(page, { name: 'p0-147', port: h.port, password: 'pw-p0-147' })
  await openBottomTool(page, 'monitor')
  await expect.poll(() => tele.rounds(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2) // 켜져 있는 동안은 2.5초마다 돈다

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
  await page.waitForTimeout(800) // 이미 나간 한 바퀴가 끝나길
  const frozen = tele.rounds()
  await page.waitForTimeout(7_000) // 폴링 주기(2.5초) 둘 이상
  expect(tele.rounds()).toBe(frozen)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.showInactive()))
  await expect.poll(() => tele.rounds(), { timeout: 2_000 }).toBeGreaterThan(frozen) // 켜자마자 한 바퀴(낡은 숫자를 안 본다)
  const resumed = tele.rounds()
  await expect.poll(() => tele.rounds(), { timeout: 10_000 }).toBeGreaterThan(resumed) // 그 뒤로도 계속
})
