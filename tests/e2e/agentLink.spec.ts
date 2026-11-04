// AI 공간 에이전트 탭 링크 — Ctrl+클릭이 oriel:open 으로 간다(일반 URL·OSC 8), 그냥 클릭은 안 열린다. (작성만 — 돌리지 않았다)
// 가짜 claude 는 시작하자마자 URL 두 줄을 찍고 가만히 있는다(transcript·훅 없음). 임시 홈·PATH 는 agentChat CHAT-1 과 같다.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, spyOriel, orielOpened } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'
const PLAIN = 'https://example.com/plain'
const OSC = 'https://example.com/osc8'

const FAKE = String.raw`
const args = process.argv.slice(3)
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
process.stdout.write('plain ' + '%s' + '
')
process.stdout.write('osc ]8;;%sLINKTEXT]8;; end
')
setInterval(() => {}, 1000)
`.replace('%s', PLAIN).replace('%s', OSC)

function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.cjs')
  writeFileSync(js, FAKE)
  if (win) {
    const p = join(dir, 'claude.cmd')
    writeFileSync(p, ['@echo off', `node "${js}" claude %*`, ''].join('\r\n'))
    return p
  }
  const p = join(dir, 'claude')
  writeFileSync(p, ['#!/bin/sh', `exec node "${js}" claude "$@"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
}

function makeRepo(root: string): string {
  const repo = join(root, 'link-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}


/** 화면 행에서 글자 중심 좌표(fixtures linkPoint 와 같은 방식 — 그쪽은 비공개라 사본). */
function textPoint(page: Page, needle: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((n) => {
    for (const rowsEl of Array.from(document.querySelectorAll('.xterm-rows'))) {
      if (!(rowsEl as HTMLElement).offsetParent) continue
      for (const row of Array.from(rowsEl.children)) {
        const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        const nodes: { node: Text; at: number }[] = []
        let line = ''
        while (w.nextNode()) {
          const t = w.currentNode as Text
          nodes.push({ node: t, at: line.length })
          line += t.data
        }
        const i = line.indexOf(n)
        if (i < 0) continue
        const end = i + n.length
        const s = [...nodes].reverse().find((x) => x.at <= i)
        const e = [...nodes].reverse().find((x) => x.at < end)
        if (!s || !e) continue
        const r = document.createRange()
        r.setStart(s.node, i - s.at)
        r.setEnd(e.node, Math.min(end - e.at, e.node.data.length))
        const b = r.getBoundingClientRect()
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }
    }
    return null
  }, needle)
}

async function click(page: Page, needle: string, ctrl: boolean): Promise<void> {
  await expect.poll(() => textPoint(page, needle), { timeout: 20_000 }).not.toBeNull()
  const pt = (await textPoint(page, needle))!
  await page.mouse.move(pt.x, pt.y)
  await page.waitForTimeout(500) // xterm 이 hover 로 링크를 확정할 때까지(OSC 8 은 title 신호가 없다)
  if (ctrl) await page.keyboard.down('Control')
  await page.mouse.down()
  await page.mouse.up()
  if (ctrl) await page.keyboard.up('Control')
}

test('LINK-AGENT 에이전트 탭 — 일반 URL·OSC 8 링크는 Ctrl+클릭만 oriel:open 으로 간다', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-agentlink-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  const home = join(userDataDir, 'e2e-home')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: claude, env: { CLAUDE_CONFIG_DIR: join(home, '.claude') } } }, migratedAiCliFlags: true, chatNaming: false })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await spyOriel(app)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
    const opt = page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await expect(opt).toContainText('9.9.9', { timeout: 20_000 })
    await opt.click()
    await page.click('[data-aiws="agent-launch"]')
    const sid = await expect
      .poll(() => page.evaluate(async () => (await window.ev.session.list()).find((s) => s.space === 'ai')?.id ?? ''), { timeout: 20_000 })
      .not.toBe('')
      .then(() => page.evaluate(async () => (await window.ev.session.list()).find((s) => s.space === 'ai')!.id))
    await expect.poll(() => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid), { timeout: 20_000 }).toContain('LINKTEXT')

    // 그냥 클릭(Ctrl 없음) — 둘 다 안 열린다.
    await click(page, PLAIN, false)
    await click(page, 'LINKTEXT', false)
    await page.waitForTimeout(600)
    expect(await orielOpened(app)).toEqual([])

    // Ctrl+클릭 — 일반 텍스트 URL, OSC 8 순서대로.
    await click(page, PLAIN, true)
    await expect.poll(() => orielOpened(app), { timeout: 15_000 }).toEqual([PLAIN])
    await click(page, 'LINKTEXT', true)
    await expect.poll(() => orielOpened(app), { timeout: 15_000 }).toEqual([PLAIN, OSC])
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
