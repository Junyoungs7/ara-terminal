// fb2214 에이전트가 끝나면 터미널 탭 위 "이어 하기" 띠(목업 exit-band A). (작성만 — 실행은 메인)
// 가짜 claude 는 accountSwitch.spec 의 것 그대로(Ctrl+C 로 끝나 셸로 돌아감 · --resume 이면 RESUMED <id> · 훅으로 transcript 를 알림).
// 🔴 기록·훅은 임시 홈(userData/e2e-home)과 userData 안에만. 사용자 실제 ~/.claude 는 안 건드린다.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, tempDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'

const FAKE = String.raw`
const { appendFileSync, mkdirSync, readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(3)
const win = process.platform === 'win32'
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const cfg = process.env.CLAUDE_CONFIG_DIR || process.env.ARA_E2E_DEFAULT_CFG
const ri = args.indexOf('--resume')
const sid = ri >= 0 ? args[ri + 1] : 'fake-sid'
const file = join(cfg, 'projects', 'e2e', sid + '.jsonl')
const J = JSON.stringify
out('ARGS: ' + args.filter((a) => a !== '--settings' && !a.endsWith('.json')).join(' ') + '\nCFG: ' + (process.env.CLAUDE_CONFIG_DIR || '(system)') + '\n')
if (ri >= 0) {
  let had = ''
  try { had = readFileSync(file, 'utf8') } catch {}
  out(had ? 'RESUMED ' + sid + '\n' : 'NO CONVERSATION ' + sid + '\n')
}
const rec = (o) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, J(Object.assign({ sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString() }, o)) + '\n') }
const sh = (cmd, input) => win ? spawnSync('cmd.exe', ['/d', '/c', cmd], { input, stdio: ['pipe', 'ignore', 'ignore'] }) : spawnSync('/bin/sh', ['-c', cmd], { input, stdio: ['pipe', 'ignore', 'ignore'] })
const hook = (event) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  if (!script) return
  const input = J({ hook_event_name: event, session_id: sid, transcript_path: file })
  if (win) spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
const limit = () => {
  const si = args.indexOf('--settings')
  if (si < 0) return out('NO SETTINGS\n')
  const cmd = JSON.parse(readFileSync(args[si + 1], 'utf8')).statusLine?.command
  if (!cmd) return out('NO STATUSLINE\n')
  sh(cmd, J({ session_id: sid, transcript_path: file, rate_limits: { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 } } }))
  out('  ⎿  5-hour limit reached\n')
}
const box = () => out('─'.repeat(40) + '\n❯ \n' + '─'.repeat(40) + '\n')
setTimeout(box, 300)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  if (!buf.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '').includes('\r')) return
  const text = buf.replace(/\x1b\[20[01]~/g, '').split('\r')[0]
  buf = ''
  out('\nGOT: ' + text + '\n')
  if (text === 'limit') { limit(); return box() }
  rec({ type: 'user', uuid: 'u' + Date.now(), message: { role: 'user', content: text } })
  hook('UserPromptSubmit')
  rec({ type: 'assistant', uuid: 'a' + Date.now(), message: { id: 'm' + Date.now(), role: 'assistant', content: [{ type: 'text', text: 'ECHO ' + text } ] } })
  hook('Stop')
  box()
})
`

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
  const repo = join(root, 'exit-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

/** 가짜 claude 를 깔고 첫 지시 'hello' 로 띄운 뒤 훅이 세션 id 를 알릴 때까지. 돌려주는 것: 첫 탭 세션 id. */
async function start(launch: (ud: string) => Promise<{ app: import('@playwright/test').ElectronApplication; page: Page }>, userDataDir: string): Promise<{ page: Page; sid: string }> {
  const root = realpathSync(tempDir('ara-e2e-exit-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  const home = join(userDataDir, 'e2e-home')
  const hookScript = join(home, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript, ARA_E2E_DEFAULT_CFG: join(home, '.claude') } } }, migratedAiCliFlags: true, chatNaming: false })
  )
  process.env.PATH = bin + delimiter + (process.env.PATH ?? '')
  const { app, page } = await launch(userDataDir)
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await app.evaluate(({ dialog: d }, p) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
  const opt = page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
  await expect(opt).toContainText('9.9.9', { timeout: 20_000 })
  await opt.click()
  await page.fill('[data-aiws="agent-prompt"]', 'hello')
  await page.click('[data-aiws="agent-launch"]')
  await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1, { timeout: 20_000 })
  let sid = ''
  await expect
    .poll(async () => (sid = await page.evaluate(async () => (await window.ev.session.list()).find((s) => s.space === 'ai')?.id ?? '')), { timeout: 20_000 })
    .not.toBe('')
  await expect.poll(() => term(page, sid), { timeout: 20_000 }).toContain('GOT: hello')
  await expect.poll(() => page.evaluate(async (s) => (await window.ev.agents.resumeIds([s]))[s] ?? '', sid), { timeout: 20_000 }).toBe('fake-sid')
  return { page, sid }
}

const term = (page: Page, s: string): Promise<string> => page.evaluate((x) => window.__evTerm(x)?.text() ?? '', s)

const newSession = async (page: Page, old: string): Promise<string> => {
  let fresh = ''
  await expect
    .poll(async () => {
      fresh = await page.evaluate(async (o) => (await window.ev.session.list()).find((s) => s.space === 'ai' && s.id !== o)?.id ?? '', old)
      return fresh
    }, { timeout: 20_000 })
    .not.toBe('')
  return fresh
}

test('EXIT-1★ 에이전트가 끝나면 화면을 비우고 위 띠 → [이 대화 이어 하기] = 같은 세션 id 로 --resume, 같은 자리', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await page.evaluate((s) => window.ev.session.input(s, ''), sid)
    const band = page.locator('[data-aiws="exit-band"]')
    await expect(band).toContainText('Claude 세션이 끝났습니다', { timeout: 20_000 })
    // 겹친 잔상 제거 — 에이전트 출력은 xterm 에서 지워졌다(셸 프롬프트 줄만 남음).
    await expect.poll(() => term(page, sid), { timeout: 10_000 }).not.toContain('GOT: hello')
    await band.locator('[data-aiws="exit-resume"]').click()
    const fresh = await newSession(page, sid)
    await expect.poll(() => term(page, fresh), { timeout: 20_000 }).toContain('RESUMED fake-sid')
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1)
    await expect(band).toHaveCount(0)
    await expect.poll(() => page.evaluate(async (o) => (await window.ev.session.list()).some((s) => s.id === o), sid)).toBe(false)
  } finally {
    process.env.PATH = savedPath
  }
})

test('EXIT-2 채팅 보기는 카드 · [✕]는 띠만 닫음(카드도 안 돌아옴) · 그 뒤 재시작 칩 = --resume 없이 새로', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await page.evaluate((s) => window.ev.session.input(s, ''), sid)
    const band = page.locator('[data-aiws="exit-band"]')
    await expect(band).toBeVisible({ timeout: 20_000 })
    await page.click('[data-aiws="chat-toggle"]')
    await expect(page.locator('[data-aiws="exit-card"]')).toBeVisible()
    await page.click('[data-aiws="chat-toggle"]')
    await band.locator('[data-aiws="exit-band-close"]').click()
    await expect(band).toHaveCount(0)
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1) // 탭은 그대로
    await page.click('[data-aiws="chat-toggle"]')
    const card = page.locator('[data-aiws="exit-card"]')
    await expect(card).toHaveCount(0) // 닫은 띠는 카드로도 안 돌아온다
    await page.click('[data-aiws="chat-toggle"]')
    // 띠를 닫았으니 탭 칩(재시작 칩)으로 새로 — 같은 restartTab 길.
    await page.locator('.aiws-tab[data-agent-tab="claude"] [data-aiws="restart-chip"]').click()
    const fresh = await newSession(page, sid)
    await expect.poll(() => term(page, fresh), { timeout: 20_000 }).toContain('ARGS:')
    expect(await term(page, fresh)).not.toContain('RESUMED')
  } finally {
    process.env.PATH = savedPath
  }
})

test('EXIT-3 채팅 보기 카드 [새로 시작] = 같은 에이전트를 --resume 없이 같은 자리에', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await page.click('[data-aiws="chat-toggle"]')
    await page.evaluate((s) => window.ev.session.input(s, ''), sid)
    const card = page.locator('[data-aiws="exit-card"]')
    await expect(card).toContainText('Claude 세션이 끝났습니다', { timeout: 20_000 })
    await card.locator('[data-aiws="exit-new"]').click()
    const fresh = await newSession(page, sid)
    await expect.poll(() => term(page, fresh), { timeout: 20_000 }).toContain('ARGS:')
    expect(await term(page, fresh)).not.toContain('RESUMED')
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1)
  } finally {
    process.env.PATH = savedPath
  }
})
