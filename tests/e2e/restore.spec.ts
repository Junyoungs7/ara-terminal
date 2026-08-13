// 세션 복원 (스펙 AC #6 / F6 · C-4 부분 복원) — 종료→재실행 시 연결·레이아웃·작업디렉토리 자동 복원
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  test,
  expect,
  newLocalShell,
  runCommand,
  persist,
  quitAra,
  sessionList,
  connectNewSshProfile,
  openConnTab,
  dialogConfirm,
  dialog
} from './fixtures'

const slash = (p: string) => p.replace(/\\/g, '/')

// RESTORE-1 로컬 세션 · 분할 배치 · 작업디렉토리가 그대로 돌아온다
test('RESTORE-1 로컬 2세션 + 분할 + cwd 가 재기동 후 복원된다', async ({ userDataDir, launch }) => {
  const dirA = mkdtempSync(join(tmpdir(), 'ara-cwdA-'))
  const dirB = mkdtempSync(join(tmpdir(), 'ara-cwdB-'))

  const a1 = await launch(userDataDir)
  const s1 = await newLocalShell(a1.page)
  await runCommand(a1.page, s1, `cd "${slash(dirA)}"`)
  const s2 = await newLocalShell(a1.page)
  await runCommand(a1.page, s2, `cd "${slash(dirB)}"`)
  await a1.page.keyboard.press('Control+Shift+\\') // 2분할(좌·우)
  await expect(a1.page.locator('.pane-grid .pane')).toHaveCount(2)
  // 두 세션 모두 cwd 가 추적됐는지 확인한 뒤 저장한다(OSC7 지연이 저장 내용을 좌우한다).
  await expect
    .poll(async () => (await sessionList(a1.page)).filter((s) => (s.cwd ?? '').length > 0).length, {
      timeout: 20_000
    })
    .toBe(2)
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect(a2.page.locator('.term-tabbar .ttab')).toHaveCount(2)
  await expect(a2.page.locator('.pane-grid .pane')).toHaveCount(2)
  await expect(a2.page.locator('.pane-grid .restore-err-card')).toHaveCount(0)
  await expect(a2.page.locator('.term-tabbar .ttab.active')).toHaveCount(1)
  const cwds = (await sessionList(a2.page)).map((s) => slash(s.cwd ?? '').toLowerCase())
  expect(cwds).toContain(slash(dirA).toLowerCase())
  expect(cwds).toContain(slash(dirB).toLowerCase())
  // 복원된 패널이 빈 화면이 아니라 실제 출력을 그린다(R1.1 attach 재생).
  for (const s of await sessionList(a2.page)) {
    await expect
      .poll(async () => (await a2.page.evaluate((id) => window.__evTerm(id)?.text() ?? '', s.id)).trim().length, {
        timeout: 25_000
      })
      .toBeGreaterThan(0)
  }
})

// RESTORE-2 사용자가 바꾼 탭 이름이 재기동 후에도 유지된다(R2.1/R3.6)
test('RESTORE-2 바꿔 둔 탭 이름이 재기동 후에도 남는다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await newLocalShell(a1.page)
  await a1.page.dblclick('.term-tabbar .ttab')
  await a1.page.fill('.term-tabbar .tt-edit', '내가정한이름')
  await a1.page.keyboard.press('Enter')
  await expect(a1.page.locator('.term-tabbar .ttab .tlabel')).toHaveText('내가정한이름')
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect(a2.page.locator('.term-tabbar .ttab .tlabel')).toHaveText('내가정한이름', { timeout: 30_000 })
})

// RESTORE-3 SSH 세션도 프로필로 재접속된다
test('RESTORE-3 SSH 세션이 재기동 후 자동 재접속된다', async ({ userDataDir, launch, ssh }) => {
  const h = await ssh({ password: 'pw-r3' })
  const a1 = await launch(userDataDir)
  await connectNewSshProfile(a1.page, { name: 'restore-remote', port: h.port, password: 'pw-r3' })
  await openConnTab(a1.page)
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect
    .poll(async () => (await sessionList(a2.page)).filter((s) => s.type === 'ssh').length, { timeout: 40_000 })
    .toBe(1)
  await expect(a2.page.locator('.pane-grid .restore-err-card')).toHaveCount(0)
})

// RESTORE-4 부분 복원(C-4): SSH 만 실패하고 나머지는 정상 + 재시도로 복구
test('RESTORE-4 SSH 재접속 실패는 그 패널만 오류 카드가 되고 재시도로 살아난다', async ({
  userDataDir,
  launch,
  ssh
}) => {
  const hostKeyPem = (await ssh({ password: 'seed' })).hostKeyPem // 같은 호스트키를 재사용(지문 유지)
  const h = await ssh({ password: 'pw-r4', hostKeyPem })
  const port = h.port

  const a1 = await launch(userDataDir)
  await newLocalShell(a1.page) // 로컬 1개는 정상 복원돼야 한다
  await connectNewSshProfile(a1.page, { name: 'flaky-remote', port, password: 'pw-r4' })
  await openConnTab(a1.page)
  await a1.page.keyboard.press('Control+Shift+\\')
  await expect(a1.page.locator('.pane-grid .pane')).toHaveCount(2)
  await persist(a1.page)
  await quitAra(a1)
  await h.close() // 서버 다운 → 재접속 실패 유도

  const a2 = await launch(userDataDir)
  const errCard = a2.page.locator('.pane-grid .restore-err-card')
  await expect(errCard).toHaveCount(1, { timeout: 60_000 })
  await expect(errCard.locator('.rec-title')).toHaveText('연결 복원 실패')
  await expect(errCard.locator('.rec-btn.primary')).toHaveText('재시도')
  // 로컬 세션은 정상 — 전체 실패가 아니다.
  expect((await sessionList(a2.page)).length).toBe(1)
  await expect(a2.page.locator('.pane-grid .pane')).toHaveCount(2)

  // 서버 복귀(같은 포트·같은 호스트키) 후 재시도 → 실제 세션으로 교체된다.
  await ssh({ password: 'pw-r4', hostKeyPem, port })
  await errCard.locator('.rec-btn.primary').click()
  await expect(a2.page.locator('.pane-grid .restore-err-card')).toHaveCount(0, { timeout: 40_000 })
  await expect
    .poll(async () => (await sessionList(a2.page)).filter((s) => s.type === 'ssh').length, { timeout: 30_000 })
    .toBe(1)
})

// RESTORE-5 오류 카드 닫기 = 재시도 포기(패널만 제거)
test('RESTORE-5 복원 오류 카드를 닫으면 그 패널만 사라진다', async ({ userDataDir, launch, ssh }) => {
  const h = await ssh({ password: 'pw-r5' })
  const a1 = await launch(userDataDir)
  await connectNewSshProfile(a1.page, { name: 'gone-remote', port: h.port, password: 'pw-r5' })
  await openConnTab(a1.page)
  await persist(a1.page)
  await quitAra(a1)
  await h.close()

  const a2 = await launch(userDataDir)
  const errCard = a2.page.locator('.pane-grid .restore-err-card')
  await expect(errCard).toHaveCount(1, { timeout: 60_000 })
  await errCard.locator('.rec-btn:not(.primary)').click()
  await expect(a2.page.locator('.pane-grid .restore-err-card')).toHaveCount(0)
  await expect(a2.page.locator('.pane-grid .pane')).toHaveCount(0)
})

// RESTORE-6 창 크기가 재기동 후 복원된다(F6 ui.window)
test('RESTORE-6 창 크기가 재기동 후 복원된다', async ({ userDataDir, launch }) => {
  const a1 = await launch(userDataDir)
  await a1.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 760))
  await a1.page.waitForTimeout(600)
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  const size = await a2.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  // 정확히 같은 값으로 단정하지 않는다 — 분수 배율(이 PC 는 1.5 배)에서 DIP 반올림으로 1~2 어긋난다.
  // "복원됐다"는 뜻은 그 오차로 흔들리지 않는다(2026-08-13 · 기대 1180 에 실제 1182 였다).
  expect(Math.abs(size[0] - 1180), `width ${size[0]}`).toBeLessThanOrEqual(2)
  expect(Math.abs(size[1] - 760), `height ${size[1]}`).toBeLessThanOrEqual(2)
})

// RESTORE-7 저장된 프로필·신뢰한 호스트키가 재기동 후에도 남는다
test('RESTORE-7 프로필과 호스트키 신뢰가 재기동 후에도 유지된다', async ({ userDataDir, launch, ssh }) => {
  const h = await ssh({ password: 'pw-r7' })
  const a1 = await launch(userDataDir)
  await connectNewSshProfile(a1.page, { name: 'persist-remote', port: h.port, password: 'pw-r7' })
  await openConnTab(a1.page)
  // 세션은 남기지 않는다 — 프로필·knownHosts 만 확인하기 위해서다.
  // SSH 탭 닫기는 확인 다이얼로그를 거친다(원격 작업이 끊긴다). 확인을 빼먹으면 세션이 살아남아
  // 스냅샷에 실리고, 재기동 후 복원된 세션 + 새 접속으로 세션이 2개가 된다.
  await a1.page.click('.term-tabbar .ttab .tx')
  await dialogConfirm(a1.page)
  await persist(a1.page)
  await quitAra(a1)

  const a2 = await launch(userDataDir)
  await expect(a2.page.locator('.tree .srv-node .sname')).toHaveText('persist-remote')
  await a2.page.dblclick('.tree .srv-node')
  // 지문을 이미 신뢰했으므로 확인 없이 접속된다(비밀번호도 vault 에서 복구된다).
  await expect.poll(async () => (await sessionList(a2.page)).length, { timeout: 30_000 }).toBe(1)
  await expect(dialog(a2.page)).toHaveCount(0)
})
