// M7 R1 — 변경 비교 탭(WS-10) + diff 줄 주석 → 에이전트(WS-11). 저장소는 임시 폴더에 git init 한 것만(사내 저장소에 닿지 않는다).
// 🔴 진짜 AI CLI 를 띄우지 않는다: agents.spec 와 같은 두 겹(PATH 맨 앞 가짜 + agents.json 실행 명령을 가짜 절대 경로로).
// 가짜 claude 는 입력 상자를 그리고, Enter 로 끝난 입력을 `GOT: <글>` 로 찍는다(괄호 붙여넣기 표식은 걷어 낸다) — 받은 프롬프트가 화면에 남는다.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, tempDir, rmDir, quitAra } from './fixtures'

const win = process.platform === 'win32'
const side = '.aiws-side'

const FAKE = String.raw`
const name = process.argv[2]
if (process.argv[3] === '--version') { console.log('9.9.9 (fake ' + name + ')'); process.exit(0) }
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'))
const box = () => out('─'.repeat(40) + '\n❯ \n' + '─'.repeat(40) + '\n  ? for shortcuts\n')
setTimeout(box, 400)
let buf = ''
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  if (d === '\u0003') process.exit(0)
  buf += d
  // 괄호 붙여넣기 안의 줄바꿈은 제출이 아니다 — 붙여넣기가 끝난 뒤의 \r 만 제출로 본다.
  const end = buf.lastIndexOf('\x1b[201~')
  const cr = buf.indexOf('\r', end < 0 ? 0 : end)
  if (cr < 0) return
  const text = buf.slice(0, cr).replace(/\x1b\[20[01]~/g, '')
  buf = ''
  out('\nGOT: ' + text + '\nEND-GOT\n')
  box()
})
`

function fakeClaude(dir: string): string {
  const js = join(dir, 'fake-agent.cjs')
  writeFileSync(js, FAKE)
  if (win) {
    const p = join(dir, 'claude.cmd')
    writeFileSync(p, ['@echo off', `node "${js}" claude %*`, ''].join('\r\n'))
    return p
  }
  const p = join(dir, 'claude')
  writeFileSync(p, ['#!/bin/sh', `exec node "${js}" claude "$@"`, ''].join('\n'))
  chmodSync(p, 0o755)
  return p
}

/** main 에 한 커밋 + 작업 중 변경 두 개(고친 파일 · 새 파일). */
function makeRepo(root: string): string {
  const repo = join(root, 'diff-repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1\nconst b = 20\nconst c = 3\n')
  writeFileSync(join(repo, 'NEW.md'), '# new\n')
  return repo
}

const termText = (page: Page, sid: string): Promise<string> => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid)

async function openRepo(app: ElectronApplication, page: Page, repo: string): Promise<void> {
  await page.click('.titlebar .tb-spaces [data-space="ai"]')
  await app.evaluate(({ dialog: d }, p) => {
    d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
  }, repo)
  await page.click(`${side} [data-aiws="add-project"]`)
  await page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
}

test('DIFF-1★ 변경 → "변경 비교 · 2" 탭 → Monaco diff(나란히/한 줄) → 줄 주석 → 보내기 → 가짜 에이전트가 Orca 형식 프롬프트를 받는다 · 재시작 뒤 주석 남음', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-diff-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = fakeClaude(bin)
  const repo = makeRepo(root)
  writeFileSync(join(userDataDir, 'agents.json'), JSON.stringify({ agents: { claude: { command: fake }, codex: { command: fake }, gemini: { command: fake } }, migratedAiCliFlags: true }))
  const savedPath = process.env.PATH
  process.env.PATH = bin + delimiter + (savedPath ?? '')
  try {
    const first = await launch(userDataDir)
    const { app, page } = first
    await openRepo(app, page, repo)

    // 에이전트(가짜 claude)를 먼저 띄운다 — 주석을 받을 탭.
    const picker = page.locator('[data-aiws="agent-picker"]')
    await expect(picker.locator('.aiws-mode[data-agent="claude"]')).toContainText('9.9.9', { timeout: 20_000 })
    await picker.locator('.aiws-mode[data-agent="claude"]').click()
    await page.click('[data-aiws="agent-launch"]')
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toBeVisible()
    const [sid] = await page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id))

    // diff 를 열기 전엔 diff 에디터가 없다(지연 로드).
    await expect(page.locator('[data-diff="view"]')).toHaveCount(0)
    await page.click('[data-aiws="diff-open"]')
    const tab = page.locator('[data-aiws="diff-tab"]')
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(tab).toContainText('변경 비교 · 2')
    await expect(page.locator('[data-diff-file="NEW.md"]')).toBeVisible()

    // 고친 파일 → 나란히 보기(양쪽 에디터 둘) → 한 줄 보기(하나).
    // M12 R2: 처음 보기 = 설정 › 편집기 [변경 보기](Orca 기본 '한 줄') — 나란히로 바꿔 시작한다.
    await page.click('[data-diff-file="src/app.ts"]')
    await expect(page.locator('[data-diff-layout="inline"]')).toHaveAttribute('aria-checked', 'true')
    await page.click('[data-diff-layout="split"]')
    const mon = page.locator('[data-diff="view"] .diff-monaco')
    await expect(mon.locator('.modified .view-lines')).toContainText('const b = 20')
    await expect(mon.locator('.original .view-lines')).toContainText('const b = 2')
    await page.click('[data-diff-layout="inline"]')
    // Monaco 0.55 의 한 줄 보기는 원본 에디터를 DOM 에서 빼지 않고 폭만 0 으로 접는다 — '숨김'은 폭으로 본다.
    // (원본 줄 번호 칸 35px 은 남는다 — 실측) 바뀐 쪽의 1/4 보다 좁으면 한 줄 보기다.
    await expect
      .poll(async () => {
        const o = (await mon.locator('.editor.original').boundingBox())?.width ?? 0
        const m = (await mon.locator('.editor.modified').boundingBox())?.width ?? 0
        return m > 0 && o < m / 4
      })
      .toBe(true)
    await page.click('[data-diff-layout="split"]')

    // 바뀐 쪽 2줄을 고르고 의견 달기.
    await mon.locator('.modified .view-line').nth(1).click()
    await page.click('[data-diff="add-comment"]')
    await page.fill('[data-diff="comment-input"]', '여기 "20" 맞나요?')
    await page.click('[data-diff="comment-save"]')
    const cmt = page.locator('[data-diff="comment"]')
    await expect(cmt).toHaveCount(1)
    await expect(cmt).toContainText('2줄')
    await expect(page.locator('[data-diff="send"]')).toContainText('· 1')

    // 보내기 → 에이전트 탭으로 옮겨 가고, 가짜 에이전트가 받은 프롬프트가 화면에 찍힌다.
    await page.click('[data-diff="send"]')
    await expect(page.locator('.aiws-tab[data-agent-tab="claude"]')).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => termText(page, sid), { timeout: 30_000 }).toContain('GOT: File: src/app.ts')
    const got = await termText(page, sid)
    expect(got).toContain('Line: 2')
    expect(got).toContain('User comment: "여기 \\"20\\" 맞나요?"')

    // 보낸 뒤 상태 — 보냄 표시, 보낼 것 0.
    await page.click('[data-aiws="diff-tab"]')
    await expect(cmt).toHaveAttribute('data-sent', 'true')
    await expect(page.locator('[data-diff="send"]')).toBeDisabled()

    // 재시작 뒤에도 주석이 남는다(같은 userData — 프로젝트는 이미 등록돼 있다).
    await quitAra(first)
    const again = await launch(userDataDir)
    await again.page.click('.titlebar .tb-spaces [data-space="ai"]')
    await again.page.locator(`${side} .aiws-row`).filter({ hasText: 'main' }).click()
    await again.page.click('[data-aiws="diff-open"]')
    await again.page.click('[data-diff-file="src/app.ts"]')
    await expect(again.page.locator('[data-diff="comment"]')).toContainText('여기 "20" 맞나요?')
    await expect(again.page.locator('[data-diff="comment"]')).toHaveAttribute('data-sent', 'true')
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})

test('DIFF-2 분기 기준 갈래 · 바이너리는 비교를 안 그린다', async ({ ara }) => {
  const { app, page } = ara
  const root = realpathSync(tempDir('ara-e2e-diff2-'))
  try {
    const repo = makeRepo(root)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'ignore' })
    git('checkout', '-q', '-b', 'ara/feat')
    git('add', '.')
    git('commit', '-q', '-m', 'feat')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await app.evaluate(({ dialog: d }, p) => {
      d.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof d.showOpenDialog
    }, repo)
    await page.click(`${side} [data-aiws="add-project"]`)
    await page.locator(`${side} .aiws-row`).first().click()
    await page.click('[data-aiws="diff-open"]')
    await page.click('[data-diff-file="bin.dat"]')
    await expect(page.locator('[data-diff="binary"]')).toBeVisible()
    await page.click('[data-diff-list="branch"]')
    await expect(page.locator('[data-diff="base"]')).toContainText('main')
    await expect(page.locator('[data-aiws="diff-tab"]')).toContainText('변경 비교 · 2')
    await page.click('[data-diff-file="src/app.ts"]')
    await expect(page.locator('[data-diff="view"] .diff-monaco .editor.modified .view-lines')).toContainText('const b = 20')
  } finally {
    rmDir(root)
  }
})
