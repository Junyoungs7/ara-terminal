// M12 R3 — [AI 로 쓰기](RV-02: 커밋 메시지·MR 초안·브랜치 이름, 채우기만) · AI 작성 줄(RV-03: 에이전트 도구로 쓴 줄 → 에디터·diff 거터, 사람이 고치면 사라짐).
// 🔴 진짜 claude/codex 를 띄우지 않는다: agents.json 의 실행 명령을 가짜(node 스크립트) 절대 경로로 박고 PATH 앞에도 둔다(agents.spec 과 같은 두 겹).
// 🔴 훅은 임시 홈(userData/e2e-home)에만. 작성만 — 실행은 메인(phase2-common).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

const win = process.platform === 'win32'
const side = '.aiws-side'
const scm = '.aiws-scm'

/**
 * 가짜 에이전트. 두 얼굴:
 *  · `-p`(한 번 실행 — [AI 로 쓰기]): stdin 프롬프트를 읽고 종류에 맞는 답을 찍고 끝. 프롬프트에 SLOW 가 있으면 30초 잔다(취소 시험).
 *  · 그 밖(에이전트 탭): 입력 상자를 그리고, 한 줄을 받으면 ai.txt 를 쓰고 진짜 훅 스크립트로 PostToolUse(Write) 를 흘린다.
 */
const FAKE = String.raw`
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const name = process.argv[2]
const args = process.argv.slice(3)
if (args[0] === '--version') { console.log('9.9.9 (fake ' + name + ')'); process.exit(0) }
if (args.includes('-p') || args[0] === 'exec') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    const reply = () => {
      if (input.includes('single git commit message')) console.log('Add two lines.\n\nBecause tests.')
      else if (input.includes('pull request details')) console.log(JSON.stringify({ base: 'main', title: 'Add feature file', body: '## Problem\nnone\n## Solution\nfile', draft: false }))
      else console.log('Add Feature File Now Please')
    }
    if (input.includes('SLOW')) setTimeout(reply, 30000)
    else reply()
  })
  return
}
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const RULE = '─'.repeat(40)
const box = () => out(RULE + '\n❯ \n' + RULE + '\n  ? for shortcuts\n')
const hook = (event, extra) => {
  const script = process.env.ARA_E2E_HOOK_SCRIPT
  if (!script) return
  const input = JSON.stringify(Object.assign({ hook_event_name: event }, extra || {}))
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
}
setTimeout(box, 400)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  if (!buf.includes('\r')) return
  buf = ''
  hook('UserPromptSubmit')
  const file = join(process.cwd(), 'ai.txt')
  writeFileSync(file, 'ai one\nai two\nai three\n')
  hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { type: 'create', structuredPatch: [] } })
  hook('Stop')
  out('\n● Done.\n'); box()
})
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

function setup(userDataDir: string, extraEnv: Record<string, string> = {}): { root: string; repo: string; bin: string; git: (...a: string[]) => string } {
  const root = realpathSync(tempDir('ara-e2e-m12r3-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeBins(bin)
  const repo = join(root, 'shop-api')
  mkdirSync(repo)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: fake.claude, env: extraEnv }, codex: { command: fake.codex }, gemini: { command: fake.gemini } }, defaultAgent: 'claude', migratedAiCliFlags: true })
  )
  return { root, repo, bin, git }
}

async function openRepo(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await app.evaluate(({ dialog: d }, p) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
}

test('R3-1★ [AI 로 쓰기] — 커밋 메시지는 입력칸에만(커밋 안 함) · MR 초안 칸 · 브랜치 이름은 누를 때만 바뀜', async ({ launch, userDataDir }) => {
  const { root, repo, bin, git } = setup(userDataDir)
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await openRepo(app, page, repo)
    await page.click('.rbar [data-rbar="scm"]')
    // 스테이지 전엔 ✨ 꺼짐.
    await expect(page.locator(`${scm} [data-scm="ai"]`)).toBeDisabled()
    writeFileSync(join(repo, 'a.txt'), 'a\nb\n')
    await page.click(`${scm} [data-scm="refresh"]`)
    await page.locator(`${scm} .scm-row[data-scm-file="a.txt"] [data-scm="stage"]`).click()
    await page.click(`${scm} [data-scm="ai"]`)
    await expect(page.locator(`${scm} [data-field="scm.message"]`)).toHaveValue('Add two lines\n\nBecause tests.', { timeout: 30_000 })
    await expect(page.locator(`${scm} [data-scm="aiBusy"]`)).toHaveCount(0)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1) // 커밋은 사용자가
    // 커밋해서 브랜치 → MR 초안.
    git('checkout', '-q', '-b', 'work')
    git('commit', '-q', '-am', 'add b')
    await page.click(`${scm} [data-scm="refresh"]`)
    await page.click(`${scm} [data-scm="aiMr"]`)
    await expect(page.locator(`${scm} [data-field="scm.mrTitle"]`)).toHaveValue('Add feature file', { timeout: 30_000 })
    await expect(page.locator(`${scm} [data-field="scm.mrBody"]`)).toHaveValue(/## Problem/)
    await page.click(`${scm} [data-scm="draftClose"]`)
    // 브랜치 이름 — 4 낱말 kebab, [이름 바꾸기]를 눌러야 바뀐다.
    await page.click(`${scm} [data-scm="aiBranch"]`)
    await expect(page.locator(`${scm} [data-field="scm.branchName"]`)).toHaveValue('add-feature-file-now', { timeout: 30_000 })
    expect(git('branch', '--show-current').trim()).toBe('work')
    await page.click(`${scm} [data-scm="branchRename"]`)
    await expect.poll(() => git('branch', '--show-current').trim()).toBe('add-feature-file-now')
    await expect(page.locator(`${scm} .scm-branch`)).toHaveText('add-feature-file-now')
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})

test('R3-2 [AI 로 쓰기] 취소 · CLI 없음 안내', async ({ launch, userDataDir }) => {
  const { root, repo, bin } = setup(userDataDir)
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await openRepo(app, page, repo)
    await page.click('.rbar [data-rbar="scm"]')
    writeFileSync(join(repo, 'SLOW.txt'), 'x\n') // 프롬프트에 SLOW → 가짜가 30초 잔다
    await page.click(`${scm} [data-scm="refresh"]`)
    await page.click(`${scm} [data-scm="stageAll"]`)
    await page.click(`${scm} [data-scm="ai"]`)
    await expect(page.locator(`${scm} [data-scm="aiBusy"]`)).toBeVisible()
    await page.click(`${scm} [data-scm="aiCancel"]`)
    await expect(page.locator(`${scm} [data-scm="aiBusy"]`)).toHaveCount(0, { timeout: 10_000 })
    await expect(page.locator(`${scm} [data-scm="error"]`)).toHaveCount(0) // 취소는 오류가 아니다
    await expect(page.locator(`${scm} [data-field="scm.message"]`)).toHaveValue('')
    // CLI 없음 — 설정의 명령을 없는 파일로.
    await page.evaluate(async () => {
      const s = await window.ev.agents.getSettings()
      await window.ev.agents.setSettings({ ...s, agents: { ...s.agents, claude: { ...s.agents.claude, command: 'C:/nope/no-claude-here.cmd' } } })
    })
    await page.click(`${scm} [data-scm="ai"]`)
    await expect(page.locator(`${scm} [data-scm="error"]`)).toContainText('Claude CLI 를 찾지 못했습니다', { timeout: 30_000 })
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})

test('R3-3★ AI 작성 줄 — 에이전트가 Write 로 쓴 줄이 에디터·diff 거터에, 사람이 고친 줄은 빠진다', async ({ launch, userDataDir }) => {
  const hookScript = join(userDataDir, 'e2e-home', '.ara', 'agent-hooks', win ? 'claude-hook.cmd' : 'claude-hook.sh')
  const { root, repo, bin } = setup(userDataDir, { ARA_E2E_HOOK_SCRIPT: hookScript })
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await openRepo(app, page, repo)
    await expect(page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await page.fill('[data-aiws="agent-prompt"]', 'write-ai-file')
    await page.click('[data-aiws="agent-launch"]')
    // 가짜가 ai.txt 를 쓰고 PostToolUse(Write) 훅을 보낸다 → 탐색기에서 연다.
    await page.click('.rbar [data-rbar="explorer"]')
    const row = page.locator('[data-aiws="explorer"] .frow:has(.fn:text-is("ai.txt"))')
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.dblclick()
    const marks = page.locator('.code-ed .monaco-editor .ai-line-mark')
    await expect(marks).toHaveCount(3, { timeout: 15_000 })
    // 2번째 줄을 사람이 고친다 → 그 줄만 빠진다(묶음 400ms 뒤 다시 묻는다).
    await page.locator('.code-ed .monaco-editor .view-line').nth(1).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' (mine)')
    await expect(marks).toHaveCount(2, { timeout: 5_000 })
    // diff(추적 안 함 → 추가) 오른쪽에도.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aiws:open-diff', { detail: { filePath: 'ai.txt', mode: 'unstaged' } })))
    await expect(page.locator('.monaco-diff-editor .editor.modified .ai-line-mark')).toHaveCount(3, { timeout: 15_000 })
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
