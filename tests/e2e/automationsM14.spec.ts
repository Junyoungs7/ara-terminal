// M14 R1 — 설정 › 예약 실행([새 자동화] → 저장 → [지금 실행] → 그 작업 단위에 에이전트 탭) · 스킬(임시 홈의 SKILL.md 목록 → 지우기) ·
// MCP 서버(아라가 붙임 줄 · 프로젝트 .mcp.json 에 추가 → 지우기). 🔴 진짜 claude 를 띄우지 않는다(agents.json 의 실행 명령을 가짜로).
// 🔴 실제 ~/.claude 는 안 쓴다 — 앱은 e2e 에서 userData/e2e-home 을 홈으로 본다. 스킬 지우기는 e2e 에서 휴지통 대신 지운다(PC 침범 금지).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'

const win = process.platform === 'win32'
const drawer = '.settings-page.open'

const FAKE = String.raw`
if (process.argv[2] === '--version') { console.log('9.9.9 (fake claude)'); process.exit(0) }
const RULE = '─'.repeat(40)
process.stdout.write((RULE + '\n❯ \n' + RULE + '\n').replace(/\n/g, '\r\n'))
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

test('AUTO-M14★ 예약 실행 만들기·지금 실행 · 스킬 목록·지우기 · 프로젝트 MCP 추가·지우기', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-m14-'))
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
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: claude } }, migratedAiCliFlags: true }))
  const skillDir = join(userDataDir, 'e2e-home', '.claude', 'skills', 'e2e-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: e2e-skill\ndescription: 시험 스킬\n---\n')
  try {
    const { app, page } = await launch(userDataDir)
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click('.aiws-side [data-aiws="add-project"]')
    await page.locator('.aiws-side .aiws-row').filter({ hasText: 'main' }).click()

    // ── 예약 실행 ──
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="automations"]`)
    const auto = page.locator('.sp-pane[data-section="automations"]')
    await auto.locator('[data-action="auto.new"]').click()
    await auto.locator('[data-field="auto.name"]').fill('아침 정리')
    await auto.locator('[data-field="auto.prompt"]').fill('README 를 요약해 줘')
    await auto.locator('[data-action="auto.save"]').click()
    const row = auto.locator('.auto-item').filter({ hasText: '아침 정리' })
    await expect(row).toContainText('평일 09:00')
    await row.locator('[data-action="auto.runNow"]').click()
    await expect(row).toContainText('실행 중', { timeout: 30_000 })
    await row.locator('[data-action="auto.open"]').click()
    await expect(row.locator('[data-run-status="dispatched"]')).toHaveCount(1)
    expect(existsSync(join(userDataDir, 'automations.json'))).toBe(true)

    // ── 스킬 ──
    await page.click(`${drawer} .sp-nav [data-section="skills"]`)
    const skills = page.locator('.sp-pane[data-section="skills"]')
    const skill = skills.locator('[data-skill="e2e-skill"]')
    await expect(skill).toContainText('시험 스킬')
    await skill.locator('[data-action="skills.delete"]').click()
    await page.locator('.dlg-overlay .modal-ft .btn.dgr').click()
    await expect(skill).toHaveCount(0)
    expect(existsSync(skillDir)).toBe(false)

    // ── MCP ──
    await page.click(`${drawer} .sp-nav [data-section="mcpServers"]`)
    const mcp = page.locator('.sp-pane[data-section="mcpServers"]')
    await expect(mcp.locator('[data-mcp-attached="claude"]')).toBeVisible()
    await mcp.locator('[data-field="mcp.name"]').fill('fs')
    await mcp.locator('[data-field="mcp.command"]').fill('npx')
    await mcp.locator('[data-field="mcp.args"]').fill('-y server-fs')
    await mcp.locator('[data-action="mcp.add"]').click()
    await expect(mcp.locator('[data-mcp-server="fs"]')).toBeVisible()
    expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } } })
    await mcp.locator('[data-mcp-server="fs"] [data-action="mcp.remove"]').click()
    await page.locator('.dlg-overlay .modal-ft .btn.dgr').click()
    await expect(mcp.locator('[data-mcp-server="fs"]')).toHaveCount(0)
  } finally {
    rmDir(root)
  }
})
