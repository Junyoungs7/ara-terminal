// W1 F10 상태바 리소스 게이지 — 활성 SSH 세션의 CPU/MEM(/GPU).
// 값의 출처는 F9 와 같은 폴링 한 벌이다(원격 응답은 ssh2 루프백 하네스의 exec 채널).
import type { Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, makeTelemetry, newLocalShell, openBottomTool, portRows, type TeleHarness } from './fixtures'

type SshFactory = (opts?: { password?: string; execHandler?: TeleHarness['exec'] }) => Promise<{ port: number }>

const gauges = (page: Page) => page.locator('.statusbar .sb-seg.gauge-seg')
const gauge = (page: Page, key: 'CPU' | 'MEM' | 'GPU') =>
  page.locator(`.statusbar .sb-seg.gauge-seg:has(.lbl:text-is("${key}"))`)

async function connectWithTelemetry(page: Page, ssh: SshFactory, tele: TeleHarness, name: string): Promise<string> {
  const pw = `pw-${name}`
  const h = await ssh({ password: pw, execHandler: tele.exec })
  return connectNewSshProfile(page, { name, port: h.port, password: pw })
}

// GAUGE-1 SSH 세션이면 상태바에 CPU·MEM·GPU 세 칸이 생긴다
test('GAUGE-1 SSH 세션 상태바에 CPU·MEM·GPU 게이지가 뜬다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'g1')
  await expect(gauges(ara.page)).toHaveCount(3, { timeout: 30_000 })
  expect(await gauges(ara.page).locator('.lbl').allTextContents()).toEqual(['CPU', 'MEM', 'GPU'])
  // 2.0: 칸은 세션이 생기자마자 — 로 서므로, 값은 첫 폴링을 기다린다.
  await expect(gauge(ara.page, 'GPU').locator('.val')).toHaveText('61%', { timeout: 30_000 })
})

// GAUGE-2 CPU 는 **꺾은선**이다 — 2026-08-17(제보 ③)에 채움 막대를 걷고 시계열 그래프로 바꿨다.
// "지금 몇 %인가"는 옆 숫자가 말하고, 그래프는 **어디로 가는 중인가**를 말한다. 폭 대신 그것을 본다.
// (2026-08-22 제보 18번: 선 아래를 면으로 채웠다 — 그 면도 함께 그려지는지 여기서 지킨다.)
// 2.0 2단계(시안 Z-final): 그래프는 CPU 만 남고 MEM·GPU 는 막대(.sb-mbar)로 돌아갔다 — 막대 폭이 값을 탄다.
test('GAUGE-2 CPU 는 면 있는 시계열 그래프, MEM·GPU 는 값만큼 찬 막대', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'g2')
  await expect(gauge(ara.page, 'GPU').locator('.val')).toHaveText('61%', { timeout: 30_000 })

  const spark = gauge(ara.page, 'CPU').locator('svg.sb-spark')
  await expect(spark).toHaveCount(1)
  // 점이 실려 있어야 선이다(빈 문자열이면 화면엔 아무것도 없다).
  await expect.poll(async () => (await spark.locator('polyline').getAttribute('points'))?.length ?? 0).toBeGreaterThan(3)
  await expect.poll(async () => (await spark.locator('polygon').getAttribute('points'))?.length ?? 0).toBeGreaterThan(3)

  for (const key of ['MEM', 'GPU'] as const) {
    const fill = gauge(ara.page, key).locator('.sb-mbar i')
    await expect(fill).toHaveCount(1)
    await expect.poll(async () => parseFloat((await fill.getAttribute('style'))?.match(/width:\s*([\d.]+)%/)?.[1] ?? '0')).toBeGreaterThan(0)
  }
})

// GAUGE-3 CPU 는 두 샘플의 차이 — 첫 바퀴는 0%, 부하가 생기면 실값
test('GAUGE-3 CPU 는 첫 바퀴 0% 이고 다음 바퀴부터 실값이다', async ({ ara, ssh }) => {
  // load=0 = 완전히 놀고 있는 서버(누적치가 안 는다) → 몇 바퀴를 돌아도 0%.
  const tele = makeTelemetry({ load: 0 })
  await connectWithTelemetry(ara.page, ssh, tele, 'g3')
  await expect(gauge(ara.page, 'CPU').locator('.val')).toHaveText('0%', { timeout: 30_000 })
  const roundsAtZero = tele.rounds()
  expect(roundsAtZero).toBeGreaterThan(0)

  // 이제 서버에 부하가 걸린다 — 증분 500/1450 = 34%.
  tele.state.load = 1
  await expect(gauge(ara.page, 'CPU').locator('.val')).toHaveText('34%', { timeout: 20_000 })
})

// GAUGE-4 메모리는 GiB 소수 1자리 사용/총량
test('GAUGE-4 메모리를 11.8/31.3G 형태로 보여 준다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'g4')
  await expect(gauge(ara.page, 'MEM').locator('.val')).toHaveText(/^\d+\.\d\/\d+\.\dG$/, { timeout: 30_000 })
  await expect(gauge(ara.page, 'MEM').locator('.val')).toHaveText('11.8/31.3G')
})

// GAUGE-5 nvidia-smi 가 없는 서버는 GPU 를 0% 로 표시하지 않는다.
// 2.0 2단계: 칸은 늘 같은 자리에 서고(폭 고정) 값이 없으면 `—`(.val.na) — 칸을 빼던 1.x 와 다르다.
test('GAUGE-5 GPU 가 없는 서버는 GPU 칸에 — 만 찍는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ gpu: null })
  await connectWithTelemetry(ara.page, ssh, tele, 'g5')
  await expect(gauge(ara.page, 'MEM').locator('.val')).toHaveText('11.8/31.3G', { timeout: 30_000 })
  expect(await gauges(ara.page).locator('.lbl').allTextContents()).toEqual(['CPU', 'MEM', 'GPU'])
  await expect(gauge(ara.page, 'GPU').locator('.val.na')).toHaveText('—')
})

// GAUGE-6 FB-0008: 로컬 셸에도 CPU/MEM 게이지가 뜬다(GPU 는 무의존 조회 방법이 없어 — , 2.0 칸 고정)
test('GAUGE-6 로컬 세션에도 CPU·MEM 게이지가 뜬다(GPU 는 —)', async ({ ara }) => {
  await newLocalShell(ara.page)
  await expect(gauges(ara.page)).toHaveCount(3, { timeout: 5_000 })
  expect(await gauges(ara.page).locator('.lbl').allTextContents()).toEqual(['CPU', 'MEM', 'GPU'])
  await expect(gauge(ara.page, 'GPU').locator('.val.na')).toHaveText('—')
  // 실머신 값이라 정확한 수치는 알 수 없다 — 형식만 확인한다(원격 게이지와 동일 표시 형식).
  await expect(gauge(ara.page, 'CPU').locator('.val')).toHaveText(/^\d{1,3}%$/, { timeout: 30_000 })
  await expect(gauge(ara.page, 'MEM').locator('.val')).toHaveText(/^\d+\.\d\/\d+\.\dG$/, { timeout: 30_000 })
})

// GAUGE-7 /proc 이 없는 서버(비리눅스)는 게이지 값만 비고(2.0: 칸은 서고 — ) 포트 목록은 그대로다
test('GAUGE-7 /proc 이 없어도 포트 목록은 살아 있다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ proc: false })
  await connectWithTelemetry(ara.page, ssh, tele, 'g7')
  await openBottomTool(ara.page, 'monitor')
  // 22 는 tcp·tcp6 가 한 행으로 합쳐져 다섯 줄이다(mergeProtos).
  await expect(portRows(ara.page)).toHaveCount(5, { timeout: 30_000 })
  // CPU·MEM 은 /proc 에서 온다 — 값 없이 — . (GPU 는 nvidia-smi 출처라 여기서 단언하지 않는다.)
  await expect(gauge(ara.page, 'CPU').locator('.val.na')).toHaveText('—')
  await expect(gauge(ara.page, 'MEM').locator('.val.na')).toHaveText('—')
})
