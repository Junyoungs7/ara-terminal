// M13 R1 — %사용/%남음 · 컨텍스트 사용량 · 설정 › 계정·사용량(계정 목록·통계). USAGE-1 과 같은 가짜 claude(statusLine 에 context_window 도 싣는다).
// 계정 추가·로그인은 누르지 않는다(진짜 CLI 로그인 명령을 돌리게 된다 — 단위 시험이 모의 run 으로 본다).
// (원래 머리말) M9 AI-10 — 상태바 사용량 → 팝오버. 사용량 엔드포인트·실제 자격 파일은 안 쓴다(임시 홈 userData/e2e-home 에는 자격 파일이 없다 →
// OAuth 조회는 요청 없이 '알 수 없음'). 값은 가짜 claude 가 **심긴 진짜 statusLine 스크립트**에 rate_limits 를 흘려 넣는 길로만 들어온다
// (설치 → 스크립트 → 훅 서버 → 사용량 서비스 → 저장소 → 상태바·팝오버).
// 🔴 진짜 claude 를 띄우지 않는다 — 설정(agents.json)의 실행 명령을 가짜 node 스크립트의 절대 경로로 박는다(agents.spec 와 같은 규율).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'

/** 가짜 claude: 입력 상자를 그리고, ARA_E2E_STATUSLINE_SCRIPT 에 statusLine 입력(JSON)을 한 번 흘린다 — 진짜 Claude 가 상태줄을 그릴 때와 같은 길. */
const FAKE = String.raw`
const { spawnSync } = require('node:child_process')
if (process.argv[2] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const RULE = '─'.repeat(40)
out(RULE + '\n❯ \n' + RULE + '\n')
const script = process.env.ARA_E2E_STATUSLINE_SCRIPT
const input = JSON.stringify({ model: { id: 'fake' }, context_window: { used_percentage: 42, context_window_size: 200000 }, rate_limits: { five_hour: { used_percentage: 33, resets_at: Math.floor(Date.now() / 1000) + 7200 }, seven_day: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 } } })
setTimeout(() => {
  if (!script) return
  if (process.platform === 'win32') spawnSync('cmd.exe', ['/d', '/c', script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  else spawnSync('/bin/sh', [script], { input, stdio: ['pipe', 'ignore', 'ignore'] })
  out('STATUSLINE-SENT\n')
}, 500)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => { if (String(d) === '\u0003') process.exit(0) })
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

test('USAGE-M13★ 컨텍스트 줄 · % 남음 전환 · 설정 › 계정·사용량(시스템 기본 계정·통계)', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-usage13-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeClaude(bin)
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const script = join(userDataDir, 'e2e-home', '.ara', 'agent-hooks', win ? 'claude-statusline.cmd' : 'claude-statusline.sh')
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: claude, env: { ARA_E2E_STATUSLINE_SCRIPT: script } } }, migratedAiCliFlags: true }))
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    const seg = page.locator('.statusbar [data-action="statusbar.usage"]')
    await expect(seg).toBeVisible()
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click('.aiws-side [data-aiws="add-project"]')
    await page.locator('.aiws-side .aiws-row').filter({ hasText: 'main' }).click()
    await expect(page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await page.click('[data-aiws="agent-launch"]')
    await expect(seg).toContainText('33%', { timeout: 30_000 })

    // 팝오버: 그 탭의 컨텍스트 42%(모델 · 200.0K).
    await seg.click()
    const pop = page.locator('.usage-pop')
    const ctx = pop.locator('[data-usage-provider="context"] .usage-ctx')
    await expect(ctx).toHaveCount(1)
    await expect(ctx).toContainText('42%')
    await expect(ctx).toContainText('200.0K')

    // [계정·통계] → 설정 › 계정·사용량.
    await pop.locator('[data-action="usage.manage"]').click()
    const pane = page.locator('.sp-pane[data-section="usage"]')
    await expect(pane).toBeVisible()
    await expect(pane.locator('[data-accounts="claude"] [data-account="system"]')).toHaveClass(/on/)
    await expect(pane.locator('[data-accounts="codex"] [data-account="system"]')).toBeVisible()
    await expect(pane.locator('[data-stats] .stat-cards').first()).toBeVisible()
    await expect(pane.locator('[data-stats] .stat-card').first()).toContainText('1') // 띄운 에이전트 1

    // % 남음 → 상태바 5H 33% 사용 = 67% 남음, 주간 12% = 88%.
    await pane.locator('[data-field="usage.display"] [data-value="remaining"]').click()
    await expect(seg).toContainText('67%')
    await expect(seg).toContainText('88%')
    await pane.locator('[data-field="usage.display"] [data-value="used"]').click()
    await expect(seg).toContainText('33%')
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
