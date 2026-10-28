// F31 통합 검색(커맨드 팔레트) — 준영님 요청(2026-08-13):
// "vscode처럼 상단에 통합 검색 버튼 제공하여 거기서 바로 킬 수 있도록, 프로필도 거기서 켜거나…"
//
// 이 파일이 지키는 성질:
//  · 진입점 둘(타이틀바 돋보기 · F1)이 같은 창을 연다.
//  · 목록은 **기존 표에서** 나온다 — 새로 만든 목록이 아니라 KEYMAP·MENUBAR·저장된 프로필이다.
//  · Enter 가 실제로 그 기능을 실행한다(팔레트가 그냥 목록만 보여 주는 장식이 아니다).
//  · 저장해 둔 서버를 골라 **접속까지** 간다 — 준영님이 콕 집은 부분이다.
import type { Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, newLocalShell } from './fixtures'

// 검색칸은 타이틀바에 **박혀 있고**(늘 보인다), 누르면 가운데 창이 뜬다 — 여닫힘 판정은 창 쪽.
// 2.0 다듬기 R1: 타이핑은 가운데 창(시안 Z-palette)의 입력칸에서 한다.
const palette = (page: Page) => page.locator('.cp-drop')
const field = (page: Page) => page.locator('.cp-drop input[data-field="palette"]')
const items = (page: Page) => page.locator('.cp-item')

// PAL-1 진입점 ① 타이틀바 검색창 — 단축키를 모르는 사람이 들어오는 길이다.
// 검색창 자체는 **늘 떠 있다**(창을 여는 버튼이 아니다 — 2026-08-13 준영님 재요청).
test('PAL-1 타이틀바 검색칸은 상시 보이고, 누르면 가운데 640px 창이 뜬다', async ({ ara }) => {
  await expect(ara.page.locator('.titlebar .tb-omni')).toBeVisible()
  await expect(palette(ara.page)).toHaveCount(0) // 누르기 전에는 창이 없다
  await ara.page.click('.titlebar .tb-omni')
  await expect(field(ara.page)).toBeFocused()
  await expect(palette(ara.page)).toBeVisible()
  await expect(ara.page.locator('.cp-scrim')).toBeVisible() // 뒤 살짝 어둡게
  // 창은 화면 **가운데**, 폭 640(시안 Z-palette). 검색칸 아래.
  const vw = await ara.page.evaluate(() => window.innerWidth)
  const box = (await ara.page.locator('.titlebar .tb-omni').boundingBox())!
  const drop = (await palette(ara.page).boundingBox())!
  expect(Math.abs(drop.x + drop.width / 2 - vw / 2)).toBeLessThan(2)
  expect(Math.abs(drop.width - Math.min(640, vw - 32))).toBeLessThan(2)
  expect(drop.y).toBeGreaterThan(box.y + box.height - 1)

  await ara.page.keyboard.press('Escape')
  await expect(palette(ara.page)).toHaveCount(0)
  await expect(ara.page.locator('.titlebar .tb-omni')).toBeVisible() // 칸은 그대로 남는다
})

// PAL-2 진입점 ② F1(VS Code 의 Show All Commands 와 같은 키).
test('PAL-2 F1 로 검색창에 바로 커서가 가고 다시 누르면 닫힌다', async ({ ara }) => {
  await ara.page.keyboard.press('F1')
  await expect(field(ara.page)).toBeFocused()
  await expect(palette(ara.page)).toBeVisible()
  await ara.page.keyboard.press('F1')
  await expect(palette(ara.page)).toHaveCount(0)
})

// PAL-2b 검색어는 닫을 때 버린다 — 다음에 열었을 때 지난 검색어가 남아 있으면 목록이 비어 보인다.
test('PAL-2b 닫았다 열면 검색어가 비어 있다', async ({ ara }) => {
  await ara.page.keyboard.press('F1')
  await field(ara.page).fill('치트')
  await ara.page.keyboard.press('Escape')
  await ara.page.keyboard.press('F1')
  await expect(field(ara.page)).toHaveValue('')
})

// PAL-3★ 목록이 **기존 표**에서 나온다. 팔레트 전용 목록을 따로 들면 기능이 늘 때 여기만 비게 된다.
test('PAL-3★ 단축키 있는 기능·메뉴 명령·저장한 서버가 한 목록에 함께 나온다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-pal3' })
  await connectNewSshProfile(ara.page, { name: 'pal3-서버', port: h.port, password: 'pw-pal3' })
  await ara.page.keyboard.press('F1')
  await expect(palette(ara.page)).toBeVisible()
  // 빈 검색어는 묶음(열린 창·최근 서버·숨긴 기능)만 보인다 — 표 전체는 치면 나온다(2.0 다듬기 R1).

  // KEYMAP 에서 온 항목(단축키 칩이 함께 붙는다 — 키 사이 공백).
  await field(ara.page).fill('session.new')
  const newSession = ara.page.locator('.cp-item[data-item="action:session.new"]')
  await expect(newSession).toBeVisible()
  await expect(newSession.locator('.cp-key')).toHaveText('Ctrl Shift T')
  // MENUBAR 의 단축키 없는 명령.
  await field(ara.page).fill('help.about')
  await expect(ara.page.locator('.cp-item[data-item="command:help.about"]')).toBeVisible()
  // 저장된 서버.
  await field(ara.page).fill('pal3')
  await expect(ara.page.locator('.cp-item', { hasText: 'pal3-서버' })).toBeVisible()
})

// PAL-4 검색은 라벨과 영문 별칭 양쪽에 걸린다.
test('PAL-4 이름 일부만 쳐도 좁혀진다', async ({ ara }) => {
  await ara.page.keyboard.press('F1')
  const all = await items(ara.page).count()
  // 치트시트는 **한 줄만** 나와야 한다 — KEYMAP·MENUBAR 양쪽에 있던 중복을 걷어냈다.
  await field(ara.page).fill('치트')
  await expect(items(ara.page)).toHaveCount(1)
  await expect(ara.page.locator('.cp-item[data-item="action:cheatsheet"]')).toBeVisible()

  // 영문(액션 id)으로도 같은 것을 찾는다.
  await field(ara.page).fill('cheatsheet')
  await expect(ara.page.locator('.cp-item[data-item="action:cheatsheet"]')).toBeVisible()

  await field(ara.page).fill('')
  await expect(items(ara.page)).toHaveCount(all)
  await field(ara.page).fill('없는기능이름')
  await expect(ara.page.locator('.cp-empty')).toBeVisible()
})

// PAL-5★ Enter 가 진짜로 실행한다. 팔레트 전용 배선이 아니라 원래 명령 경로로 나가는지를 본다.
test('PAL-5★ 찾아서 Enter 하면 그 기능이 실행된다', async ({ ara }) => {
  await ara.page.keyboard.press('F1')
  await field(ara.page).fill('치트')
  await ara.page.keyboard.press('Enter')
  // 팔레트는 닫히고 치트시트가 뜬다.
  await expect(palette(ara.page)).toHaveCount(0)
  await expect(ara.page.locator('.cheatsheet')).toBeVisible()
})

// PAL-6★ 저장해 둔 서버를 골라 접속까지 — 준영님이 콕 집은 "프로필도 거기서 켜거나".
test('PAL-6★ 팔레트에서 서버를 고르면 그 서버로 접속한다', async ({ ara, ssh }) => {
  const h = await ssh({ password: 'pw-pal6' })
  await connectNewSshProfile(ara.page, { name: 'pal6-서버', port: h.port, password: 'pw-pal6' })
  const before = await ara.page.locator('.term-tabbar .ttab').count()

  await ara.page.keyboard.press('F1')
  await field(ara.page).fill('pal6')
  await ara.page.locator('.cp-item', { hasText: 'pal6-서버' }).first().click()
  // 같은 프로필로 세션이 하나 더 뜬다(팔레트가 실제 connectProfile 경로를 탄다).
  await expect(ara.page.locator('.term-tabbar .ttab')).toHaveCount(before + 1, { timeout: 30_000 })
})

// PAL-7 ↑↓ 로 고른다 — 마우스 없이 끝까지 갈 수 있어야 팔레트다.
test('PAL-7 화살표로 커서가 움직이고 목록 끝에서 감아 돈다', async ({ ara }) => {
  await ara.page.keyboard.press('F1')
  await expect(items(ara.page).first()).toHaveClass(/on/)
  await ara.page.keyboard.press('ArrowDown')
  await expect(items(ara.page).nth(1)).toHaveClass(/on/)
  // 위로 두 번 = 처음을 지나 맨 끝으로.
  await ara.page.keyboard.press('ArrowUp')
  await ara.page.keyboard.press('ArrowUp')
  await expect(items(ara.page).last()).toHaveClass(/on/)
})

// PAL-8 빈 검색어 = 열린 창 / 최근 서버 / 숨긴 기능(2.0 다듬기 R1 — 긴 단축키 목록 대신).
test('PAL-8 빈 검색어는 열린 창과 숨긴 기능을 묶어 보이고, 탭을 고르면 그 탭으로 간다', async ({ ara }) => {
  await newLocalShell(ara.page)
  await ara.page.keyboard.press('F1')
  const groups = await ara.page.locator('.cp-group').allTextContents()
  expect(groups[0]).toBe('열린 창')
  expect(groups).toContain('숨긴 기능')
  const tab = ara.page.locator('.cp-item[data-item^="session:"]').first()
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(palette(ara.page)).toHaveCount(0)
})
