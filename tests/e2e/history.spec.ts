// W1 F11 명령어 히스토리 + 인라인 고스트 자동완성.
// 타이핑은 실제 키 입력이어야 한다 — xterm 의 printable 입력은 helper textarea 의 input 이벤트라
// 합성 KeyboardEvent 로는 재현되지 않는다(Playwright keyboard.type 은 CDP 로 진짜 입력을 넣는다).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  test,
  expect,
  connectNewSshProfile,
  focusTerminal,
  newLocalShell,
  persist,
  quitAra,
  sendInput,
  termText
} from './fixtures'

type HistoryFile = Record<string, string[]>

function readHistory(userData: string): HistoryFile {
  const p = join(userData, 'history.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as HistoryFile
  } catch {
    return {} // 쓰기 도중에 읽으면 부분 파일일 수 있다 — 다음 폴링에서 다시 본다.
  }
}

const allCommands = (userData: string): string[] => Object.values(readHistory(userData)).flat()

// 히스토리는 5초 디바운스 + before-quit flush 로 디스크에 간다 — 표식이 보일 때까지 기다린다.
async function waitForHistory(userData: string, marker: string): Promise<void> {
  await expect.poll(() => allCommands(userData), { timeout: 20_000, intervals: [500] }).toContain(marker)
}

// 셸에 한 줄 타이핑(사용자 입력 경로 — session.input 으로 넣으면 히스토리 수집을 건너뛴다).
async function typeCommand(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 12 })
  await page.keyboard.press('Enter')
}

const ghost = (page: Page) => page.locator('.term-ghost')

// HIST-1 Enter 로 끊긴 명령이 local scope 에 남는다
test('HIST-1 실행한 명령이 히스토리 파일에 남는다', async ({ ara }) => {
  const { page, userData } = ara
  await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo 수집확인')
  await waitForHistory(userData, 'echo 수집확인')
  expect(readHistory(userData).local).toContain('echo 수집확인')
})

// HIST-2 접두가 일치하면 커서 뒤에 흐린 나머지가 겹쳐 보인다
test('HIST-2 접두 입력에 인라인 고스트가 뜬다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo ghost-source-line')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('ghost-source-line')

  await page.keyboard.type('echo ghost-', { delay: 25 })
  await expect(ghost(page)).toHaveCount(1, { timeout: 15_000 })
  await expect(ghost(page)).toHaveText('source-line')
})

// HIST-3 Tab 이면 고스트가 실제 입력이 된다
test('HIST-3 Tab 으로 고스트를 채택한다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo tab-accept-target')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('tab-accept-target')

  await page.keyboard.type('echo tab-', { delay: 25 })
  await expect(ghost(page)).toHaveText('accept-target', { timeout: 15_000 })
  await page.keyboard.press('Tab')
  await expect(ghost(page)).toHaveCount(0)
  // 흐린 글자가 아니라 셸에 실제로 들어간 입력이다 — 그대로 실행하면 명령으로 동작한다.
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await termText(page, id)).split('tab-accept-target').length, { timeout: 20_000 })
    .toBeGreaterThan(3)
})

// HIST-4 ESC 는 고스트만 지운다(내가 친 것은 남는다)
test('HIST-4 ESC 로 고스트만 지운다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo esc-dismiss-target')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('esc-dismiss-target')

  await page.keyboard.type('echo esc-', { delay: 25 })
  await expect(ghost(page)).toHaveText('dismiss-target', { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(ghost(page)).toHaveCount(0)
  // 입력한 접두는 그대로 살아 있다.
  await page.keyboard.type('X', { delay: 25 })
  await page.keyboard.press('Enter')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('esc-X')
})

// HIST-5 · HIST-6 고스트가 없으면 Tab·ESC 를 앱이 가로채지 않고 셸로 넘긴다(R3.8 정책)
test('HIST-5·6 고스트가 없으면 Tab 과 ESC 가 셸로 그대로 간다', async ({ ara, ssh }) => {
  const { page } = ara
  const seen: string[] = []
  const h = await ssh({ password: 'pw-hist56', onShellData: (d) => seen.push(d) })
  const id = await connectNewSshProfile(page, { name: 'hist56', port: h.port, password: 'pw-hist56' })
  await expect.poll(() => termText(page, id), { timeout: 25_000 }).toContain('원격 셸 준비 완료')

  await focusTerminal(page)
  // 히스토리가 비어 있어 일치 항목이 없다 → 고스트가 뜨지 않는다.
  await page.keyboard.type('zzqq', { delay: 25 })
  await page.waitForTimeout(600)
  await expect(ghost(page)).toHaveCount(0)

  await page.keyboard.press('Tab')
  await expect.poll(() => seen.join(''), { timeout: 10_000 }).toContain('\t')
  await page.keyboard.press('Escape')
  await expect.poll(() => seen.join(''), { timeout: 10_000 }).toContain('\x1b')
})

// HIST-7 비밀번호 프롬프트 뒤의 입력은 어디에도 남지 않는다
test('HIST-7 비밀번호 프롬프트 입력은 히스토리에 남지 않는다', async ({ ara, ssh }) => {
  const { page, app, userData } = ara
  // 에코 하네스를 쓴다 — 프롬프트 문구와 에코를 테스트가 정확히 통제할 수 있다
  // (로컬 PowerShell 은 프롬프트를 어디에 그릴지 PSReadLine 이 정해 재현이 흔들린다).
  const h = await ssh({ password: 'pw-hist7' })
  const id = await connectNewSshProfile(page, { name: 'hist7', port: h.port, password: 'pw-hist7' })
  await expect.poll(() => termText(page, id), { timeout: 25_000 }).toContain('원격 셸 준비 완료')
  await focusTerminal(page)

  // 평범한 명령은 정상 수집된다(이 표식이 디스크에 닿았으면 그 뒤 판정도 끝났다는 뜻).
  await typeCommand(page, 'echo 통과확인')

  // 실제 비밀번호 프롬프트 재현: 프롬프트를 개행 없이 찍어 커서를 그 뒤에 두고,
  // 입력이 pty 에 닿지 않게 해 에코를 끊는다(= 쳐도 화면에 안 찍히는 상태).
  await sendInput(page, id, '\r\nPassword: ')
  const lastLine = async () =>
    (await termText(page, id))
      .split('\n')
      .filter((l) => l.trim())
      .pop() ?? ''
  await expect.poll(lastLine, { timeout: 20_000 }).toContain('Password:')

  await app.evaluate(({ ipcMain }) => ipcMain.removeAllListeners('session:input'))
  await page.keyboard.type('s3cr3t-절대금지', { delay: 12 })
  await page.keyboard.press('Enter')

  await waitForHistory(userData, 'echo 통과확인')
  const recorded = allCommands(userData)
  expect(recorded).not.toContain('s3cr3t-절대금지')
  expect(recorded.join('|')).not.toContain('s3cr3t')
})

// HIST-8 오탐 없음 — 단어만 보고 평범한 명령까지 버리지 않는다
test('HIST-8 echo password 같은 평범한 명령은 기록된다', async ({ ara }) => {
  const { page, userData } = ara
  await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo password')
  await waitForHistory(userData, 'echo password')
})

// HIST-9 공백으로 시작하는 입력은 제외(셸 관례)
test('HIST-9 공백으로 시작한 명령은 기록하지 않는다', async ({ ara }) => {
  const { page, userData } = ara
  await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, ' echo 비밀유지')
  await typeCommand(page, 'echo 표식9')
  await waitForHistory(userData, 'echo 표식9')
  expect(allCommands(userData).join('|')).not.toContain('비밀유지')
})

// HIST-10 scope 분리 — 로컬 고스트에 원격 명령이 뜨지 않는다
test('HIST-10 로컬과 원격 히스토리가 섞이지 않는다', async ({ ara, ssh }) => {
  const { page, userData } = ara
  const localId = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo local-side-cmd')
  await expect.poll(() => termText(page, localId), { timeout: 20_000 }).toContain('local-side-cmd')

  const h = await ssh({ password: 'pw-hist10' })
  const remoteId = await connectNewSshProfile(page, { name: 'hist10', port: h.port, password: 'pw-hist10' })
  await expect.poll(() => termText(page, remoteId), { timeout: 25_000 }).toContain('원격 셸 준비 완료')
  await focusTerminal(page)
  await typeCommand(page, 'echo remote-side-cmd')
  await waitForHistory(userData, 'echo remote-side-cmd')

  // scope 가 둘로 갈려 있다(local + serverKey).
  const file = readHistory(userData)
  expect(file.local).toContain('echo local-side-cmd')
  expect(file.local ?? []).not.toContain('echo remote-side-cmd')
  const remoteScope = Object.keys(file).find((k) => k !== 'local')
  expect(remoteScope).toBeTruthy()
  expect(file[remoteScope!]).toContain('echo remote-side-cmd')

  // 로컬 터미널에서 원격 명령 접두를 쳐도 고스트가 뜨지 않는다.
  await page.locator(`.term-tabbar .ttab[data-session-id="${localId}"]`).click()
  await focusTerminal(page)
  await page.keyboard.type('echo remote-', { delay: 25 })
  await page.waitForTimeout(800)
  await expect(ghost(page)).toHaveCount(0)
})

// HIST-15 세션에서 처음 친 명령도 통째로 기록된다
// ⚠️ 현재 FAIL — 앱 결함(백로그 M-4). 포커스 직후 xterm 이 셸의 DA 질의에 답하고(`ESC[?1;2c`)
//    포커스 리포트(`ESC[I`)를 내보내는데, 이 응답들이 사용자 입력과 같은 term.onData 로 흘러
//    feedInput 이 "리드라인 편집"으로 보고 줄 버퍼를 비운다 → 그때까지 친 글자가 기록에서 사라진다.
//    (셸 동작은 멀쩡하다 — 명령은 그대로 실행된다. 히스토리에만 조각이 남는다.)
//    다른 HIST 시나리오는 focusTerminal 이 파서 큐를 비운 뒤 타이핑하므로 이 결함을 타지 않는다.
test('HIST-15 세션에서 처음 친 명령도 통째로 기록된다', async ({ ara }) => {
  const { page, userData } = ara
  await newLocalShell(page)
  // 사람이 하는 그대로 — 터미널을 누르고 바로 친다(대기 없음).
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  await page.keyboard.type('echo 첫명령_온전', { delay: 12 })
  await page.keyboard.press('Enter')
  await waitForHistory(userData, 'echo 첫명령_온전')
})

// HIST-11 재기동해도 히스토리(고스트)가 살아 있다
test('HIST-11 재기동 후에도 고스트가 그대로 뜬다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  const id = await newLocalShell(a1.page)
  await focusTerminal(a1.page)
  await typeCommand(a1.page, 'echo restart-ghost-source')
  await expect.poll(() => termText(a1.page, id), { timeout: 20_000 }).toContain('restart-ghost-source')
  await persist(a1.page)
  await quitAra(a1) // before-quit 에서 history.json flush

  expect(allCommands(userDataDir)).toContain('echo restart-ghost-source')

  const a2 = await launch(userDataDir)
  // 복원된 세션이 뜰 때까지 기다렸다가 그 터미널에 친다.
  await expect(a2.page.locator('.pane-grid .pane')).toHaveCount(1, { timeout: 40_000 })
  await focusTerminal(a2.page)
  await a2.page.keyboard.type('echo restart-', { delay: 25 })
  await expect(a2.page.locator('.term-ghost')).toHaveText('ghost-source', { timeout: 20_000 })
})

// HIST-16 후보가 둘 이상이면 **목록**이 뜬다 (2026-08-22 준영님 제보 10번 — "IDE 처럼").
// 고스트 하나만으로는 "다른 후보가 있다"는 사실 자체가 안 보였다.
test('HIST-16 후보 목록이 뜨고 ↓ 로 고른다', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo list-alpha')
  await typeCommand(page, 'echo list-beta')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('list-beta')

  await page.keyboard.type('echo list-', { delay: 25 })
  const comp = page.locator('.term-comp')
  await expect(comp).toHaveCount(1, { timeout: 15_000 })
  await expect(comp.locator('.ci')).toHaveCount(2)
  // 첫 줄 = 가장 최근 = beta. 고스트도 같은 것을 가리킨다(둘이 갈리면 Tab 이 딴 걸 넣는다).
  await expect(comp.locator('.ci.on')).toHaveText('echo list-beta')
  await expect(ghost(page)).toHaveText('beta')

  await page.keyboard.press('ArrowDown')
  await expect(comp.locator('.ci.on')).toHaveText('echo list-alpha')
  await expect(ghost(page)).toHaveText('alpha')

  // Tab 은 **고른 것**을 넣는다.
  await page.keyboard.press('Tab')
  await expect(comp).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await termText(page, id)).split('list-alpha').length, { timeout: 20_000 })
    .toBeGreaterThan(3)
})

// HIST-17 후보가 하나뿐이면 목록은 안 뜬다 — 고스트가 이미 그 하나라 같은 말을 두 번 한다.
test('HIST-17 후보가 하나면 목록 없이 고스트만', async ({ ara }) => {
  const { page } = ara
  const id = await newLocalShell(page)
  await focusTerminal(page)
  await typeCommand(page, 'echo only-one-cand')
  await expect.poll(() => termText(page, id), { timeout: 20_000 }).toContain('only-one-cand')

  await page.keyboard.type('echo only-', { delay: 25 })
  await expect(ghost(page)).toHaveText('one-cand', { timeout: 15_000 })
  await expect(page.locator('.term-comp')).toHaveCount(0)
})
