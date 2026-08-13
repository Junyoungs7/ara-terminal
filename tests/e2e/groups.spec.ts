// 연결 그룹 · 트리 검색 (R6)
import {
  test,
  expect,
  connectNewSshProfile,
  connModal,
  dialog,
  dialogConfirm,
  fillNewProfile,
  newLocalShell,
  openConnTab
} from './fixtures'

const groupHeaders = (page: import('@playwright/test').Page) =>
  page.locator('.tree .srv-group > .srv-hd').allTextContents()

// GROUP-0★ 첫 화면 — **아무것도 등록 안 했으면 트리는 비어 있다.** 준영님 2026-08-13:
// "초기에 아무것도 등록 안 하면 아무것도 안 뜨거나 새로 등록하게 해야 하는데 지금 로컬 그룹이 보인다."
// 그전에는 세션이 없어도 "로컬 0" 한 줄이 상시 떠서, 등록하라는 안내가 그 아래로 밀렸다.
test('GROUP-0★ 아무것도 등록하지 않은 첫 화면에는 그룹이 하나도 없고 등록 안내만 뜬다', async ({ ara }) => {
  const { page } = ara
  await expect(page.locator('.tree .srv-group')).toHaveCount(0)
  await expect(page.locator('.tree .empty')).toContainText('새 연결 추가')

  // 로컬 셸을 열면 그때 [로컬] 그룹이 생긴다(세션을 어딘가에는 보여 줘야 한다).
  await newLocalShell(page)
  await expect(page.locator('.tree .srv-group:has(.srv-hd:has-text("로컬"))')).toHaveCount(1)
})

// GROUP-1 사이드바 빈 영역 우클릭 → 새 그룹(프로필이 없어도 트리에 남는다)
test('GROUP-1 빈 그룹을 만들면 트리에 남는다', async ({ ara }) => {
  const { page } = ara
  await page.click('.tree', { button: 'right', position: { x: 20, y: 200 } })
  await page.click('.ctx-menu .ctx-item[data-action="group.new"]')
  await expect(dialog(page)).toContainText('새 그룹')
  await page.fill('.dlg-input', '운영')
  await dialogConfirm(page)
  await expect.poll(async () => (await groupHeaders(page)).join('|')).toContain('운영')
})

// GROUP-2 그룹을 지정해 만든 연결이 그 그룹 밑에 붙는다
test('GROUP-2 그룹을 지정한 연결이 해당 그룹에 들어간다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-g2' })
  await connectNewSshProfile(page, { name: 'g2-server', port: h.port, password: 'pw-g2', group: '개발' })
  await openConnTab(page)
  const group = page.locator('.tree .srv-group:has(.srv-hd:has-text("개발"))')
  await expect(group.locator('.srv-node .sname')).toHaveText('g2-server')
  await expect(group.locator('.srv-hd .g-count')).toHaveText('1')
})

// GROUP-3 그룹 이름 변경 — 속한 연결의 그룹도 함께 바뀐다
// BLOCKER-1 회귀 감시: 저장이 옛 프로필 배열을 되돌려 보내면 이름 변경이 원복돼 여기서 깨진다.
test('GROUP-3 그룹 이름을 바꾸면 속한 연결도 따라간다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-g3' })
  await connectNewSshProfile(page, { name: 'g3-server', port: h.port, password: 'pw-g3', group: '개발' })
  await openConnTab(page)
  await page.locator('.tree .srv-group:has(.srv-hd:has-text("개발")) > .srv-hd').click({ button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="group.rename"]')
  await expect(dialog(page)).toContainText('그룹 이름 변경')
  await page.fill('.dlg-input', '스테이징')
  await dialogConfirm(page)
  const renamed = page.locator('.tree .srv-group:has(.srv-hd:has-text("스테이징"))')
  await expect(renamed.locator('.srv-node .sname')).toHaveText('g3-server', { timeout: 20_000 })
  await expect.poll(async () => (await groupHeaders(page)).join('|')).not.toContain('개발')
})

// GROUP-4 그룹 삭제 — 그룹만 없애고 연결은 "기타"로 내려간다
// BLOCKER-1 회귀 감시: ui.groups·profiles 가 저장 페이로드로 되살아나면 여기서 깨진다.
test('GROUP-4 그룹을 지워도 연결은 남아 기타로 옮겨진다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-g4' })
  await connectNewSshProfile(page, { name: 'g4-server', port: h.port, password: 'pw-g4', group: '삭제될그룹' })
  await openConnTab(page)
  await page.locator('.tree .srv-group:has(.srv-hd:has-text("삭제될그룹")) > .srv-hd').click({ button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="group.delete"]')
  await expect(dialog(page)).toContainText('그룹 삭제')
  await expect(dialog(page)).toHaveClass(/danger/)
  await dialogConfirm(page)
  await expect
    .poll(async () => (await groupHeaders(page)).join('|'), { timeout: 20_000 })
    .not.toContain('삭제될그룹')
  await expect(page.locator('.tree .srv-group:has(.srv-hd:has-text("기타")) .srv-node .sname')).toHaveText('g4-server')
})

// GROUP-5 그룹 헤더 클릭으로 접고 펼친다
test('GROUP-5 그룹을 접으면 하위 연결이 숨는다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-g5' })
  await connectNewSshProfile(page, { name: 'g5-server', port: h.port, password: 'pw-g5', group: '접기' })
  await openConnTab(page)
  const header = page.locator('.tree .srv-group:has(.srv-hd:has-text("접기")) > .srv-hd')
  await expect(page.locator('.tree .srv-node')).toHaveCount(1)
  await header.click()
  await expect(page.locator('.tree .srv-node')).toHaveCount(0)
  await expect(header.locator('.caret')).toHaveText('▸')
  await header.click()
  await expect(page.locator('.tree .srv-node')).toHaveCount(1)
})

// GROUP-6 트리 검색 — 이름·호스트·그룹으로 거르고, 결과 없으면 안내
test('GROUP-6 트리 검색이 이름·그룹으로 목록을 거른다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({ password: 'pw-g6' })
  await connectNewSshProfile(page, { name: '서울-웹', port: h.port, password: 'pw-g6', group: '운영' })
  await openConnTab(page)
  // 두 번째 프로필. 같은 호스트라 지문은 이미 신뢰돼 있어 확인 다이얼로그 없이 곧바로 접속된다.
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await fillNewProfile(page, { name: '부산-DB', port: h.port, password: 'pw-g6', group: '개발' })
  await page.click('.modal-ft .btn.pri')
  await expect(connModal(page)).toHaveCount(0, { timeout: 30_000 })
  await openConnTab(page)
  await expect(page.locator('.tree .srv-node')).toHaveCount(2, { timeout: 25_000 })

  const search = page.locator('.sidebar .sb-search input')
  await search.fill('부산')
  await expect(page.locator('.tree .srv-node .sname')).toHaveText('부산-DB')
  await search.fill('운영')
  await expect(page.locator('.tree .srv-node .sname')).toHaveText('서울-웹')
  await search.fill('없는이름zzz')
  await expect(page.locator('.tree .empty')).toHaveText('검색 결과가 없습니다')
  await search.press('Escape')
  await expect(page.locator('.tree .srv-node')).toHaveCount(2)
})
