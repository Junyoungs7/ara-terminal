// M3 라운드 1 — 에이전트 피커 → 실행 → 첫 지시(AI-01·02·03).
// 🔴 진짜 claude/codex/gemini 를 띄우지 않는다(사용량·사내 정책): PATH 맨 앞에 받은 인자·첫 지시를 찍고 끝나는 가짜 `claude`·`codex` 를 두고,
//    설정(agents.json)의 실행 명령도 그 가짜의 절대 경로로 미리 박아 둔다 — PATH 순서가 틀려도 진짜가 뜨지 않게 두 겹.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'
import type { Page } from '@playwright/test'

const win = process.platform === 'win32'
const drawer = '.settings-page.open'
const side = '.aiws-side'

/** 가짜 CLI — `--version` 엔 9.9.9, 그 밖엔 받은 인자와 ARA_AGENT_PROMPT 를 찍는다. */
function fakeBin(dir: string, name: string): string {
  const tag = name.toUpperCase()
  if (win) {
    const p = join(dir, `${name}.cmd`)
    writeFileSync(
      p,
      ['@echo off', `if "%~1"=="--version" (echo 9.9.9 ^(fake ${name}^)& exit /b 0)`, `echo FAKE-${tag} ARGS: %*`, `echo FAKE-${tag} PROMPT: %ARA_AGENT_PROMPT%`, ''].join('\r\n')
    )
    return p
  }
  const p = join(dir, name)
  writeFileSync(p, ['#!/bin/sh', `[ "$1" = "--version" ] && { echo "9.9.9 (fake ${name})"; exit 0; }`, `echo "FAKE-${tag} ARGS: $*"`, `echo "FAKE-${tag} PROMPT: $ARA_AGENT_PROMPT"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
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

test('AG-1★ 피커 → 가짜 claude 실행 → 첫 지시가 터미널에 보임 · 새 작업 카드로 codex · 터미널 공간엔 안 섞임', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-agents-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const claude = fakeBin(bin, 'claude')
  const codex = fakeBin(bin, 'codex')
  const gemini = fakeBin(bin, 'gemini') // 안 띄우지만 감지(--version)가 진짜 gemini 에 닿지 않게
  const repo = makeRepo(root)
  // 설정 미리 심기 — 실행 명령을 가짜의 절대 경로로(옛 aiCliFlags 옮기기는 끝난 것으로).
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: claude }, codex: { command: codex }, gemini: { command: gemini } }, migratedAiCliFlags: true })
  )
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const { app, page } = await launch(userDataDir)
    // 실험 기능 → AI 작업 공간 → 프로젝트 추가(폴더 창은 바꿔 끼움) → 본 폴더 줄 고르기.
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="experimental"]`)
    await page.click(`${drawer} .set-row[data-item="exp.aiSpace"] .set-toggle`)
    await page.keyboard.press('Escape')
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()

    // 피커 — 가짜 claude 가 설치·판 9.9.9 로 감지된다.
    const picker = page.locator('[data-aiws="agent-picker"]')
    await expect(picker).toBeVisible()
    const claudeOpt = picker.locator('.aiws-mode[data-agent="claude"]')
    await expect(claudeOpt).toContainText('9.9.9', { timeout: 20_000 })
    await claudeOpt.click()
    await page.fill('[data-aiws="agent-prompt"]', 'hello-fake-agent')
    await page.click('[data-aiws="agent-launch"]')

    // 탭 줄에 Claude Code 탭(실행 중) — 그 터미널에 가짜가 받은 인자(Yolo 플래그)와 첫 지시가 찍힌다.
    const tab = page.locator('.aiws-tab[data-agent-tab="claude"]')
    await expect(tab).toBeVisible()
    await expect(tab).toHaveAttribute('data-state', 'running')
    const [sid] = await agentSessionIds(page)
    await expect.poll(async () => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid), { timeout: 20_000 }).toMatch(/FAKE-CLAUDE ARGS: .*--dangerously-skip-permissions.*hello-fake-agent/)
    await expect.poll(async () => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid)).toMatch(/FAKE-CLAUDE PROMPT: hello-fake-agent/)

    // 새 작업 카드 — 워크트리 없이 + codex + 첫 지시 → 같은 작업 단위에 codex 탭이 하나 더.
    await page.click(`${side} [data-aiws="new"]`)
    await page.click('.aiws-mode[data-mode="none"]')
    await page.selectOption('[data-aiws="new-agent"]', 'codex')
    await page.fill('[data-aiws="new-prompt"]', 'second-task')
    await page.click('[data-aiws="new-create"]')
    await expect(page.locator('.aiws-tab[data-agent-tab="codex"]')).toBeVisible()
    await expect.poll(async () => (await agentSessionIds(page)).length).toBe(2)
    const sid2 = (await agentSessionIds(page)).find((x) => x !== sid)!
    await expect
      .poll(async () => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid2), { timeout: 20_000 })
      .toMatch(/FAKE-CODEX ARGS: .*--dangerously-bypass-approvals-and-sandbox.*second-task/)

    // 터미널 공간 탭 줄에는 에이전트 탭이 없다(Session.space='ai').
    await page.click('.titlebar .tb-spaces [data-space="term"]')
    await expect(page.locator('.term-tabbar')).not.toContainText('Claude Code')
    await expect(page.locator('.term-tabbar')).not.toContainText('Codex')
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
