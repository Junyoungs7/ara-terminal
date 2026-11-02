// M3 — 에이전트 피커 → 실행 → 첫 지시(AI-01·02·03, R1) + 상태 점·훅·화면 판정·서브에이전트 줄(AI-04·05·06·11, R2).
// 🔴 진짜 claude/codex/gemini 를 띄우지 않는다(사용량·사내 정책): PATH 맨 앞에 가짜 `claude`·`codex`·`gemini`(node 스크립트)를 두고,
//    설정(agents.json)의 실행 명령도 그 가짜의 절대 경로로 미리 박아 둔다 — PATH 순서가 틀려도 진짜가 뜨지 않게 두 겹.
// 🔴 훅은 임시 홈(userData/e2e-home)에만 심긴다(main/index.ts hookHome) — 사용자 실제 ~/.claude 는 안 건드린다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

const win = process.platform === 'win32'
const side = '.aiws-side'

/**
 * 가짜 에이전트(node). `--version` → 9.9.9. 그 밖에는:
 *  ① 받은 인자·ARA_AGENT_PROMPT 를 찍고 그 CLI 모양의 입력 상자를 그린다(claude: 가로줄 사이 ❯ · codex: › · gemini: Type your message)
 *  ② 입력 한 줄(Enter)을 받으면 `GOT: <글>` 을 찍고 한 턴을 흉내 낸다 — 훅 스크립트(ARA_E2E_HOOK_SCRIPT)가 있으면 그 진짜 훅 스크립트에
 *     UserPromptSubmit → SubagentStart → PermissionRequest(1.5초) → PostToolUse → SubagentStop → Stop 을 stdin JSON 으로 흘리고,
 *     없으면(codex) 화면에 "Working (Ns • esc to interrupt)" 만 찍었다가 입력 줄로 돌아간다(화면 판정 = 추정).
 */
const FAKE = String.raw`
const { spawnSync } = require('node:child_process')
const name = process.argv[2]
const args = process.argv.slice(3)
if (args[0] === '--version') { console.log('9.9.9 (fake ' + name + ')'); process.exit(0) }
const tag = name.toUpperCase()
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const RULE = '─'.repeat(40)
const box = () => name === 'claude' ? out(RULE + '\n❯ \n' + RULE + '\n  ? for shortcuts\n') : name === 'codex' ? out('\n› Ask Codex to do anything\n\n  100% context left\n') : out('╭────╮\n│ >   Type your message │\n╰────╯\n')
const hook = (event, extra) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  if (!script) return
  const input = JSON.stringify(Object.assign({ hook_event_name: event }, extra || {}))
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
out('FAKE-' + tag + ' ARGS: ' + args.join(' ') + '\n')
out('FAKE-' + tag + ' PROMPT-ENV: ' + (process.env.ARA_AGENT_PROMPT || '') + '\n')
let buf = ''
let busy = false
// 인자로 받은 첫 지시(POSIX)는 입력 상자를 그린 뒤 바로 한 턴으로.
setTimeout(() => { box(); if (process.env.ARA_AGENT_PROMPT) void turn() }, 400)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  if (!buf.includes('\r') || busy) return
  const text = buf.replace(/\x1b\[20[01]~/g, '').replace(/\x1b\r/g, '\n').split('\r')[0]
  buf = ''
  out('\nGOT: ' + text + '\n')
  void turn()
})
async function turn() {
  busy = true
  hook('UserPromptSubmit')
  if (name === 'codex') {
    for (let s = 1; s <= 3; s++) { out('\n• Working (' + s + 's • esc to interrupt)\n'); await sleep(700) }
    out('\n• Done.\n'); box(); busy = false; return
  }
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' })
  hook('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep' })
  out('\n✻ Thinking… (1s · esc to interrupt)\n')
  await sleep(1200)
  hook('PermissionRequest', { tool_name: 'Bash' })
  out('\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')
  await sleep(1500)
  hook('PostToolUse', { tool_name: 'Bash' })
  hook('SubagentStop', { agent_id: 'a1' })
  hook('Stop')
  out('\n● Done.\n'); box(); busy = false
}
`

function fakeBins(dir: string): Record<'claude' | 'codex' | 'gemini', string> {
  const js = join(dir, 'fake-agent.cjs')
  writeFileSync(js, FAKE)
  const make = (name: string): string => {
    if (win) {
      const p = join(dir, `${name}.cmd`)
      writeFileSync(p, ['@echo off', `node "${js}" ${name} %*`, ''].join('\r\n'))
      return p
    }
    const p = join(dir, name)
    writeFileSync(p, ['#!/bin/sh', `exec node "${js}" ${name} "$@"`, ''].join('\n'))
    chmodSync(p, 0o755)
    return p
  }
  return { claude: make('claude'), codex: make('codex'), gemini: make('gemini') }
}

function makeRepo(root: string): string {
  const repo = join(root, 'agent-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

async function agentSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id))
}

const termText = (page: Page, sid: string): Promise<string> => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid)

/** AI 작업 공간(M3 부터 기본 공개) → 프로젝트 추가(폴더 창은 바꿔 끼움) → 본 폴더 줄 고르기. */
async function openRepo(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await app.evaluate(({ dialog: d }, p) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
}

/** 따옴표·&·%·한글 — Windows 에서 PowerShell 5.1·npm .cmd 셔임이 깨뜨리던 첫 지시(R1 한계). */
const HARD = 'hello "따옴표" & 100% 한글'

test('AG-1★ 피커 → 가짜 claude 실행 → 첫 지시 전달(따옴표·&·%·한글) · 새 작업 카드로 codex · 터미널 공간엔 안 섞임', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-agents-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeBins(bin)
  const repo = makeRepo(root)
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: fake.claude }, codex: { command: fake.codex }, gemini: { command: fake.gemini } }, migratedAiCliFlags: true })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await openRepo(app, page, repo)

    const picker = page.locator('[data-aiws="agent-picker"]')
    await expect(picker).toBeVisible()
    const claudeOpt = picker.locator('.aiws-mode[data-agent="claude"]')
    await expect(claudeOpt).toContainText('9.9.9', { timeout: 20_000 })
    await claudeOpt.click()
    await page.fill('[data-aiws="agent-prompt"]', HARD)
    await page.click('[data-aiws="agent-launch"]')

    const tab = page.locator('.aiws-tab[data-agent-tab="claude"]')
    await expect(tab).toBeVisible()
    const [sid] = await agentSessionIds(page)
    // M9 R2 부터 앞에 `--settings <긴 임시 경로>` 가 붙어 줄이 화면 폭에서 접힌다 — 버퍼 줄을 이어 붙여 본다.
    await expect.poll(async () => (await termText(page, sid)).replace(/\n/g, ''), { timeout: 20_000 }).toMatch(/FAKE-CLAUDE ARGS: --settings \S+claude-settings-\S+\.json.*--dangerously-skip-permissions/)
    // 첫 지시: Windows 는 입력 상자가 뜬 뒤 입력으로(줄에 안 실림), POSIX 는 인자로. 어느 쪽이든 글자가 그대로 도착한다.
    if (win) {
      await expect.poll(() => termText(page, sid), { timeout: 30_000 }).toContain(`GOT: ${HARD}`)
      expect(await termText(page, sid)).toMatch(/FAKE-CLAUDE PROMPT-ENV: \s*$/m)
    } else {
      await expect.poll(() => termText(page, sid), { timeout: 20_000 }).toContain(`FAKE-CLAUDE PROMPT-ENV: ${HARD}`)
    }

    // 새 작업 카드 — 워크트리 없이 + codex + 첫 지시 → 같은 작업 단위에 codex 탭이 하나 더.
    await page.click(`${side} [data-aiws="new"]`)
    await page.click('.aiws-mode[data-mode="none"]')
    await page.selectOption('[data-aiws="new-agent"]', 'codex')
    await page.fill('[data-aiws="new-prompt"]', 'second-task')
    await page.click('[data-aiws="new-create"]')
    await expect(page.locator('.aiws-tab[data-agent-tab="codex"]')).toBeVisible()
    await expect.poll(async () => (await agentSessionIds(page)).length).toBe(2)
    const sid2 = (await agentSessionIds(page)).find((x) => x !== sid)!
    await expect.poll(() => termText(page, sid2), { timeout: 20_000 }).toMatch(/FAKE-CODEX ARGS: .*--dangerously-bypass-approvals-and-sandbox/)
    await expect.poll(() => termText(page, sid2), { timeout: 30_000 }).toContain(win ? 'GOT: second-task' : 'PROMPT-ENV: second-task')

    // 터미널 공간 탭 줄에는 에이전트 탭이 없다(Session.space='ai').
    await page.click('.titlebar .tb-spaces [data-space="term"]')
    await expect(page.locator('.term-tabbar')).not.toContainText('Claude Code')
    await expect(page.locator('.term-tabbar')).not.toContainText('Codex')
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})

test('AG-2★ 상태 점 — claude 는 훅(추정 아님)으로 일함→승인 대기→끝, 서브에이전트 줄 · codex 는 화면 판정(추정) · 훅은 임시 홈에만', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-agent-status-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeBins(bin)
  const repo = makeRepo(root)
  const hookHome = join(userDataDir, 'e2e-home')
  const hookScript = join(hookHome, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({
      agents: { claude: { command: fake.claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript } }, codex: { command: fake.codex }, gemini: { command: fake.gemini } },
      migratedAiCliFlags: true
    })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await openRepo(app, page, repo)
    await expect(page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await page.fill('[data-aiws="agent-prompt"]', 'run-a-turn')
    await page.click('[data-aiws="agent-launch"]')

    // 훅 스크립트는 임시 홈에. M9 R3: 줄은 사용자 settings.json 이 아니라 이 실행의 --settings 파일(~/.ara/agent-launch)에만.
    await expect.poll(() => existsSync(hookScript), { timeout: 20_000 }).toBe(true)
    expect(existsSync(join(hookHome, '.claude', 'settings.json')) && readFileSync(join(hookHome, '.claude', 'settings.json'), 'utf8').includes('agent-hooks')).toBe(false)
    const launchDir = join(hookHome, '.ara', 'agent-launch')
    expect(readdirSync(launchDir).some((f) => f.startsWith('claude-settings-') && readFileSync(join(launchDir, f), 'utf8').includes('claude-hook.'))).toBe(true)

    const glyph = page.locator('.aiws-tab[data-agent-tab="claude"] .ag-glyph')
    const row = page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).locator('.aiws-row-l1 .ag-glyph')
    // 한 턴: 일함(서브에이전트 줄 Explore · Grep) → 승인 대기 → 끝. 훅이 말했으니 추정 아님.
    await expect(glyph).toHaveAttribute('data-agent-state', 'working', { timeout: 30_000 })
    await expect(glyph).not.toHaveAttribute('data-estimated', 'true')
    await expect(page.locator(`${side} .ag-child`)).toContainText('Explore')
    await expect(glyph).toHaveAttribute('data-agent-state', 'blocked', { timeout: 10_000 })
    await expect(row).toHaveAttribute('data-agent-state', 'blocked')
    // 보고 있는 탭이 끝났으니 본 것(idle) — 안 본 끝(done)은 다른 탭을 보는 동안 끝날 때.
    await expect(glyph).toHaveAttribute('data-agent-state', 'idle', { timeout: 10_000 })
    await expect(page.locator(`${side} .ag-child`)).toHaveCount(0)

    // codex — 훅 없음(신뢰 해시가 필요해 이 판엔 안 심는다) → 화면 판정이 추정으로.
    await page.click('[data-aiws="agent-add"]')
    await page.click('[data-aiws="omnibox"] [data-omni="pick"]') // 3차 R1-B [+] = 옴니박스 → [에이전트 고르기…] = 예전 피커
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="codex"]')
    await page.fill('[data-aiws="agent-prompt"]', 'screen-only')
    await page.click('[data-aiws="agent-launch"]')
    const cg = page.locator('.aiws-tab[data-agent-tab="codex"] .ag-glyph')
    await expect(cg).toHaveAttribute('data-estimated', 'true', { timeout: 30_000 })
    await expect(cg).toHaveAttribute('data-agent-state', 'working', { timeout: 30_000 })
    await expect(cg).toHaveAttribute('data-agent-state', /idle|done/, { timeout: 15_000 })
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
