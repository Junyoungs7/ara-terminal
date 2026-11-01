// M3 R3 — 대시보드(AI-08)·활동 피드(AI-09)·완료 알림(토스트·맥박) — 가짜 CLI 상태로.
// 🔴 진짜 claude 를 띄우지 않는다: 설정(agents.json)의 실행 명령을 가짜 node 스크립트의 절대 경로로 박아 둔다(PATH 에도 앞에 둔다).
// 🔴 훅은 임시 홈(userData/e2e-home)에만 심긴다 — 가짜가 그 진짜 훅 스크립트에 이벤트를 흘려 상태를 만든다(agents.spec AG-2 와 같은 길).
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'
const sw = '.titlebar .tb-spaces'
const rail = '.ai-rail'

/** 가짜 claude — 입력 상자를 그리고, 첫 지시(입력 한 줄 또는 env)를 받으면 한 턴: 일함 → 승인 대기(6초) → 끝. */
const FAKE = String.raw`
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const RULE = '─'.repeat(40)
const box = () => out(RULE + '\n❯ \n' + RULE + '\n  ? for shortcuts\n')
const hook = (event, extra) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  const input = JSON.stringify(Object.assign({ hook_event_name: event }, extra || {}))
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let buf = ''
let busy = false
setTimeout(() => { box(); if (process.env.ARA_AGENT_PROMPT) void turn() }, 400)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  if (!buf.includes('\r') || busy) return
  buf = ''
  void turn()
})
async function turn() {
  busy = true
  hook('UserPromptSubmit')
  out('\n✻ Thinking… (1s · esc to interrupt)\n')
  await sleep(3000)
  hook('PermissionRequest', { tool_name: 'Bash' })
  out('\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')
  await sleep(6000)
  hook('PostToolUse', { tool_name: 'Bash' })
  hook('Stop')
  out('\n● Done.\n'); box(); busy = false
}
`

function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-claude.cjs')
  writeFileSync(js, FAKE)
  if (win) {
    const p = join(dir, 'claude.cmd')
    writeFileSync(p, ['@echo off', `node "${js}" %*`, ''].join('\r\n'))
    return p
  }
  const p = join(dir, 'claude')
  writeFileSync(p, ['#!/bin/sh', `exec node "${js}" "$@"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
}

function makeRepo(root: string): string {
  const repo = join(root, 'board-repo')
  mkdirSync(repo)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

test('BOARD-1★ 가짜 claude 한 턴 — 터미널 공간에서 기다림 토스트·AI 맥박 → 끝남 토스트 → 돌아오면 맥박 꺼짐 · 대시보드 끝남(안 봄) 칸 → 카드로 탭 · 피드 시간순 → 줄로 탭', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-board-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  const hookScript = join(userDataDir, 'e2e-home', '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript } } }, migratedAiCliFlags: true })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    // AI 작업 공간 — 기본 공개 전이면 실험 기능을 켠다(3-b 의 기본 공개 뒤에도 그대로 돈다).
    if (!(await page.locator(sw).isVisible())) {
      await page.keyboard.press('Control+,')
      await page.click('.settings-page.open .sp-nav [data-section="experimental"]')
      await page.click('.settings-page.open .set-row[data-item="exp.aiSpace"] .set-toggle')
      await page.keyboard.press('Escape')
    }
    await page.click(`${sw} [data-space="ai"]`)
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()

    // 레일 — 대시보드·에이전트(활동 피드)가 살아 있다.
    await expect(page.locator(`${rail} [data-aiws="dashboard"]`)).toBeEnabled()
    await expect(page.locator(`${rail} [data-aiws="agents"]`)).toBeEnabled()

    await expect(page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await page.fill('[data-aiws="agent-prompt"]', 'board-turn')
    await page.click('[data-aiws="agent-launch"]')
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toBeVisible()

    // 가운데를 대시보드로(탭을 안 보고 있게) → 작업 중 칸에 카드.
    await page.click(`${rail} [data-aiws="dashboard"]`)
    const board = page.locator('.aiws-board[data-aiws="dashboard"]')
    await expect(board.locator('.aiws-board-col[data-bucket="working"] .aiws-card')).toHaveCount(1, { timeout: 30_000 })

    // 터미널 공간으로 — 승인 대기가 오면 wait 토스트 + AI 버튼 맥박.
    await page.click(`${sw} [data-space="term"]`)
    await expect(page.locator('.ntf-toasts .ntf-toast[data-kind="wait"]')).toContainText('Claude Code', { timeout: 20_000 })
    await expect(page.locator(`${sw} [data-space="ai"] .tb-spaces-dot`)).toBeVisible()
    // 안 보는 사이 끝남 → done 토스트(맥박은 기다림에만이라 done 은 안 켠다).
    await expect(page.locator('.ntf-toasts .ntf-toast[data-kind="done"]')).toBeVisible({ timeout: 20_000 })

    // 돌아오면 맥박 꺼짐 · 대시보드 끝남(안 봄) 칸.
    await page.click(`${sw} [data-space="ai"]`)
    await expect(page.locator(`${sw} .tb-spaces-dot`)).toHaveCount(0)
    const card = board.locator('.aiws-board-col[data-bucket="done"] .aiws-card')
    await expect(card).toHaveCount(1)
    await card.click()
    // 카드 → 그 탭(보고 있으니 본 것 = 쉼).
    const glyph = page.locator('.aiws-tab[data-agent-tab="claude"] .ag-glyph')
    await expect(glyph).toHaveAttribute('data-agent-state', 'idle')

    // 활동 피드 — 최신이 위: 끝남 · 승인 대기 · 일 시작. 줄을 누르면 그 탭으로.
    await page.click(`${rail} [data-aiws="agents"]`)
    const rows = page.locator('.aiws-board[data-aiws="activity"] .aiws-feed-row')
    await expect.poll(() => rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-feed')))).toEqual(['done', 'blocked', 'working'])
    await rows.first().click()
    await expect(page.locator('[data-aiws="agent-ws"]')).toBeVisible()

    // 토스트·벨로도 같은 길: 벨의 wait 항목을 누르면 AI 공간의 그 탭.
    await page.click(`${sw} [data-space="term"]`)
    await page.click('.titlebar .tb-bell')
    await page.locator('.ntf-menu .ntf-item').filter({ hasText: '승인' }).click()
    await expect(page.locator(`${sw} [data-space="ai"]`)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-aiws="agent-ws"]')).toBeVisible()
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
