// M9 AI-10 — 상태바 사용량 → 팝오버. 사용량 엔드포인트·실제 자격 파일은 안 쓴다(임시 홈 userData/e2e-home 에는 자격 파일이 없다 →
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
const input = JSON.stringify({ model: { id: 'fake' }, rate_limits: { five_hour: { used_percentage: 33, resets_at: Math.floor(Date.now() / 1000) + 7200 }, seven_day: { used_percentage: 12, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 } } })
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

test('USAGE-1★ 상태바 사용량(statusLine rate_limits) → 누르면 팝오버(Claude 5시간·주간·초기화 시각, Codex 알 수 없음)', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-usage-'))
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
  // 피커의 판 감지는 설정의 명령이 아니라 PATH 의 `claude` 를 본다(detect.ts — where/which). 가짜 bin 을 PATH 앞에 둔다(AG-1 과 같은 규율).
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')

    // 값이 오기 전 — 칸은 서 있고 —(자격 파일이 없는 임시 홈이라 OAuth 는 요청 없이 '알 수 없음').
    const seg = page.locator('.statusbar [data-action="statusbar.usage"]')
    await expect(seg).toBeVisible()
    await expect(seg).toContainText('Claude 5H')

    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click('.aiws-side [data-aiws="add-project"]')
    await page.locator('.aiws-side .aiws-row').filter({ hasText: 'main' }).click()
    await expect(page.locator('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await page.click('[data-aiws="agent-launch"]')

    // statusLine → 훅 서버 → 사용량 → 상태바: 5H 33% · 주간 12%.
    await expect(seg).toContainText('33%', { timeout: 30_000 })
    await expect(seg).toContainText('12%')

    await seg.click()
    const pop = page.locator('.usage-pop')
    await expect(pop).toBeVisible()
    const c = pop.locator('[data-usage-provider="claude"]')
    await expect(c).toContainText('5시간')
    await expect(c).toContainText('33%')
    await expect(c).toContainText('초기화')
    await expect(pop.locator('[data-usage-provider="codex"]')).toContainText('알 수 없음')
    // 바깥을 누르면 닫힌다.
    await page.mouse.click(5, 5)
    await expect(pop).toHaveCount(0)
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
