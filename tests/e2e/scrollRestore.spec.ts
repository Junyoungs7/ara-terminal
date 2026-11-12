// 2.2.23 준영님 제보 — 전체 화면으로 쓰다 탭을 옮겼다 오면 Claude 칸 휠이 아예 안 먹는다. 전체 화면을 풀면 다시 된다.
// 실제 순서 그대로: AI 작업 공간 → Claude(가짜) 실행 → Claude 전체 화면(tui: fullscreen)처럼 대체 화면 + 마우스 추적 + SGR(?1006) →
// 링(256KB)을 넘는 차분 그리기 → 공간 전환(터미널 → AI)으로 칸이 다시 마운트 → 휠.
// 받는 쪽(가짜)은 휠 보고가 SGR(ESC[<64;…M)로 왔는지 옛 X10(ESC[M…)로 왔는지 센다. 고치기 전엔 다시 붙은 뒤 X10 으로 왔다.
// 🔴 진짜 claude 를 안 띄운다(agents.spec 과 같은 두 겹: agents.json 절대 경로 + PATH 맨 앞). 클립보드·포커스 안 씀.
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { test, expect, tempDir, rmDir } from './fixtures'
import type { Page } from '@playwright/test'

const win = process.platform === 'win32'
const side = '.aiws-side'

const FAKE = String.raw`
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('9.9.9 (fake claude)'); process.exit(0) }
const out = (s) => process.stdout.write(s)
let sgr = 0, legacy = 0, buf = '', last = ''
const status = () => out('\x1b[1;1H\x1b[2KWHEEL sgr=' + sgr + ' legacy=' + legacy + ' last=' + last)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => {
  buf += d.toString('latin1')
  last = d.toString('hex')
  if (buf.includes('\x03')) process.exit(0)
  let m
  while ((m = /\x1b\[<6[45];\d+;\d+M/.exec(buf))) { sgr++; buf = buf.slice(m.index + m[0].length) }
  while ((m = /\x1b\[M[\x60-\xff][\s\S]{0,2}/.exec(buf))) { legacy++; buf = buf.slice(m.index + m[0].length) }
  status()
})
setTimeout(async () => {
  out('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H')
  out('\x1b[10;1H' + '─'.repeat(40) + '\x1b[11;1H> ')
  // 링을 넘기는 차분 그리기(동기 출력) — 64KB 씩 숨 쉬며
  let chunk = ''
  for (let n = 1, total = 0; total < 400 * 1024; n++) {
    const f = '\x1b[?2026h\x1b[12;1H\x1b[2K✻ Working… (' + n + 's)\x1b[?2026l'
    chunk += f; total += Buffer.byteLength(f)
    if (chunk.length > 32 * 1024) { out(chunk); chunk = ''; await new Promise((r) => setTimeout(r, 30)) }
  }
  out(chunk)
  status()
  out('\x1b[13;1HSPAM_DONE')
}, 400)
`

async function agentSessionIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.ev.session.list()).filter((s) => s.space === 'ai').map((s) => s.id))
}
const termText = (page: Page, sid: string): Promise<string> => page.evaluate((s) => window.__evTerm(s)?.text() ?? '', sid)
const wheelCount = async (page: Page, sid: string): Promise<{ sgr: number; legacy: number }> => {
  const m = /WHEEL sgr=(\d+) legacy=(\d+)/.exec(await termText(page, sid))
  return m ? { sgr: +m[1], legacy: +m[2] } : { sgr: 0, legacy: 0 }
}
/** 칸 가운데에 포인터를 두고 위로 한 번 굴린다(CDP 입력 — OS 포인터·포커스와 무관). */
async function wheelUp(page: Page): Promise<void> {
  const box = (await page.locator('.term-pane:visible .xterm').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -120)
}

/** 스크롤 막대 진단(판정 안 함): xterm 6 의 세로 막대 상태와 스크롤 가능한 높이. */
const scrollProbe = (page: Page): Promise<unknown> =>
  page.evaluate(() => {
    const x = document.querySelector('.term-pane:not([hidden]) .xterm') as HTMLElement | null
    const sb = x?.querySelector('.xterm-scrollbar.xterm-vertical') as HTMLElement | null
    const slider = sb?.querySelector('.xterm-slider') as HTMLElement | null
    const sc = x?.querySelector('.xterm-scrollable-element') as HTMLElement | null
    return { sbClass: sb?.className, sliderH: slider?.offsetHeight, sbH: sb?.offsetHeight, scrollH: sc?.scrollHeight, clientH: sc?.clientHeight, screenH: (x?.querySelector('.xterm-screen') as HTMLElement | null)?.offsetHeight, hostH: x?.parentElement?.clientHeight }
  })

test('SCROLL-1★ 링이 잘린 뒤 다시 마운트된 Claude 전체 화면 칸 — 휠이 SGR 로 간다(옛 X10 아님)', async ({ launch, userDataDir }) => {
  const root = realpathSync(tempDir('ara-e2e-scroll-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const js = join(bin, 'fake-claude.cjs')
  writeFileSync(js, FAKE)
  let claude: string
  if (win) {
    claude = join(bin, 'claude.cmd')
    writeFileSync(claude, ['@echo off', `node "${js}" %*`, ''].join('\r\n'))
  } else {
    claude = join(bin, 'claude')
    writeFileSync(claude, ['#!/bin/sh', `exec node "${js}" "$@"`, ''].join('\n'))
    chmodSync(claude, 0o755)
  }
  const repo = join(root, 'agent-repo')
  mkdirSync(repo)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
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
    const picker = page.locator('[data-aiws="agent-picker"]')
    const opt = picker.locator('.aiws-mode[data-agent="claude"]')
    await expect(opt).toContainText('9.9.9', { timeout: 20_000 })
    await opt.click()
    await page.click('[data-aiws="agent-launch"]')
    await expect.poll(async () => (await agentSessionIds(page)).length, { timeout: 20_000 }).toBe(1)
    const [sid] = await agentSessionIds(page)
    await expect.poll(() => termText(page, sid), { timeout: 60_000 }).toContain('SPAM_DONE')
    await expect.poll(() => page.evaluate((s) => window.__evTerm(s)?.modes?.().mouse, sid)).toBe('any')

    // 붙어 있는 동안: SGR 로 간다(대조 — 가짜가 휠을 제대로 센다는 것)
    console.log('SCROLL-1 scrollbar before', JSON.stringify(await scrollProbe(page)))
    await wheelUp(page)
    await expect.poll(() => wheelCount(page, sid), { timeout: 10_000 }).toEqual({ sgr: 1, legacy: 0 })

    // 공간 전환 → 칸이 다시 마운트(새 xterm). 옛 xterm 요소에 표식을 달아 정말 바뀌었는지 본다.
    await page.evaluate(() => ((document.querySelector('.term-pane .xterm') as HTMLElement & { __old?: boolean }).__old = true))
    await page.click('.titlebar .tb-spaces [data-space="term"]')
    await page.click('.titlebar .tb-spaces [data-space="ai"]')
    await expect.poll(() => page.evaluate(() => { const el = document.querySelector('.term-pane .xterm') as (HTMLElement & { __old?: boolean }) | null; return !!el && !el.__old })).toBe(true)
    await expect.poll(() => termText(page, sid), { timeout: 20_000 }).toContain('SPAM_DONE')
    // 스크롤 막대 진단: 대체 화면이면 버퍼 줄 수 = 화면 줄 수(스크롤백 없음)
    const buf = await page.evaluate((s) => window.__evTerm(s)?.buffer?.(), sid)
    console.log('SCROLL-1 buffer after remount', JSON.stringify(buf))
    expect(buf?.type).toBe('alternate')
    console.log('SCROLL-1 scrollbar after', JSON.stringify(await scrollProbe(page)))

    await wheelUp(page)
    await page.waitForTimeout(1_500)
    console.log('SCROLL-1 after remount', /WHEEL .*/.exec(await termText(page, sid))?.[0])
    await expect.poll(() => wheelCount(page, sid), { timeout: 10_000 }).toEqual({ sgr: 2, legacy: 0 })
  } finally {
    process.env.PATH = savedPath
    rmDir(root)
  }
})
