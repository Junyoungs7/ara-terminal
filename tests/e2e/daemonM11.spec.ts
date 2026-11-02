// M11 R2 — 앱 재시작 후 복원(Orca 것) + 터미널 로컬 셸 데몬 이전.
//  DM-M11-1★ 터미널 공간 로컬 셸이 데몬에 산다: 앱 종료 → 다시 켬 → 같은 세션 id·같은 셸 PID·지난 출력(replay)이 이어짐 → 완전 종료 뒤 데몬 0
//  DM-M11-2★ 데몬째 죽음(PC 재부팅 흉내 — 앱 종료 뒤 데몬 강제 종료) → 다시 켬 → 에이전트 탭이 같은 자리·같은 순서·같은 고른 탭으로 다시 뜸(새 PID)
// 🔴 두 시험 모두 ARA_E2E_KEEP_DAEMON=1 — finally 에서 데몬을 반드시 죽인다(daemon.spec.ts DM-1 과 같은 규칙). 진짜 claude 를 띄우지 않는다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir, quitAra, persist, sessionIds, newLocalShell, termText as shellText, sendInput } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

const win = process.platform === 'win32'
const side = '.aiws-side'

const FAKE = String.raw`
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
if (process.argv[2] === '--version') { console.log('9.9.9 (fake)'); process.exit(0) }
out('FAKE-PID ' + process.pid + '\n')
const RULE = '─'.repeat(40)
out(RULE + '\n❯ \n' + RULE + '\n')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
`

// 피커는 PATH 의 claude·codex 로 '설치됨'을 가른다(detect.ts — agents.json 명령은 안 본다) → CLI 이름으로 만들고 bin 을 PATH 맨 앞에.
function fakeAgent(dir: string, name: string): string {
  const js = join(dir, 'fake-m11-agent.cjs')
  writeFileSync(js, FAKE)
  if (win) {
    const p = join(dir, `${name}.cmd`)
    writeFileSync(p, ['@echo off', `node "${js}" %*`, ''].join('\r\n'))
    return p
  }
  const p = join(dir, name)
  writeFileSync(p, ['#!/bin/sh', `exec node "${js}" "$@"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
}

function makeRepo(root: string): string {
  const repo = join(root, 'm11-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

function daemonPids(userData: string): number[] {
  const f = join(userData, 'logs', 'agent-daemon.log')
  if (!existsSync(f)) return []
  return [...readFileSync(f, 'utf8').matchAll(/\[daemon (\d+)\] listening/g)].map((m) => Number(m[1]))
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const killDaemons = (userData: string): void => {
  for (const d of daemonPids(userData)) if (alive(d)) process.kill(d)
}

const SHELL_PID = /SHELLPID-(\d+)/g
const shellPids = (text: string): number[] => [...text.matchAll(SHELL_PID)].map((m) => Number(m[1]))
const echoPid = win ? 'echo "SHELLPID-$PID"\r' : 'echo "SHELLPID-$$"\r'

test('DM-M11-1★ 터미널 로컬 셸: 앱 재시작에도 같은 셸(id·PID·replay) · 완전 종료 뒤 데몬 0', async ({ launch, userDataDir }) => {
  const saved = process.env.ARA_E2E_KEEP_DAEMON
  process.env.ARA_E2E_KEEP_DAEMON = '1'
  try {
    const a = await launch(userDataDir)
    const sid = await newLocalShell(a.page) // 빈 userData 로 켜면 셸이 없다 — 하나 연다
    await sendInput(a.page, sid, echoPid)
    await expect.poll(async () => shellPids(await shellText(a.page, sid)).length, { timeout: 20_000 }).toBeGreaterThan(0)
    const pid = shellPids(await shellText(a.page, sid))[0]
    await persist(a.page)
    await quitAra(a)
    expect(alive(pid)).toBe(true) // 앱이 꺼져도 셸은 데몬에 산다

    const b = await launch(userDataDir)
    await expect.poll(() => sessionIds(b.page), { timeout: 20_000 }).toEqual([sid]) // 새 셸이 아니라 그 셸
    await expect.poll(async () => shellPids(await shellText(b.page, sid)), { timeout: 20_000 }).toContain(pid) // replay
    await sendInput(b.page, sid, echoPid)
    await expect.poll(async () => shellPids(await shellText(b.page, sid)).filter((p) => p === pid).length, { timeout: 20_000 }).toBeGreaterThan(1) // 같은 셸에서 다시

    await b.page.evaluate(() => void window.ev.agents.quitCompletely())
    await expect.poll(() => daemonPids(userDataDir).some(alive) || alive(pid), { timeout: 20_000 }).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.ARA_E2E_KEEP_DAEMON
    else process.env.ARA_E2E_KEEP_DAEMON = saved
    killDaemons(userDataDir)
  }
})

async function openAi(app: ElectronApplication, page: Page, repo: string, addProject: boolean): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  if (addProject) {
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
  }
  await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
}
const agentTabs = (page: Page): Promise<string[]> => page.locator('.aiws-tab[data-agent-tab]').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-tab') ?? ''))
const fakePid = (text: string): number | null => Number(/FAKE-PID (\d+)/.exec(text)?.[1]) || null
const aiIds = (page: Page): Promise<string[]> => page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id))

test('DM-M11-2★ 데몬째 죽음(재부팅 흉내) → 다시 켜면 에이전트 탭이 같은 순서·같은 고른 탭으로 다시 뜸', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-m11-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const [claude, codex, gemini] = ['claude', 'codex', 'gemini'].map((n) => fakeAgent(bin, n))
  const repo = makeRepo(root)
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: claude }, codex: { command: codex }, gemini: { command: gemini } }, migratedAiCliFlags: true }))
  const saved = process.env.ARA_E2E_KEEP_DAEMON
  process.env.ARA_E2E_KEEP_DAEMON = '1'
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const a = await launch(userDataDir)
    await openAi(a.app, a.page, repo, true)
    for (const agent of ['codex', 'claude']) {
      if (agent !== 'codex') await a.page.click('[data-aiws="agent-add"]') // 탭이 생기면 피커는 닫힌다(AgentPane) — 둘째부터는 [+]
      await a.page.click(`[data-aiws="agent-picker"] .aiws-mode[data-agent="${agent}"]`)
      await a.page.click('[data-aiws="agent-launch"]')
      await expect(a.page.locator(`.aiws-tab[data-agent-tab="${agent}"]`)).toBeVisible()
    }
    await expect.poll(() => aiIds(a.page)).toHaveLength(2)
    const before = await aiIds(a.page)
    await a.page.locator('.aiws-tab[data-agent-tab="codex"]').click() // 고른 탭 = 첫 탭
    await expect(a.page.locator('.aiws-tab.on[data-agent-tab="codex"]')).toBeVisible()
    await quitAra(a)
    killDaemons(userDataDir) // PC 재부팅처럼 데몬과 에이전트가 함께 사라진다

    const b = await launch(userDataDir)
    await openAi(b.app, b.page, repo, false)
    await expect.poll(() => agentTabs(b.page), { timeout: 30_000 }).toEqual(['codex', 'claude'])
    await expect(b.page.locator('.aiws-tab.on[data-agent-tab="codex"]')).toBeVisible()
    const after = await aiIds(b.page)
    expect(after).toHaveLength(2)
    expect(after.some((id) => before.includes(id))).toBe(false) // 다시 띄운 새 세션
    await expect.poll(async () => fakePid(await shellText(b.page, after[0])), { timeout: 30_000 }).not.toBeNull()
    await b.page.evaluate(() => void window.ev.agents.quitCompletely())
    await expect.poll(() => daemonPids(userDataDir).some(alive), { timeout: 20_000 }).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.ARA_E2E_KEEP_DAEMON
    else process.env.ARA_E2E_KEEP_DAEMON = saved
    process.env.PATH = savedPath
    killDaemons(userDataDir)
    rmDir(root)
  }
})
