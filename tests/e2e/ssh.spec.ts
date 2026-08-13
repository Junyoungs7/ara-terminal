// SSH 연결 관리 (스펙 AC #1 / F3 · R6) — 프로필 CRUD · TOFU 호스트키 · 실패 다이얼로그 · 트리 메뉴
import {
  test,
  expect,
  connectNewSshProfile,
  openConnTab,
  connModal,
  dialog,
  dialogConfirm,
  fillNewProfile,
  sessionList,
  expectTermText
} from './fixtures'

// SSH-1 연결 관리자에서 프로필을 만들고 최초 접속(TOFU 지문 확인)까지
test('SSH-1 프로필 저장 → 호스트키 확인 → 접속', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh1' })
  const id = await connectNewSshProfile(page, {
    name: 'ssh1-server',
    port: h.port,
    username: 'deploy',
    password: 'pw-ssh1'
  })
  await openConnTab(page)
  await expectTermText(page, id, /원격 셸 준비 완료/) // 한글 배너 무결
  expect((await sessionList(page)).find((s) => s.id === id)?.type).toBe('ssh')
  // 상태바가 활성 SSH 세션의 user@host:port 를 찍는다(R4.2).
  await expect(page.locator('.statusbar .sb-seg.host .val')).toHaveText(`deploy@127.0.0.1:${h.port}`)
  await expect(page.locator('.tree .srv-node .sname')).toHaveText('ssh1-server')
})

// SSH-2 두 번째 접속은 지문 확인 없이 곧바로(knownHosts 기록됨)
test('SSH-2 이미 신뢰한 서버는 확인 없이 새 세션이 열린다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh2' })
  await connectNewSshProfile(page, { name: 'ssh2-server', port: h.port, password: 'pw-ssh2' })
  await openConnTab(page)
  await page.dblclick('.tree .srv-node') // 서버 노드 더블클릭 = 새 세션 접속
  await expect.poll(async () => (await sessionList(page)).length, { timeout: 30_000 }).toBe(2)
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.locator('.tree .sess-list .sess-node')).toHaveCount(2)
})

// SSH-3 접속 실패(포트 닫힘) → 네이티브 alert 이 아닌 커스텀 다이얼로그
test('SSH-3 연결 실패는 사유가 담긴 다이얼로그로 알린다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'x' })
  const deadPort = h.port
  await h.close() // 아무도 듣지 않는 포트

  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await fillNewProfile(page, { name: 'dead-server', port: deadPort, password: 'x' })
  await page.click('.modal-ft .btn.pri')
  await dialog(page).waitFor({ timeout: 30_000 })
  await expect(dialog(page)).toContainText('연결 오류')
  await dialogConfirm(page)
  expect((await sessionList(page)).length).toBe(0)
  // 프로필 자체는 저장돼 있다(재입력 없이 고쳐 쓸 수 있어야 한다).
  await expect(connModal(page).locator('.prof-list .prof')).toHaveCount(1)
})

// SSH-4 인증 실패 → "비밀번호 다시 입력" 경로 제공
test('SSH-4 인증 실패 다이얼로그에서 비밀번호 재입력으로 이어진다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'correct-pw' })
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await fillNewProfile(page, { name: 'auth-fail', port: h.port, password: 'wrong-pw' })
  await page.click('.modal-ft .btn.pri')
  // ① 최초 접속이므로 호스트키 확인이 먼저 온다.
  await dialog(page).waitFor({ timeout: 20_000 })
  await expect(dialog(page)).toContainText('처음 보는 호스트키')
  await dialogConfirm(page)
  // ② 지문 통과 후 인증 실패.
  await expect(dialog(page)).toContainText('인증 실패', { timeout: 30_000 })
  await expect(dialog(page).locator('.modal-ft .btn.sec')).toContainText(['비밀번호 다시 입력'])
  await dialog(page).locator('.modal-ft .btn.sec:has-text("비밀번호 다시 입력")').click()
  await expect(connModal(page)).toBeVisible()
  expect((await sessionList(page)).length).toBe(0)
})

// SSH-5 트리 우클릭 → 정보 수정
test('SSH-5 트리 우클릭 정보 수정이 해당 프로필로 연결 관리자를 연다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh5' })
  await connectNewSshProfile(page, { name: 'edit-me', port: h.port, password: 'pw-ssh5' })
  await openConnTab(page)
  await page.click('.tree .srv-node', { button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="server.edit"]')
  await expect(connModal(page)).toBeVisible()
  await expect(connModal(page).locator('.prof.sel .pf-name')).toContainText('edit-me')
  await expect(page.locator('.prof-form .fld:has(> label:text-is("연결 이름")) input')).toHaveValue('edit-me')
})

// SSH-6 트리 우클릭 → 복제(비밀은 복사하지 않는다)
test('SSH-6 서버 복제로 사본 프로필이 만들어진다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh6' })
  await connectNewSshProfile(page, { name: 'dup-src', port: h.port, password: 'pw-ssh6' })
  await openConnTab(page)
  await page.click('.tree .srv-node', { button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="server.duplicate"]')
  await expect(connModal(page).locator('.prof-list .prof')).toHaveCount(2)
  await expect(page.locator('.prof-form .fld:has(> label:text-is("연결 이름")) input')).toHaveValue('dup-src 사본')
})

// SSH-7 호스트키 재설정 → 다음 접속에서 다시 지문 확인
// BLOCKER-1 회귀 감시: 저장 계약이 다시 넓어져 렌더러가 knownHosts 를 되돌려 보내면 여기서 깨진다.
test('SSH-7 호스트키를 재설정하면 다음 접속에서 다시 확인한다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh7' })
  await connectNewSshProfile(page, { name: 'forget-me', port: h.port, password: 'pw-ssh7' })
  await openConnTab(page)
  await page.click('.tree .srv-node', { button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="server.forgetHostKey"]')
  await expect(dialog(page)).toContainText('호스트키 재설정')
  await dialogConfirm(page)
  await page.dblclick('.tree .srv-node')
  await expect(dialog(page)).toContainText('처음 보는 호스트키', { timeout: 20_000 })
})

// SSH-8 프로필 삭제(위험 톤 확인 다이얼로그)
// BLOCKER-1 회귀 감시: 삭제 직후 도착한 저장이 프로필을 되살리면 여기서 깨진다.
test('SSH-8 프로필을 삭제하면 트리에서 사라진다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-ssh8' })
  await connectNewSshProfile(page, { name: 'delete-me', port: h.port, password: 'pw-ssh8' })
  await openConnTab(page)
  await expect(page.locator('.tree .srv-node')).toHaveCount(1)
  await page.click('.tree .srv-node', { button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="server.delete"]')
  await expect(dialog(page)).toContainText('프로필 삭제')
  await expect(dialog(page)).toHaveClass(/danger/)
  await dialogConfirm(page)
  await expect(page.locator('.tree .srv-node')).toHaveCount(0)
  const profiles = await page.evaluate(() => window.ev.profile.list())
  expect(profiles).toHaveLength(0)
})
