// 디자인 투어 — 앱의 주요 화면을 차례로 열어 PNG 로 남긴다. 단언이 아니라 **캡처**가 목적이다.
// ARA_TOUR=1 일 때만 돈다(전체 e2e 에 안 낀다):  ARA_TOUR=1 npx playwright test tests/e2e/zz-design-tour.spec.ts
// 저장: <저장소 루트>/tour-shots/<테마>-<폭>/NN-name.png  (test-results 는 다른 playwright 실행이 지운다)
//
// 각 장면은 step() 으로 감싼다 — 못 여는 화면은 건너뛰고 skipped.txt 에 한 줄 남긴다(투어 전체가 안 죽게).
// 라이트 테마는 아직 없어 뺐다(생기면 THEMES 에 'light' 추가 — setTheme 이 data-theme·colorScheme 을 건다).
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, REPO_ROOT, tempDir, rmDir, newLocalShell, pickSidebarTab, openBottomTool, connectNewSshProfile, explorerWindow } from './fixtures'

const ROOT = join(REPO_ROOT, 'tour-shots')
const THEMES = ['dark'] as const
const WIDTHS = [1440, 1024] as const
const HEIGHT = 900
const side = '.aiws-side'

type Ctx = { app: ElectronApplication; page: Page; prefix: string; dir: string; n: number }

// 장면 사이 초기화 — 떠 있는 모달·메뉴·패널을 닫는다. 연결 관리자는 spec 처럼 Escape(ConnectionModal 이 Esc 로 닫는다),
// 안 닫히면 모달 머리의 .x 를 누른다. 설정 페이지·팔레트·명령어 북·ctx 메뉴도 Esc 로 닫힌다(settings/palette/commandbook spec).
async function reset(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(80)
  }
  const x = page.locator('.overlay.open:not(.dlg-overlay) .modal .x')
  if ((await x.count()) > 0) await x.first().click({ timeout: 2_000 }).catch(() => {})
  await page.mouse.move(0, 0).catch(() => {})
}

async function step(c: Ctx, name: string, fn: () => Promise<void>): Promise<void> {
  await reset(c.page)
  try {
    await fn()
    await c.page.waitForTimeout(350) // 전환·글라스 블러가 가라앉을 시간
    c.n += 1
    await c.page.screenshot({ path: join(c.dir, `${String(c.n).padStart(2, '0')}-${name}.png`) })
  } catch (e) {
    appendFileSync(join(c.dir, 'skipped.txt'), `${name}: ${String(e).split('\n')[0]}\n`)
  }
  await reset(c.page)
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
}

function makeRepo(): { root: string; repo: string } {
  const root = tempDir('ara-tour-')
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1\nconst b = 2\nexport { a, b }\n')
  writeFileSync(join(repo, 'README.md'), '# tour\n')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1\nconst b = 20\nexport { a, b }\n') // 변경 비교용
  return { root, repo }
}

// ── AI 채팅 보기 장면용 가짜 claude — agentChat.spec 의 FAKE·fakeClaude 를 그대로 옮기고 질문 장면용 둘만 얹었다:
//    ① 받은 글이 'ASK' 면 AskUserQuestion PreToolUse 훅(tool_input.questions)을 보내 막힘+질문 카드를 띄운다(기록은 안 씀)
//    ② ESC(카드 [취소] = main agents:answer 의 raw ESC)를 받으면 Stop 훅으로 막힘을 푼다.
const FAKE = String.raw`
const { appendFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(3)
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const file = process.env.ARA_E2E_TRANSCRIPT
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const RULE = '─'.repeat(40)
const box = () => out(RULE + '\n❯ \n' + RULE + '\n  ? for shortcuts\n')
const J = JSON.stringify
let n = 0
const rec = (o) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, J(Object.assign({ sessionId: 'fake-sid', cwd: process.cwd(), timestamp: new Date().toISOString() }, o)) + '\n') }
const hook = (event, extra) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  if (!script) return
  const input = J(Object.assign({ hook_event_name: event, session_id: 'fake-sid', transcript_path: file }, extra))
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
setTimeout(box, 300)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  if (d === '\u001b') { hook('Stop'); return }
  buf += d
  const plain = buf.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '')
  if (!plain.includes('\r') || buf.includes('\x1b[200~') && !buf.includes('\x1b[201~')) return
  const text = buf.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, '').split('\r')[0]
  buf = ''
  if (text === 'ASK') {
    hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '어느 방식으로 고칠까요?', header: '방식', multiSelect: false, options: [{ label: '작게 고친다', description: '해당 줄만 바꾼다' }, { label: '구조째 바꾼다', description: '관련 파일을 함께 정리한다' }] }] } })
    return
  }
  n++
  out('\nGOT: ' + text.replace(/\n/g, '⏎') + '\n')
  rec({ type: 'user', uuid: 'u' + n, message: { role: 'user', content: text } })
  hook('UserPromptSubmit')
  rec({ type: 'assistant', uuid: 'a' + n + 'x', message: { id: 'm' + n, role: 'assistant', content: [{ type: 'tool_use', id: 't' + n, name: 'Bash', input: { command: 'echo fake-' + n } }] } })
  rec({ type: 'user', uuid: 'r' + n, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + n, content: 'fake-' + n }] } })
  rec({ type: 'assistant', uuid: 'a' + n + 'y', message: { id: 'm' + n + 'b', role: 'assistant', content: [{ type: 'text', text: '**ECHO ' + n + '**: ' + text }] } })
  hook('Stop')
  out('\n● Done.\n'); box()
})
`

function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.cjs')
  writeFileSync(js, FAKE)
  if (process.platform === 'win32') {
    const p = join(dir, 'claude.cmd')
    writeFileSync(p, ['@echo off', `node "${js}" claude %*`, ''].join('\r\n'))
    return p
  }
  const p = join(dir, 'claude')
  writeFileSync(p, ['#!/bin/sh', `exec node "${js}" claude "$@"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
}

async function openSettings(page: Page, section: string): Promise<void> {
  if ((await page.locator('.settings-page.open').count()) === 0) await page.keyboard.press('Control+,')
  await page.click(`.settings-page .sp-nav [data-section="${section}"]`, { timeout: 5_000 })
}

test.describe.configure({ mode: 'serial' })

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`TOUR ${theme} ${width}`, async ({ launch, userDataDir, ssh }) => {
      test.skip(process.env.ARA_TOUR !== '1', 'ARA_TOUR=1 일 때만 돈다(디자인 캡처)')
      test.setTimeout(600_000)
      const dir = join(ROOT, `${theme}-${width}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'skipped.txt'), '')
      const { root, repo } = makeRepo()
      // 채팅 보기 장면 — agentChat.spec 처럼 가짜 claude + 임시 홈(userData/e2e-home)의 기록·훅. 사용자 실제 ~/.claude 는 안 건드린다.
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const claude = fakeClaude(bin)
      const home = join(userDataDir, 'e2e-home')
      const transcript = join(home, '.claude', 'projects', 'e2e-chat', 'fake-sid.jsonl')
      const hookScript = join(home, '.ara', 'agent-hooks', process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh')
      writeFileSync(
        join(userDataDir, 'agents.json'),
        JSON.stringify({
          agents: { claude: { command: claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript, ARA_E2E_TRANSCRIPT: transcript, CLAUDE_CONFIG_DIR: join(home, '.claude') } } },
          migratedAiCliFlags: true,
          chatNaming: false
        })
      )
      const savedPath = process.env.PATH
      process.env.PATH = bin + delimiter + (savedPath ?? '')
      try {
        const { app, page } = await launch(userDataDir)
        await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w[0], w[1]), [width, HEIGHT])
        await page.setViewportSize({ width, height: HEIGHT })
        await setTheme(page, theme)
        page.setDefaultTimeout(5_000) // 장면 click·expect 는 5초 — 못 열면 건너뛴다
        const c: Ctx = { app, page, prefix: `${theme}-${width}`, dir, n: 0 }

        // ── 터미널 공간 ──
        await step(c, 'welcome-empty', async () => {
          await expect(page.locator('.pane-grid')).toBeVisible()
        })
        await step(c, 'term-local-shell', async () => {
          await newLocalShell(page)
        })
        await step(c, 'term-split2', async () => {
          await page.click('.titlebar .tb-burger')
          await page.click('.tb-menu span:text-is("터미널")')
          await page.hover('.ctx-menu .ctx-item[data-action="sub.split"]')
          await page.click('.ctx-submenu .ctx-item[data-action="split.horizontal"]')
          await expect(page.locator('.pane-grid .pane')).toHaveCount(2)
        })
        for (const [id, name] of [['conn', 'conn'], ['file', 'file']] as const) {
          await step(c, `sidebar-${name}`, async () => {
            await pickSidebarTab(page, id)
          })
        }
        // 서버 목록(하네스 프로필 둘) hover
        await step(c, 'server-list-hover', async () => {
          const h1 = await ssh({ password: 'pw-tour' })
          const h2 = await ssh({ password: 'pw-tour' })
          await connectNewSshProfile(page, { name: 'tour-alpha', port: h1.port, password: 'pw-tour', group: 'tour' })
          await connectNewSshProfile(page, { name: 'tour-beta', port: h2.port, password: 'pw-tour', group: 'tour' })
          await pickSidebarTab(page, 'conn')
          await page.locator('.tree .srv-node').first().hover()
        })
        await step(c, 'conn-manager-modal', async () => {
          await page.keyboard.press('Control+Shift+M')
          await expect(page.locator('.overlay.open:not(.dlg-overlay) .modal')).toBeVisible()
        })
        // 서버 목록 점(.pf-st) — 접속한 두 프로필(tour-alpha/beta)의 상태 점이 보이게. 같은 모달이 배경막(.overlay) 확인용도 겸한다.
        await step(c, 'conn-manager-dot', async () => {
          await page.keyboard.press('Control+Shift+M')
          await expect(page.locator('.overlay.open .prof-list .prof .pf-st').first()).toBeVisible()
        })
        await step(c, 'modal-backdrop', async () => {
          await page.keyboard.press('Control+Shift+K') // 명령어 북 — 아무 모달 하나(배경막은 화면 전체)
          await expect(page.locator('.cheatsheet.open')).toBeVisible()
        })
        await step(c, 'command-book', async () => {
          await page.keyboard.press('Control+Shift+K')
          await expect(page.locator('.cheatsheet.open .cb-list .cb-item').first()).toBeVisible()
        })
        await step(c, 'omni-search-f1', async () => {
          await page.keyboard.press('F1')
          await expect(page.locator('.cp-drop')).toBeVisible()
        })
        await step(c, 'burger-menu', async () => {
          await page.click('.titlebar .tb-burger')
          await expect(page.locator('.tb-menu')).toBeVisible()
        })
        await step(c, 'burger-submenu', async () => {
          await page.click('.titlebar .tb-burger')
          await page.click('.tb-menu span:text-is("터미널")')
          await page.hover('.ctx-menu .ctx-item[data-action="sub.split"]')
          await expect(page.locator('.ctx-submenu')).toBeVisible()
        })
        await step(c, 'bottom-monitor', async () => {
          await openBottomTool(page, 'monitor')
        })
        await step(c, 'bottom-sys', async () => {
          await openBottomTool(page, 'sys')
        })
        await step(c, 'bottom-ports', async () => {
          // 포트는 하단 탭이 아니다(BOTTOM_IDS 에 없음) — [모니터] 탭 안의 포트 표(.pmon-list .ptbl, fixtures.portRows)다.
          await openBottomTool(page, 'monitor')
          await expect(page.locator('.pmon-list')).toBeVisible()
        })
        await step(c, 'explorer-window', async () => {
          // 탐색기는 OS 창이다 — page.screenshot 은 본창만 찍으므로 그 창의 Page 를 받아 찍는다.
          // fixtures.explorerWindow — 이미 떠 있으면 그 창, 아니면 새 창 이벤트를 기다린다(explorer.spec 과 같은 트리거)
          const win = await explorerWindow(app, () => page.keyboard.press('Control+Shift+O'))
          await win.screenshot({ path: join(dir, `${String(c.n + 1).padStart(2, '0')}-explorer-window-os.png`) })
        })

        // ── 아라 채팅 패널 ──
        await step(c, 'ara-chat-panel', async () => {
          await page.click('[data-rbar="chat"]') // arachat.spec openAra 와 같은 진입(우측 레일 버튼)
          await expect(page.locator('.ara-panel .ara-input')).toBeVisible()
        })
        if ((await page.locator('.ara-panel .ara-input').count()) > 0) await page.click('[data-rbar="chat"]').catch(() => {})

        // ── 설정(섹션 그룹마다 하나) ──
        for (const [group, section] of [
          ['aiws', 'setupGuide'], ['app', 'general'], ['global', 'ai'], ['terminal', 'terminal'],
          ['security', 'security'], ['advanced', 'advanced'], ['about', 'about']
        ] as const) {
          await step(c, `settings-${group}`, async () => {
            await openSettings(page, section)
          })
        }
        await step(c, 'settings-dropdown-open', async () => {
          // p3r2a.spec 과 같은 자리 — 설정 › 터미널의 테마 Dropdown(.dd), 목록은 .dd-list.
          await openSettings(page, 'terminal')
          await page.click('.settings-page [data-field="term.theme"] .dd')
          await expect(page.locator('.dd-list').first()).toBeVisible()
        })
        await reset(page)

        // ── AI 작업 공간 ──
        await step(c, 'ai-space-empty', async () => {
          await page.click('.titlebar .tb-spaces [data-space="ai"]')
          await expect(page.locator('.aiws-home')).toBeVisible()
        })
        await step(c, 'ai-project-added', async () => {
          await app.evaluate(({ dialog: d }, p) => {
            d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
          }, repo)
          await page.click(`${side} [data-aiws="add-project"]`)
          const row = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })
          await row.click()
          await expect(row).toHaveAttribute('aria-current', 'true')
        })
        await step(c, 'ai-agent-picker', async () => {
          await expect(page.locator('[data-aiws="agent-picker"]')).toBeVisible({ timeout: 20_000 })
        })
        await step(c, 'ai-model-effort', async () => {
          // 모델·추론 강도 — 에이전트 피커의 실행 옵션(AgentPane OptField: [data-aiws=opt-model|opt-effort] 안의 .dd).
          // 에이전트를 아직 안 골랐으면 설치된 첫 것을 고른다(그래야 launch-options 가 그려진다).
          const opts = page.locator('[data-aiws="launch-options"]')
          if ((await opts.count()) === 0) await page.locator('[data-aiws="agent-picker"] [data-agent]:not([disabled])').first().click()
          await expect(opts).toBeVisible()
          const dd = page.locator('[data-aiws="opt-model"] .dd, [data-aiws="opt-effort"] .dd, [data-aiws="opt-permission"] .dd').first()
          await dd.click()
          await expect(page.locator('.dd-list').first()).toBeVisible()
          // 글라스 카드(backdrop-filter) 안에서도 목록이 버튼 바로 밑에 붙는다(2026-11-04 오른쪽 끝에 뜨던 것).
          const a = (await dd.boundingBox())!
          const l = (await page.locator('.dd-list').first().boundingBox())!
          expect(Math.abs(l.x - a.x)).toBeLessThan(2)
          expect(Math.abs(l.y - (a.y + a.height + 4)) < 3 || Math.abs(l.y + l.height - (a.y - 4)) < 3).toBe(true)
        })
        await step(c, 'ai-setup-guide-modal', async () => {
          await page.click(`${side} [data-aiws="setup-entry"]`)
          await expect(page.locator('[data-aiws="setup-modal"]')).toBeVisible()
        })
        await step(c, 'ai-dashboard', async () => {
          await page.click('.ai-rail [data-aiws="dashboard"]')
          await expect(page.locator('[data-aiws="dashboard"]').first()).toBeVisible()
        })
        await step(c, 'ai-sessions', async () => {
          await page.click('.ai-rail [data-aiws="sessions"]')
          await expect(page.locator('[data-aiws="sessions"]').first()).toBeVisible()
        })
        await step(c, 'ai-usage-settings', async () => {
          await openSettings(page, 'usage')
        })
        await reset(page)
        await step(c, 'ai-code-view', async () => {
          await page.click('.ai-rail [data-aiws="worktree"]')
          await page.click('.rbar [data-rbar="explorer"]')
          const sep = process.platform === 'win32' ? '\\\\' : '/'
          await page.click(`.frow[data-path="src"]`)
          await page.click(`.frow[data-path="src${sep}app.ts"]`)
          await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
        })
        await step(c, 'ai-diff', async () => {
          await page.click('.rbar [data-rbar="diff"]')
          await expect(page.locator('[data-diff="view"]')).toBeVisible({ timeout: 20_000 })
        })

        // ── AI 채팅 보기(터미널 → 채팅 전환) ──
        const chat = page.locator('[data-aiws="chat"]')
        const chatInput = page.locator('[data-aiws="chat-input"]')
        const sendChat = async (text: string): Promise<void> => {
          await chatInput.fill(text)
          await chatInput.press('Enter')
          await expect(chatInput).toHaveValue('')
        }
        await step(c, 'ai-chat-view', async () => {
          // agentChat.spec CHAT-1: 피커의 claude(9.9.9) → agent-launch → 훅 스크립트 생김 → chat-toggle → 채팅 입력으로 보냄 → msg·tool 확인
          await page.click('.ai-rail [data-aiws="worktree"]')
          const opt = page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
          if ((await opt.count()) > 0) {
            await expect(opt).toContainText('9.9.9', { timeout: 20_000 })
            await opt.click()
            await page.click('[data-aiws="agent-launch"]')
          }
          await expect.poll(() => existsSync(hookScript), { timeout: 20_000 }).toBe(true)
          await page.click('[data-aiws="chat-toggle"]')
          await expect(chat).toBeVisible()
          await sendChat('로그인 화면 버튼 정렬을 고쳐 줘')
          await expect(chat.locator('.aiws-chat-msg.assistant').last()).toContainText('ECHO 1', { timeout: 15_000 })
          await sendChat('테스트도 돌려 줘')
          await expect(chat.locator('.aiws-chat-msg.assistant').last()).toContainText('ECHO 2', { timeout: 15_000 })
          await chat.locator('.aiws-chat-tool[data-tool="Bash"]').first().locator('summary').click() // 도구 호출 펼침(CHAT-1 과 같은 자리)
          await expect(chat.locator('.aiws-chat-msg.user')).toHaveCount(2)
        })
        await step(c, 'ai-chat-ask', async () => {
          // 질문 카드는 훅(PreToolUse AskUserQuestion → status.ask)이 띄운다 — 가짜 claude 가 'ASK' 를 받으면 그 훅을 보낸다.
          await sendChat('ASK')
          await expect(page.locator('[data-aiws="ask-card"]')).toBeVisible({ timeout: 15_000 })
        })
        await step(c, 'ai-chat-input', async () => {
          // 카드 [취소](ESC → 가짜 claude 가 Stop 훅)로 막힘을 푼 뒤 입력칸에 쓰다 만 글.
          if ((await page.locator('[data-aiws="ask-card"]').count()) > 0) {
            await page.click('[data-aiws="ask-cancel"]')
            await expect(page.locator('[data-aiws="ask-card"]')).toHaveCount(0, { timeout: 15_000 })
          }
          await chatInput.fill('로그인 화면 말고 회원가입 화면도 같이 봐 줘')
        })
      } finally {
        process.env.PATH = savedPath
        rmDir(root)
      }
    })
  }
}
