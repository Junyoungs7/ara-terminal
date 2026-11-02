// M14 R2 `ara` CLI — 떠 있는 아라(임시 userData)에 진짜 CLI(번들한 araCli.js 를 node 로)를 붙여 왕복한다.
//  · status → 켜짐 · worktree list → 추가한 프로젝트의 main · worktree set --comment → 사이드바 카드에 메모(cli:worktreesChanged)
//  · terminal create → 터미널 공간에 그 폴더 셸 · 오타 명령 → Did you mean(종료 2)
//  · 설정 › 스킬 맨 위 "ara 명령줄" 블록: 개발 실행이라 [CLI 설치]는 꺼져 있다(사용자 PATH 를 건드리지 않는다), 번들 스킬 [설치] → 임시 홈에만.
// 🔴 실제 사용자 PATH·레지스트리·~/.claude 는 건드리지 않는다(앱은 e2e 에서 userData/e2e-home 을 홈으로 본다).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { test, expect, tempDir } from './fixtures'

const drawer = '.settings-page.open'

test('CLI-M14★ ara status·worktree list·set(메모 → 사이드바)·terminal create·명령 제안 · 설정 CLI 블록·번들 스킬 설치', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-cli-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const cli = join(root, 'araCli.cjs')
  buildSync({ entryPoints: [join(__dirname, '../../src/cli/araCli.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cli, alias: { '@shared': join(__dirname, '../../src/shared') }, logLevel: 'silent' })
  const ara = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: repo, env: { ...process.env, ARA_USER_DATA_PATH: userDataDir }, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    return { code: r.status, body: JSON.parse(r.stdout || '{}') as { ok: boolean; result?: any; error?: any } }
  }

  const { app, page } = await launch(userDataDir)
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await app.evaluate(({ dialog: d }, p) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
  }, repo)
  await page.click('.aiws-side [data-aiws="add-project"]')
  const mainRow = page.locator('.aiws-side .aiws-row').filter({ hasText: 'main' })
  await expect(mainRow).toHaveCount(1)

  // ── 파이프 왕복 ──
  await expect.poll(() => existsSync(join(userDataDir, 'ara-runtime.json'))).toBe(true)
  expect(ara('status').body.result.app.running).toBe(true)
  const list = ara('worktree', 'list')
  expect(list.code).toBe(0)
  expect(list.body.result.worktrees.map((w: { branch: string }) => w.branch)).toContain('refs/heads/main')

  // cwd = 저장소 → active 가 그 작업 단위. 메모가 사이드바 카드에 뜬다.
  const set = ara('worktree', 'set', '--worktree', 'active', '--comment', 'CLI 에서 남긴 메모', '--workspace-status', 'in-progress')
  expect(set.code).toBe(0)
  await expect(mainRow.locator('.aiws-row-cmt')).toHaveText('CLI 에서 남긴 메모')

  const term = ara('terminal', 'create', '--worktree', 'active')
  expect(term.code).toBe(0)
  expect(ara('terminal', 'list').body.result.terminals.map((t: { id: string }) => t.id)).toContain(term.body.result.terminal.id)

  const typo = ara('worktree', 'lsit')
  expect(typo.code).toBe(2)
  expect(typo.body.error.nextSteps[0]).toContain('ara worktree list')

  // ── 설정 › 스킬 맨 위 ──
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await page.keyboard.press('Control+,')
  await page.click(`${drawer} .sp-nav [data-section="skills"]`)
  const pane = page.locator('.sp-pane[data-section="skills"]')
  await expect(pane.locator('[data-cli-state="unsupported"]')).toHaveCount(1)
  await expect(pane.locator('[data-action="cli.toggle"]')).toBeDisabled()
  const claudeRow = pane.locator('[data-cli-skill="home-claude"]')
  await expect(claudeRow).toHaveAttribute('data-state', 'missing')
  await claudeRow.locator('[data-action="cli.skill.install"]').click()
  await expect(claudeRow).toHaveAttribute('data-state', 'installed')
  expect(existsSync(join(userDataDir, 'e2e-home', '.claude', 'skills', 'ara-cli', 'SKILL.md'))).toBe(true)
  // 설치한 번들 스킬이 아래 스킬 목록에도 보인다.
  await expect(pane.locator('[data-skill="ara-cli"]')).toHaveCount(1)

  // 끄면 ara-runtime.json 이 지워진다(남은 파일이 "켜짐"으로 읽히지 않게).
  await app.close()
  expect(existsSync(join(userDataDir, 'ara-runtime.json'))).toBe(false)
})
