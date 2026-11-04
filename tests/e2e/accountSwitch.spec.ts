// 원격 3차 R0 — 한도에 걸린 탭을 다른 계정으로 이어서(같은 CLI 세션 id 로 --resume). (작성만 — 실행은 메인)
// 🔴 진짜 claude 를 띄우지 않는다: 가짜 `claude`(node)가 띄울 때 인자·CLAUDE_CONFIG_DIR 을 화면에 찍고, 받은 줄을 그 설정 폴더의
//    projects/e2e/<세션 id>.jsonl 에 적고 진짜 훅 스크립트로 UserPromptSubmit 을 보낸다(agentChat.spec 방식).
//    'limit' 을 받으면 --settings 파일의 statusLine 명령에 rate_limits(5시간 100%)를 흘린다 — 앱의 실제 사용량 길(statusLine → usage)로 한도 신호가 선다.
// 🔴 기록·계정·훅은 임시 홈(userData/e2e-home)과 userData 안에만. 사용자 실제 ~/.claude 는 안 건드린다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, tempDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'
const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'

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
  const repo = join(root, 'acct-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

/** 계정 A(고름)·B 와 가짜 claude 를 깔고 첫 지시 'hello' 로 띄운다. 돌려주는 것: 첫 탭 세션 id. */
async function start(launch: (ud: string) => Promise<{ app: import('@playwright/test').ElectronApplication; page: Page }>, userDataDir: string): Promise<{ page: Page; sid: string; home: string }> {
  const root = realpathSync(tempDir('ara-e2e-acct-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  const home = join(userDataDir, 'e2e-home')
  const hookScript = join(home, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({
      agents: { claude: { command: claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript, ARA_E2E_DEFAULT_CFG: join(home, '.claude') } } },
      migratedAiCliFlags: true,
      chatNaming: false
    })
  )
  writeFileSync(
    join(userDataDir, 'usage-accounts.json'),
    JSON.stringify({ claude: { active: A, list: [{ id: A, label: '업무 A' }, { id: B, label: '업무 B' }] }, codex: { active: null, list: [] } })
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
  await expect.poll(() => existsSync(hookScript), { timeout: 20_000 }).toBe(true)
  const sid = await page.evaluate(async () => (await window.ev.session.list()).find((s) => s.space === 'ai')!.id)
  const term = (s: string) => page.evaluate((x) => window.__evTerm(x)?.text() ?? '', s)
  await expect.poll(() => term(sid), { timeout: 20_000 }).toContain(`CFG: ${join(userDataDir, 'accounts', 'claude', A)}`)
  await expect.poll(() => term(sid), { timeout: 20_000 }).toContain('GOT: hello')
  // R0 전제: A 의 대화가 기본 폴더(공유)에 있다.
  await expect.poll(() => existsSync(join(home, '.claude', 'projects', 'e2e', 'fake-sid.jsonl')), { timeout: 10_000 }).toBe(true)
  return { page, sid, home }
}

const termOfNewTab = async (page: Page, old: string): Promise<string> => {
  let fresh = ''
  await expect
    .poll(async () => {
      fresh = await page.evaluate(async (o) => (await window.ev.session.list()).find((s) => s.space === 'ai' && s.id !== o)?.id ?? '', old)
      return fresh
    }, { timeout: 20_000 })
    .not.toBe('')
  return fresh
}

test('ACCT-1★ 터미널 보기: 한도 띠 → [다른 계정으로 이어서] → 업무 B → 같은 세션 id 로 --resume, B 계정 env', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await page.evaluate((s) => window.ev.session.input(s, 'limit\r'), sid)
    const band = page.locator('[data-aiws="acct-band"]')
    await expect(band).toContainText('업무 A', { timeout: 20_000 })
    await band.locator('[data-aiws="acct-band-switch"]').click()
    await page.locator('.ctx-menu [role="menuitem"]').filter({ hasText: '업무 B' }).click()
    const fresh = await termOfNewTab(page, sid)
    const term = () => page.evaluate((x) => window.__evTerm(x)?.text() ?? '', fresh)
    await expect.poll(term, { timeout: 20_000 }).toContain('--resume fake-sid')
    await expect.poll(term).toContain(`CFG: ${join(userDataDir, 'accounts', 'claude', B)}`)
    await expect.poll(term).toContain('RESUMED fake-sid') // B 계정 폴더에서 A 의 대화를 찾았다(공유)
    await expect(page.locator('[data-aiws="acct-switched"]')).toContainText('업무 B')
    await expect(band).toHaveCount(0) // B 는 한도가 아니다
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1) // 옛 탭은 닫혔다
  } finally {
    process.env.PATH = savedPath
  }
})

test('ACCT-2★ 채팅 보기: 한도 카드 → 업무 B 고르고 [이어서] → 같은 세션 id 로 재실행, 채팅 보기 유지', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await page.click('[data-aiws="chat-toggle"]')
    await expect(page.locator('[data-aiws="chat"]')).toBeVisible()
    await page.evaluate((s) => window.ev.session.input(s, 'limit\r'), sid)
    const card = page.locator('[data-aiws="acct-card"]')
    await expect(card).toContainText('업무 A', { timeout: 20_000 })
    await card.locator('[data-aiws="acct-option"]').filter({ hasText: '업무 B' }).click()
    await card.locator('[data-aiws="acct-card-switch"]').click()
    const fresh = await termOfNewTab(page, sid)
    const term = () => page.evaluate((x) => window.__evTerm(x)?.text() ?? '', fresh)
    await expect.poll(term, { timeout: 20_000 }).toContain('--resume fake-sid')
    await expect.poll(term).toContain(`CFG: ${join(userDataDir, 'accounts', 'claude', B)}`)
    await expect(page.locator('[data-aiws="chat"]')).toBeVisible()
    await expect(page.locator('[data-aiws="acct-switched"]')).toContainText('업무 B')
  } finally {
    process.env.PATH = savedPath
  }
})

test('ACCT-3 탭 우클릭 메뉴(한도 없이도): [다른 계정으로 이어서 ›] 시스템 기본 → --resume, 계정 env 없음', async ({ launch, userDataDir }) => {
  const savedPath = process.env.PATH
  try {
    const { page, sid } = await start(launch, userDataDir)
    await expect(page.locator('[data-aiws="acct-band"]')).toHaveCount(0)
    await page.locator('.aiws-tab[data-agent-tab="claude"]').click({ button: 'right' })
    await page.locator('.ctx-menu [role="menuitem"]').filter({ hasText: '다른 계정으로 이어서' }).hover()
    await page.locator('.ctx-submenu [role="menuitem"]').filter({ hasText: '시스템 기본' }).click()
    const fresh = await termOfNewTab(page, sid)
    const term = () => page.evaluate((x) => window.__evTerm(x)?.text() ?? '', fresh)
    await expect.poll(term, { timeout: 20_000 }).toContain('--resume fake-sid')
    await expect.poll(term).toContain('CFG: (system)')
    await expect.poll(term).toContain('RESUMED fake-sid') // 기본 폴더 = 공유 자리
  } finally {
    process.env.PATH = savedPath
  }
})
