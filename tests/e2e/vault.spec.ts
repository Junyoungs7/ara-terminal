// M4 AI-07 지난 에이전트 세션 — 픽스처 세션이 목록에 → 상세 → 재개 → 가짜 CLI 가 받은 --resume 인자.
// 🔴 진짜 claude 를 띄우지 않는다: 설정(agents.json)의 실행 명령을 가짜(node 스크립트)의 절대 경로로 박는다(agents.spec 과 같은 두 겹 — PATH 앞에도 둔다).
// 🔴 사용자 실제 ~/.claude 를 읽지 않는다: main 은 e2e 에서 임시 홈(userData/e2e-home — main/index.ts hookHome)만 본다. 픽스처는 거기에 쓴다.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100'

/** 가짜 claude — 받은 인자를 찍고 입력 상자를 그린 뒤 기다린다. */
const FAKE = String.raw`
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
process.stdout.write('FAKE-CLAUDE ARGS: ' + args.join(' ') + '\r\n' + '─'.repeat(40) + '\r\n❯ \r\n' + '─'.repeat(40) + '\r\n')
process.stdin.resume()
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
  const repo = join(root, 'vault-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

test('VAULT-1★ 픽스처 claude 세션이 지난 세션 목록에 → 상세(첫 지시·최근 턴) → 재개 → 가짜 CLI 가 --resume <id> 를 받는다', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-vault-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = makeRepo(root)
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: claude } }, migratedAiCliFlags: true }))
  // 임시 홈의 claude 기록(가짜 jsonl) — cwd 가 이 저장소라 그 워크트리에서 재개된다.
  const proj = join(userDataDir, 'e2e-home', '.claude', 'projects', 'vault-repo')
  mkdirSync(proj, { recursive: true })
  const J = (o: unknown): string => JSON.stringify(o)
  writeFileSync(
    join(proj, `${ID}.jsonl`),
    [
      J({ type: 'user', sessionId: ID, cwd: repo, message: { role: 'user', content: 'fixture-first-prompt' } }),
      J({ type: 'assistant', sessionId: ID, message: { role: 'assistant', content: [{ type: 'text', text: 'fixture-answer' }] } })
    ].join('\n')
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
    await expect(page.locator(`${side} .aiws-row`).filter({ hasText: 'main' })).toBeVisible()

    await page.click('.ai-rail [data-aiws="sessions"]')
    const row = page.locator(`[data-aiws="sessions"] [data-vault-id="${ID}"]`)
    await expect(row).toContainText('fixture-first-prompt')
    await expect(row).toContainText('Claude Code')
    await row.locator('.aiws-feed-row').click()
    await expect(row.locator('[data-aiws="vault-detail"]')).toContainText('fixture-answer')

    await row.locator('[data-aiws="vault-resume"]').click()
    const tab = page.locator('.aiws-tab[data-agent-tab="claude"]')
    await expect(tab).toBeVisible()
    const sid = await page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id)[0])
    await expect
      .poll(() => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid), { timeout: 20_000 })
      .toContain(`FAKE-CLAUDE ARGS: --resume ${ID}`)
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
