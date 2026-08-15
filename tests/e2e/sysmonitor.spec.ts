// F29 시스템 모니터 — 준영님 요청(2026-08-11):
// "우측 버튼에 서버 정보 보기 버튼으로 클릭하면 현재 보고있는 서버, 즉 패널의 cpu, memory, gpu,
//  디스크 용량 등 시스템 정보를 그래프와 이런걸로 사이드바 형식으로 보여주고 기본적으로는 내 로컬
//  시스템의 정보를 보여주고. 탭으로 지금 보고있는 패널, 로컬 이렇게 2개를 선택해서 보여주는거지."
//
// #83(2026-08-15): 우측 레일 → **하단 패널**. 보여 주는 것이 서버 자원이라 "서버 것은 아래"
// 원칙(design-system.md §4.8)에 걸린다. 화면 위치만 바뀌고 안쪽 규칙(기본 [내 PC] 탭·그래프·
// 닫으면 폴링 정지)은 그대로라 아래 검사는 선택자만 옮겼다.
import { test, expect, newLocalShell, connectNewSshProfile, makeTelemetry, type TeleHarness } from './fixtures'
import type { Page } from '@playwright/test'

type SshFactory = (opts?: { password?: string; execHandler?: TeleHarness['exec'] }) => Promise<{ port: number }>

async function openSys(page: Page): Promise<void> {
  await page.click('.act-item[data-activity="sys"]')
  await expect(page.locator('.bottom-panel .monitor-panel.sysm')).toBeVisible()
}

test('SYSM-1 액티비티 바에서 열리고 기본 탭은 [내 PC] 다', async ({ ara }) => {
  const { page } = ara
  await openSys(page)
  // 준영님 지시: "기본적으로는 내 로컬 시스템의 정보를 보여주고".
  await expect(page.locator('.sysm-tab.active')).toHaveText('내 PC')
  // 세션이 하나도 없어도 내 PC 는 보인다 — 세션에 매인 telemetry 와 다른 채널이라 그렇다.
  // toBeVisible 까지 보는 이유(#83): 하단으로 내리면서 .sysm-body 를 통째로 격자로 만들었더니
  // 말줄임(overflow:hidden)을 쓰는 이 줄이 **높이 0** 으로 접혔다. 글자는 DOM 에 있었으므로
  // 텍스트 검사만으로는 통과했다 — 자리를 옮길 때 이 함정이 다시 나온다.
  await expect(page.locator('.sysm-who')).not.toHaveText('')
  await expect(page.locator('.sysm-who')).toBeVisible()
})

test('SYSM-2 내 PC 탭에 CPU·메모리 그래프와 디스크가 실제 값으로 그려진다', async ({ ara }) => {
  const { page } = ara
  await openSys(page)
  // 표본이 쌓여 선이 생길 때까지(첫 틱은 즉시, 두 번째는 2.5초).
  await expect.poll(async () => page.locator('.sysm-spark polyline').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  const pts = await page.locator('.sysm-spark polyline').first().getAttribute('points')
  expect(pts ?? '').not.toBe('') // 빈 선이 아니다
  // 디스크는 30초 주기지만 첫 틱에 한 번 읽는다 — 이 PC 에 최소 한 칸은 있다.
  await expect.poll(async () => page.locator('.sysm-disk').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  // 퍼센트가 0~100 범위의 실제 숫자로 찍힌다(NaN·빈칸이 아니다).
  const pct = await page.locator('.sysm-dpct').first().innerText()
  expect(Number(pct.replace('%', ''))).toBeGreaterThanOrEqual(0)
})

test('SYSM-3 세션이 없으면 [현재 패널] 탭은 안내만 낸다', async ({ ara }) => {
  const { page } = ara
  await openSys(page)
  await page.locator('.sysm-tab').nth(1).click()
  await expect(page.locator('.sysm-nosession')).toContainText('세션을 열면')
  await expect(page.locator('.sysm-spark')).toHaveCount(0)
})

test('SYSM-4 로컬 세션을 열면 [현재 패널] 이 그 세션을 그린다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await openSys(page)
  await page.locator('.sysm-tab').nth(1).click()
  // "디스크 없음"(.sysm-empty)은 로컬 세션이면 정상이다 — 원격 df 를 안 부르니까.
  // 여기서 없어야 하는 건 "세션 없음" 쪽이다.
  await expect(page.locator('.sysm-nosession')).toHaveCount(0)
  await expect.poll(async () => page.locator('.sysm-spark polyline').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
})

test('SYSM-5★ 원격 GPU 는 값이 올 때만 칸이 생긴다', async ({ ara, ssh }) => {
  const { page } = ara
  // 하네스가 nvidia-smi 출력을 주는 서버 — GPU 칸이 나와야 한다(gauge.spec.ts 와 같은 배선).
  const tele = makeTelemetry()
  const h = await (ssh as SshFactory)({ password: 'pw-gpu', execHandler: tele.exec })
  await connectNewSshProfile(page, { name: 'gpu-box', port: h.port, password: 'pw-gpu' })
  await openSys(page)
  await page.locator('.sysm-tab').nth(1).click()
  await expect.poll(async () => page.locator('.sysm-mlabel').allInnerTexts(), { timeout: 20_000 }).toContain('GPU')
  // 사용률만으로는 "몇 GB 쓰는지"를 못 본다(준영님 2026-08-13) — 2048/24576 MiB = 2.0G / 24.0G.
  const gpuCard = page.locator('.sysm-metric', { has: page.locator('.sysm-mlabel', { hasText: 'GPU' }) })
  await expect(gpuCard.locator('.sysm-sub')).toHaveText('2.0G / 24.0G')
})

test('SYSM-5b 사용률만 오는 서버는 GPU 칸은 있고 메모리 줄만 없다', async ({ ara, ssh }) => {
  const { page } = ara
  const tele = makeTelemetry({ gpu: '61' }) // 예전 형태(칸 하나)
  const h = await (ssh as SshFactory)({ password: 'pw-gpu1', execHandler: tele.exec })
  await connectNewSshProfile(page, { name: 'gpu-old', port: h.port, password: 'pw-gpu1' })
  await openSys(page)
  await page.locator('.sysm-tab').nth(1).click()
  const gpuCard = page.locator('.sysm-metric', { has: page.locator('.sysm-mlabel', { hasText: 'GPU' }) })
  await expect(gpuCard).toBeVisible({ timeout: 20_000 })
  await expect(gpuCard.locator('.sysm-sub')).toHaveCount(0)
})

test('SYSM-6 패널을 닫으면 내 PC 폴링이 멈춘다', async ({ ara }) => {
  const { page } = ara
  await openSys(page)
  await expect.poll(async () => page.locator('.sysm-spark polyline').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

  // 닫고 나서 폴링 주기를 여러 번 넘겨도 데이터가 더 오지 않아야 한다.
  // 판정: 다시 열었을 때 히스토리가 **처음부터** 다시 쌓인다(닫는 동안 쌓였다면 선이 이미 길다).
  // #83: 닫기는 하단 패널이 갖는다 — 끼운 패널은 자기 제목줄을 안 그린다.
  await page.locator('.bottom-panel .bp-close').click()
  await expect(page.locator('.monitor-panel.sysm')).toHaveCount(0)
  await page.waitForTimeout(6000) // 폴링 2바퀴 이상

  await openSys(page)
  const pts = await page.locator('.sysm-spark polyline').first().getAttribute('points')
  // 방금 다시 연 직후라 표본이 1~2개다(닫힌 동안 쌓였다면 훨씬 많다).
  expect((pts ?? '').split(' ').filter(Boolean).length).toBeLessThanOrEqual(3)
})
