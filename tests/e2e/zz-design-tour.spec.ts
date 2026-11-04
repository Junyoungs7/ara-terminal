// 디자인 투어 — 앱의 주요 화면을 차례로 열어 PNG 로 남긴다. 단언이 아니라 **캡처**가 목적이다.
// ARA_TOUR=1 일 때만 돈다(전체 e2e 에 안 낀다):  ARA_TOUR=1 npx playwright test tests/e2e/zz-design-tour.spec.ts
// 저장: <저장소 루트>/tour-shots/<테마>-<폭>/NN-name.png  (test-results 는 다른 playwright 실행이 지운다)
//
// 각 장면은 step() 으로 감싼다 — 못 여는 화면은 건너뛰고 skipped.txt 에 한 줄 남긴다(투어 전체가 안 죽게).
// 라이트 테마는 아직 없어 뺐다(생기면 THEMES 에 'light' 추가 — setTheme 이 data-theme·colorScheme 을 건다).
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
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
        for (const [id, name] of [['conn', 'conn'], ['file', 'file'], ['ai', 'ai']] as const) {
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
          await openBottomTool(page, 'port') // console.spec 의 탭 id 목록: files ps svc disk sys port term pkg ctr k8s
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
          await openSettings(page, 'general')
          await page.locator('.settings-page [role="combobox"]').first().click()
          await expect(page.locator('.settings-page [role="listbox"], [role="listbox"]').first()).toBeVisible()
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
          // 모델·추론 강도 — 채팅 모드의 선택기(없으면 skipped)
          await page.locator('[data-aiws="chat-model"]').first().click({ timeout: 5_000 })
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
          await page.click('[data-aiws="diff-open"]')
          await expect(page.locator('[data-diff="view"]')).toBeVisible({ timeout: 20_000 })
        })
      } finally {
        rmDir(root)
      }
    })
  }
}
