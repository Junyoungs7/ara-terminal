// W1 F14 파일 Ctrl+V — SSH 세션은 현재 원격 디렉토리로 업로드(R7 전송 큐 재사용),
// 로컬 세션은 경로 문자열 붙여넣기. 텍스트만 있으면 종전 동작 그대로.
//
// ⚠️ 이 자동화 세션은 OS 클립보드가 막혀 있다(T1 CLIP-* 와 같은 제약). 게다가 2026-08-09 부터
// 파일 붙여넣기는 **브라우저 paste 이벤트**로 받는데(Windows 에서 여러 파일을 받으려면 그 길뿐이다 —
// store/pasteFiles.ts), 합성 KeyboardEvent 로는 브라우저가 클립보드를 건드리지 않는다.
// 그래서 paste 이벤트를 직접 만들어 넣는다 — 우리 리스너는 document 캡처에 달려 있어 이 경로로 온다.
// 실제 탐색기 복사 → Ctrl+V 는 수동 항목(PASTE-M1)으로 남긴다.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, focusTerminal, newLocalShell, openFileTab, pickSidebarTab, termText } from './fixtures'

// OS 클립보드는 **머신 전역 자원**이다. 텍스트 붙여넣기 검사는 실제 클립보드에 써 넣고 확인하므로
// 병렬로 돌면 서로 덮어쓴다(실측: PASTE-6 이 PASTE-9 가 써 둔 값을 읽었다) — 이 파일은 순차로 돈다.
test.describe.configure({ mode: 'serial' })

const row = (page: Page, name: string) => page.locator(`.ftree .frow:has(.fn:text-is("${name}"))`)

function makeRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'ara-pasteremote-'))
  mkdirSync(join(root, '배포스크립트'))
  writeFileSync(join(root, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
  writeFileSync(join(root, 'README_한글.md'), '# 한글 문서\n')
  return root
}

// 파일이 담긴 붙여넣기를 주입한다. Electron 은 File 에 실경로(path)를 실어 주는데 페이지에서
// 그런 File 을 만들 수는 없으므로, 우리 코드가 실제로 읽는 것(name·path)만 갖춘 객체를 넘긴다.
async function pasteFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((ps) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: ps.map((p) => ({ name: p.split(/[\/]/).pop(), path: p })) }
    })
    document.dispatchEvent(ev)
  }, paths)
}

// 텍스트 붙여넣기는 이제 xterm 이 자기 textarea 로 받는다(bracketed paste 포함) — 렌더러 스텁으로는
// 못 건드린다. main 의 clipboard 로 실제 클립보드에 써 넣고 Playwright 의 Ctrl+V(신뢰된 입력)로 쏜다.
async function setClipboardText(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
}

async function openRemoteTree(
  page: Page,
  ssh: (o: { password: string; sftpRoot: string }) => Promise<{ port: number }>,
  name: string
): Promise<{ remote: string; sessionId: string }> {
  const remote = makeRemote()
  const pw = `pw-${name}`
  const h = await ssh({ password: pw, sftpRoot: remote })
  const sessionId = await connectNewSshProfile(page, { name, port: h.port, password: pw })
  await openFileTab(page)
  await expect(row(page, 'README_한글.md')).toBeVisible({ timeout: 25_000 })
  return { remote, sessionId }
}

// PASTE-1 SSH 세션에서 파일을 붙여넣으면 지금 보고 있는 원격 디렉토리로 올라간다(홈이 아니다)
test('PASTE-1 SSH 터미널 Ctrl+V 가 현재 원격 디렉토리로 업로드한다', async ({ ara, ssh }) => {
  const { page } = ara
  const { remote } = await openRemoteTree(page, ssh, 'paste1')
  // 홈이 아니라 하위 폴더를 보고 있는 상태를 만든다.
  await row(page, '배포스크립트/').dblclick()
  await expect(row(page, 'deploy_운영.sh')).toBeVisible({ timeout: 20_000 })

  const localDir = mkdtempSync(join(tmpdir(), 'ara-pastelocal-'))
  const file = join(localDir, '붙여넣기_확인.txt')
  writeFileSync(file, '클립보드 업로드 한글\n')

  await focusTerminal(page)
  await pasteFiles(page, [file])

  const uploaded = join(remote, '배포스크립트', '붙여넣기_확인.txt')
  await expect.poll(() => existsSync(uploaded), { timeout: 30_000 }).toBe(true)
  await expect
    .poll(() => (existsSync(uploaded) ? readFileSync(uploaded, 'utf8') : ''), { timeout: 20_000 })
    .toContain('클립보드 업로드 한글')
  // 홈으로 잘못 올라가지 않았다.
  expect(existsSync(join(remote, '붙여넣기_확인.txt'))).toBe(false)
})

// PASTE-2 전송 큐(R7)를 그대로 재사용한다 — 진행률·취소가 붙는다
test('PASTE-2 붙여넣기 업로드가 기존 전송 큐 UI 에 들어간다', async ({ ara, ssh }) => {
  const { page } = ara
  await openRemoteTree(page, ssh, 'paste2')
  const localDir = mkdtempSync(join(tmpdir(), 'ara-pastelocal-'))
  const big = join(localDir, 'big_클립보드.bin')
  writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 0x42))

  await focusTerminal(page)
  await pasteFiles(page, [big])

  const xfer = page.locator('.sftp-xfer .xfer-item')
  await expect(xfer).toHaveCount(1, { timeout: 25_000 })
  await expect(xfer.locator('.xfer-label')).toContainText('업로드')
  await expect(xfer.locator('.xfer-cancel')).toBeVisible()
})

// PASTE-3 [연결] 탭을 보고 있어도 진행률이 보이도록 [파일] 탭이 저절로 열린다
test('PASTE-3 붙여넣기 업로드가 [파일] 탭을 펼친다', async ({ ara, ssh }) => {
  const { page } = ara
  await openRemoteTree(page, ssh, 'paste3')
  // 다시 [연결] 탭으로 돌아간 상태에서 붙여넣는다.
  await pickSidebarTab(page, 'conn')
  await expect(page.locator('.sb-tab.on')).toHaveAttribute('data-tab', 'conn')

  const localDir = mkdtempSync(join(tmpdir(), 'ara-pastelocal-'))
  const file = join(localDir, 'reveal_확인.txt')
  writeFileSync(file, '탭 노출 확인\n')

  await focusTerminal(page)
  await pasteFiles(page, [file])
  await expect(page.locator('.sb-tab.on')).toHaveAttribute('data-tab', 'file', { timeout: 20_000 })
})

// PASTE-4 로컬 세션은 업로드할 곳이 없다 — 경로 문자열을 붙여넣는다(실행하지 않는다)
test('PASTE-4 로컬 셸에서는 파일 경로가 붙여넣어진다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  const localDir = mkdtempSync(join(tmpdir(), 'ara-pastelocal-'))
  const file = join(localDir, 'path_only.txt')
  writeFileSync(file, 'x\n')

  await focusTerminal(page)
  await pasteFiles(page, [file])
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('path_only.txt')
  // 줄바꿈이 따라 들어가 실행되지는 않는다 — 프롬프트가 한 줄에 그대로 있다.
  const lines = (await termText(page, id)).split('\n').filter((l) => l.trim())
  expect(lines[lines.length - 1]).toContain('path_only.txt')
})

// PASTE-6 클립보드에 파일이 없으면 종전 텍스트 붙여넣기 그대로
test('PASTE-6 텍스트 클립보드는 기존대로 붙여넣는다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await setClipboardText(app, 'echo 텍스트_붙여넣기_확인')

  await focusTerminal(page)
  await page.keyboard.press('Control+v')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('텍스트_붙여넣기_확인')
})

// PASTE-9 한 번만 붙는다(기본 동작을 남기면 xterm paste 핸들러가 한 번 더 넣는다)
test('PASTE-9 Ctrl+V 로 두 번 붙지 않는다', async ({ ara }) => {
  const { page, app } = ara
  const id = await newLocalShell(page)
  await setClipboardText(app, 'DOUBLEPASTE')

  await focusTerminal(page)
  await page.keyboard.press('Control+v')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('DOUBLEPASTE')
  await page.waitForTimeout(1_500) // 늦게 오는 두 번째 붙여넣기까지 기다린다
  const cursorLine =
    (await termText(page, id))
      .split('\n')
      .filter((l) => l.trim())
      .pop() ?? ''
  expect(cursorLine.split('DOUBLEPASTE').length - 1).toBe(1)
})
