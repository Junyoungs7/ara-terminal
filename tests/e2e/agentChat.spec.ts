// M5 AI-13·12·17 — 터미널 에이전트를 채팅으로 보기. (작성만 — 이 라운드에서는 돌리지 않았다)
// 🔴 진짜 claude 를 띄우지 않는다: 가짜 `claude`(node)가 입력 한 줄을 받으면 **픽스처 transcript jsonl** 에 사용자·어시스턴트 줄을 써 나가고
//    설치된 진짜 훅 스크립트로 UserPromptSubmit(transcript_path 포함)을 보낸다 — 앱은 그 경로를 꼬리 읽기로 따라간다.
// 🔴 기록·훅은 임시 홈(userData/e2e-home)에만. CLAUDE_CONFIG_DIR 도 그 안으로(Orca 시험 방식) — 사용자 실제 ~/.claude 는 안 건드린다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'

/** 가짜 claude — 입력 상자를 그리고, 받은 한 줄(괄호 붙여넣기 안의 줄바꿈 포함)을 transcript 에 한 턴으로 적는다. */
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
const hook = (event) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  if (!script) return
  const input = J({ hook_event_name: event, session_id: 'fake-sid', transcript_path: file })
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
setTimeout(box, 300)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  // 괄호 붙여넣기 안의 줄바꿈은 제출이 아니다 — 닫는 괄호 뒤의 \r 이 제출.
  const plain = buf.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, '')
  if (!plain.includes('\r') || buf.includes('\x1b[200~') && !buf.includes('\x1b[201~')) return
  const text = buf.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, '').split('\r')[0]
  buf = ''
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
  const repo = join(root, 'chat-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

const HARD = 'hello "따옴표" & 100% 한글'

test('CHAT-1★ 가짜 claude 의 transcript → 채팅 화면 · 채팅 입력 → PTY(따옴표·줄바꿈) · Ctrl+Shift+U 전환 · 초안 보존', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-chat-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  const home = join(userDataDir, 'e2e-home')
  const transcript = join(home, '.claude', 'projects', 'e2e-chat', 'fake-sid.jsonl')
  const hookScript = join(home, '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({
      agents: { claude: { command: claude, env: { ARA_E2E_HOOK_SCRIPT: hookScript, ARA_E2E_TRANSCRIPT: transcript, CLAUDE_CONFIG_DIR: join(home, '.claude') } } },
      migratedAiCliFlags: true
    })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
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
    await page.click('[data-aiws="agent-launch"]')
    await expect.poll(() => existsSync(hookScript), { timeout: 20_000 }).toBe(true)

    // 채팅으로(버튼). 아직 기록 없음.
    const toggle = page.locator('[data-aiws="chat-toggle"]')
    await toggle.click()
    const chat = page.locator('[data-aiws="chat"]')
    await expect(chat).toBeVisible()
    await expect(chat.locator('.aiws-chat-empty')).toBeVisible()

    // 채팅에서 보낸 글(따옴표·&·%·한글·줄바꿈)이 PTY 로 그대로 들어가고, transcript 를 거쳐 채팅에 뜬다.
    const input = page.locator('[data-aiws="chat-input"]')
    await input.fill(`${HARD}\n둘째 줄`)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    const sid = await page.evaluate(async () => (await window.ev.session.list()).find((s) => s.space === 'ai')!.id)
    await expect.poll(() => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid), { timeout: 20_000 }).toContain(`GOT: ${HARD}⏎둘째 줄`)
    await expect(chat.locator('.aiws-chat-msg.user')).toContainText(HARD, { timeout: 15_000 })
    await expect(chat.locator('.aiws-chat-msg.assistant').last()).toContainText('ECHO 1')
    // 도구 호출은 접혀 있고 결과가 붙는다.
    const tool = chat.locator('.aiws-chat-tool[data-tool="Bash"]').first()
    await expect(tool).toContainText('echo fake-1')
    await tool.locator('summary').click()
    await expect(tool.locator('pre')).toHaveText('fake-1')
    expect(readFileSync(transcript, 'utf8')).toContain('"tool_result"')

    // 초안 — 보내지 않은 글은 터미널로 갔다 와도(Ctrl+Shift+U) 남는다.
    await input.fill('쓰다 만 글')
    await page.keyboard.press(win ? 'Control+Shift+U' : 'Meta+Shift+U')
    await expect(chat).toBeHidden()
    await expect(page.locator('.aiws-term:not([hidden])')).toBeVisible()
    await page.keyboard.press(win ? 'Control+Shift+U' : 'Meta+Shift+U')
    await expect(page.locator('[data-aiws="chat-input"]')).toHaveValue('쓰다 만 글')
    // 두 번째 턴 — 열린 채로 꼬리 읽기가 따라온다.
    await page.locator('[data-aiws="chat-input"]').fill('second')
    await page.locator('[data-aiws="chat-input"]').press('Enter')
    await expect(page.locator('[data-aiws="chat"] .aiws-chat-msg.assistant').last()).toContainText('ECHO 2', { timeout: 15_000 })
    await expect(page.locator('[data-aiws="chat"] .aiws-chat-msg.user')).toHaveCount(2)
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
