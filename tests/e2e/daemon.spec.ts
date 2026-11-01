// M4 DM-01 — 로컬 터미널 데몬: AI 작업 공간 에이전트 PTY 가 앱 재시작에도 산다(같은 PID·출력 이어짐), 데몬이 죽으면 앱이 알아챈다.
// 🔴 진짜 claude 를 띄우지 않는다: 가짜(node)가 자기 PID 를 찍고 받은 줄을 되돌려 준다. agents.json 실행 명령을 그 절대 경로로.
// 🔴 이 시험만 ARA_E2E_KEEP_DAEMON=1 — 다른 e2e 는 앱이 꺼질 때 데몬도 내린다(main/agents/feature.ts exitWithClients). 끝에서 반드시 데몬을 죽인다.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, tempDir, rmDir, quitAra } from './fixtures'
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
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  if (!buf.includes('\r')) return
  out('\nECHO: ' + buf.split('\r')[0] + '\n')
  buf = ''
})
`

function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-daemon-agent.cjs')
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
  const repo = join(root, 'daemon-repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  return repo
}

const agentIds = (page: Page): Promise<string[]> => page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id))
const termText = (page: Page, sid: string): Promise<string> => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid)
const pidIn = (text: string): number | null => Number(/FAKE-PID (\d+)/.exec(text)?.[1]) || null

/** 데몬 로그(앱 로그 폴더)에서 마지막으로 listening 한 데몬 PID. */
function daemonPid(userData: string): number | null {
  const f = join(userData, 'logs', 'agent-daemon.log')
  if (!existsSync(f)) return null
  const m = [...readFileSync(f, 'utf8').matchAll(/\[daemon (\d+)\] listening/g)].pop()
  return m ? Number(m[1]) : null
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

test('DM-1★ 에이전트 실행 → 앱 종료 → 다시 켬 → 같은 PID·출력 이어짐 · 데몬 강제 종료 → 앱이 알아챔(잃음)', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-daemon-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeClaude(bin)
  const repo = makeRepo(root)
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: fake }, codex: { command: fake }, gemini: { command: fake } }, migratedAiCliFlags: true }))
  const saved = process.env.ARA_E2E_KEEP_DAEMON
  process.env.ARA_E2E_KEEP_DAEMON = '1'
  try {
    // ① 띄운다
    const a = await launch(userDataDir)
    await openAi(a.app, a.page, repo, true)
    await a.page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await a.page.click('[data-aiws="agent-launch"]')
    await expect(a.page.locator('.aiws-tab[data-agent-tab="claude"]')).toBeVisible()
    const [sid] = await agentIds(a.page)
    await expect.poll(async () => pidIn(await termText(a.page, sid)), { timeout: 30_000 }).not.toBeNull()
    const pid = pidIn(await termText(a.page, sid))!
    await a.page.evaluate((s) => window.ev.session.input(s, 'before\r'), sid)
    await expect.poll(() => termText(a.page, sid), { timeout: 10_000 }).toContain('ECHO: before')
    const dpid = daemonPid(userDataDir)
    expect(dpid).not.toBeNull()

    // ② 앱 종료 — 에이전트·데몬은 산다
    await quitAra(a)
    expect(alive(pid)).toBe(true)
    expect(alive(dpid!)).toBe(true)

    // ③ 다시 켬 — 같은 세션·같은 PID, 지난 출력(replay) + 새 입력이 이어진다
    const b = await launch(userDataDir)
    await openAi(b.app, b.page, repo, false)
    await expect(b.page.locator('.aiws-tab[data-agent-tab="claude"]')).toBeVisible({ timeout: 20_000 })
    expect(await agentIds(b.page)).toEqual([sid])
    await expect.poll(() => termText(b.page, sid), { timeout: 20_000 }).toContain('ECHO: before')
    expect(pidIn(await termText(b.page, sid))).toBe(pid)
    await b.page.evaluate((s) => window.ev.session.input(s, 'after\r'), sid)
    await expect.poll(() => termText(b.page, sid), { timeout: 10_000 }).toContain('ECHO: after')
    expect(daemonPid(userDataDir)).toBe(dpid) // 같은 판 — 같은 데몬을 그대로 쓴다

    // ④ 데몬 강제 종료 → 앱이 알아챈다: 탭은 "잃음", 데몬은 다시 뜬다
    process.kill(dpid!)
    const tab = b.page.locator('.aiws-tab[data-agent-tab="claude"]')
    await expect(tab).toHaveAttribute('data-state', 'exited', { timeout: 20_000 })
    await expect(tab.locator('.aiws-tab-state')).toHaveText('잃음')
    await expect.poll(() => daemonPid(userDataDir), { timeout: 20_000 }).not.toBe(dpid)

    // ⑤ 완전 종료 — 에이전트까지 끝내고 앱이 닫힌다(데몬도 내려간다)
    const newDaemon = daemonPid(userDataDir)!
    await b.page.evaluate(() => void window.ev.agents.quitCompletely())
    await expect.poll(() => alive(newDaemon), { timeout: 20_000 }).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.ARA_E2E_KEEP_DAEMON
    else process.env.ARA_E2E_KEEP_DAEMON = saved
    // 무슨 일이 있어도 데몬·가짜 에이전트를 남기지 않는다.
    const d = daemonPid(userDataDir)
    if (d && alive(d)) process.kill(d)
    rmDir(root)
  }
})

// M4 R3 자원 상한 — 낮은 우선순위가 에이전트(셸의 자식)까지 물려 내려가고, 메모리 상한을 넘으면 알림 센터에 한 번 뜬다(자동 종료 없음).
// 끄는 것은 사람이: 자원 관리자 [터미널] 줄의 [종료]. 상한은 1 MB — 셸 하나로도 넘는다. 표본은 10초마다라 넉넉히 기다린다.
test('DM-2 자원 상한: 낮은 우선순위 상속 · 메모리 넘음 알림 한 번 · 자원 관리자 에이전트 줄·상한 · [종료]', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-caps-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeClaude(bin)
  const repo = makeRepo(root)
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify({ agents: { claude: { command: fake }, codex: { command: fake }, gemini: { command: fake } }, migratedAiCliFlags: true, lowPriority: true, memoryCapMb: 1 })
  )
  try {
    const a = await launch(userDataDir)
    await openAi(a.app, a.page, repo, true)
    await a.page.click('[data-aiws="agent-picker"] .aiws-mode[data-agent="claude"]')
    await a.page.click('[data-aiws="agent-launch"]')
    const [sid] = await agentIds(a.page)
    await expect.poll(async () => pidIn(await termText(a.page, sid)), { timeout: 30_000 }).not.toBeNull()
    // 가짜 에이전트는 데몬 셸이 띄운 자식이다 — 셸에 건 우선순위를 물려받았어야 한다.
    const { getPriority, constants } = await import('node:os')
    expect(getPriority(pidIn(await termText(a.page, sid))!)).toBe(constants.priority.PRIORITY_BELOW_NORMAL)

    // 넘음 알림(오류 토스트) — 한 번만
    const toast = a.page.locator('.ntf-toasts .ntf-toast[data-kind="error"]', { hasText: '메모리가 상한을 넘었습니다' })
    await expect(toast).toBeVisible({ timeout: 40_000 })
    await a.page.waitForTimeout(12_000) // 표본 한 번 더
    await a.page.click('.titlebar .tb-bell')
    await expect(a.page.locator('.titlebar .ntf-menu .ntf-item', { hasText: '메모리가 상한을 넘었습니다' })).toHaveCount(1)

    // 자원 관리자: 에이전트 줄 + 상한 줄, 넘은 줄 표시 → [종료]로 끈다(탭이 끝난다)
    await a.page.keyboard.press('Escape')
    await a.page.click('[data-action="statusbar.resources"]')
    await a.page.click('[data-action="resources.tab.pty"]')
    await expect(a.page.locator('.res-pop [data-res="agent-limits"]')).toContainText('1 MB')
    const row = a.page.locator(`.res-pop .res-row[data-session="${sid}"]`)
    await expect(row).toHaveAttribute('data-agent', 'true')
    await expect(row).toHaveClass(/over/, { timeout: 10_000 })
    await row.locator('[data-action="resources.pty.kill"]').click()
    await row.locator('[data-action="resources.pty.killConfirm"]').click()
    await expect.poll(() => agentIds(a.page), { timeout: 15_000 }).toEqual([])
    await quitAra(a)
  } finally {
    const d = daemonPid(userDataDir)
    if (d && alive(d)) process.kill(d)
    rmDir(root)
  }
})
