// M11 R1 에이전트 2차 — 지난 세션 범위·검색·삭제 / 재시작 칩 / 질문·승인 카드 / 탭 제목.
// 🔴 진짜 CLI 를 띄우지 않는다: agents.json 실행 명령 = 가짜 node 스크립트(vault.spec 과 같은 두 겹 — PATH 앞에도 둔다).
// 🔴 사용자 실제 ~/.claude 를 읽지 않는다: main 은 e2e 에서 임시 홈(userData/e2e-home)만 본다. 삭제는 e2e 에서 휴지통 대신 그냥 지운다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'
const J = (o: unknown): string => JSON.stringify(o)

/** 가짜 claude — 입력 상자를 그리고, 'quit' 를 받으면 끝나 셸로 돌아간다(에이전트만 끝남). OSC 제목도 정한다. */
const FAKE = String.raw`
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const box = () => process.stdout.write('─'.repeat(40) + '\r\n❯ \r\n' + '─'.repeat(40) + '\r\n')
process.stdout.write('\x1b]0;✳ Fake summary title\x07FAKE-CLAUDE\r\n')
box()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { if (d.includes('quit')) process.exit(0) })
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

function makeRepo(root: string, name: string): string {
  const repo = join(root, name)
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

test('VAULT-M11★ 범위(이 작업 단위/전체) · 전문 검색 조각 · 삭제(확인)', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-m11v-'))
  const repo = makeRepo(root, 'm11-repo')
  const other = join(root, 'elsewhere')
  mkdirSync(other)
  const proj = join(userDataDir, 'e2e-home', '.claude', 'projects', 'm11')
  mkdirSync(proj, { recursive: true })
  const A = 'aaaaaaaa-0000-4000-8000-000000000001'
  const B = 'bbbbbbbb-0000-4000-8000-000000000002'
  writeFileSync(join(proj, `${A}.jsonl`), [J({ type: 'user', sessionId: A, cwd: repo, message: { content: 'in-repo prompt' } }), J({ type: 'assistant', sessionId: A, message: { content: [{ type: 'text', text: 'deep body zebra-quartz here' }] } })].join('\n'))
  writeFileSync(join(proj, `${B}.jsonl`), J({ type: 'user', sessionId: B, cwd: other, message: { content: 'other-folder prompt' } }))
  try {
    const { app, page } = await launch(userDataDir)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
    await page.click('.ai-rail [data-aiws="sessions"]')
    const panel = page.locator('[data-aiws="sessions"]')
    // 기본 범위 = 이 작업 단위 → 저장소 세션만.
    await expect(panel.locator(`[data-vault-id="${A}"]`)).toBeVisible()
    await expect(panel.locator(`[data-vault-id="${B}"]`)).toHaveCount(0)
    await panel.locator('[data-vault-scope="all"]').click()
    await expect(panel.locator(`[data-vault-id="${B}"]`)).toBeVisible()
    // 전문 검색 — 첫 지시·제목에 없는 본문 낱말.
    await panel.locator('[data-aiws="vault-search"]').fill('zebra-quartz')
    await expect(panel.locator(`[data-vault-id="${A}"] [data-aiws="vault-snippet"]`)).toContainText('zebra-quartz', { timeout: 20_000 })
    await expect(panel.locator(`[data-vault-id="${B}"]`)).toHaveCount(0)
    await panel.locator('[data-aiws="vault-search"]').fill('')
    // 삭제 — 확인 대화상자 → 목록에서 빠지고 파일도 없다.
    await panel.locator(`[data-vault-id="${B}"] .aiws-feed-row`).click()
    await panel.locator(`[data-vault-id="${B}"] [data-aiws="vault-delete"]`).click()
    await page.locator('.dlg-overlay .modal-ft .btn.dgr').click()
    await expect(panel.locator(`[data-vault-id="${B}"]`)).toHaveCount(0)
    expect(existsSync(join(proj, `${B}.jsonl`))).toBe(false)
  } finally {
    rmDir(root)
  }
})

test('AG-M11★ 탭 제목(에이전트가 정한 OSC 제목) · 에이전트가 끝나면 재시작 칩 → 같은 자리에 새 탭', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-m11a-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root, 'm11-agent')
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: claude } }, migratedAiCliFlags: true }))
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
    await page.click('[data-aiws="agent-picker"] [data-agent="claude"]')
    await page.click('[data-aiws="agent-launch"]')
    const tab = page.locator('.aiws-tab[data-agent-tab="claude"]')
    await expect(tab.locator('[data-aiws="tab-name"]')).toHaveText('Fake summary title', { timeout: 20_000 })
    const first = await page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id)[0])
    // 에이전트만 끝낸다(셸은 남음) → 재시작 칩·끝남 줄.
    await page.evaluate((s) => window.ev.session.input(s,'quit\r'), first)
    await expect(tab.locator('[data-aiws="restart-chip"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-aiws="exit-band"]')).toBeVisible()
    await tab.locator('[data-aiws="restart-chip"]').click()
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveCount(1)
    await expect
      .poll(async () => page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id)))
      .not.toContain(first)
    await expect(page.locator('[data-aiws="exit-band"]')).toHaveCount(0, { timeout: 20_000 })
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
