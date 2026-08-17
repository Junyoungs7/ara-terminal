// W1 F10 상태바 리소스 게이지 — 활성 SSH 세션의 CPU/MEM(/GPU).
// 값의 출처는 F9 와 같은 폴링 한 벌이다(원격 응답은 ssh2 루프백 하네스의 exec 채널).
import type { Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, makeTelemetry, newLocalShell, openBottomTool, portRows, showAllPorts, type TeleHarness } from './fixtures'

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
  await expect(gauge(ara.page, 'GPU').locator('.val')).toHaveText('61%')
})

// GAUGE-2 막대 채움 폭(%)이 표시된 값과 같다
test('GAUGE-2 막대 채움 폭이 표시 값과 일치한다', async ({ ara, ssh }) => {
  const tele = makeTelemetry()
  await connectWithTelemetry(ara.page, ssh, tele, 'g2')
  await expect(gauge(ara.page, 'GPU').locator('.val')).toHaveText('61%', { timeout: 30_000 })
  const fill = (key: 'CPU' | 'MEM' | 'GPU') =>
    gauge(ara.page, key)
      .locator('.bar i')
      .evaluate((el) => (el as HTMLElement).style.width)
  expect(await fill('GPU')).toBe('61%')
  // MEM 은 사용/총량 표기라 퍼센트는 막대에만 있다(12388156/32869180 → 38%).
  expect(await fill('MEM')).toBe('38%')
  // CPU 는 표시 값과 채움 폭이 같은 수여야 한다.
  expect(await fill('CPU')).toBe((await gauge(ara.page, 'CPU').locator('.val').textContent()) ?? '')
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

// GAUGE-5 nvidia-smi 가 없는 서버는 GPU 칸 자체가 없다(0% 로 표시하지 않는다)
test('GAUGE-5 GPU 가 없는 서버는 GPU 칸을 만들지 않는다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ gpu: null })
  await connectWithTelemetry(ara.page, ssh, tele, 'g5')
  await expect(gauges(ara.page)).toHaveCount(2, { timeout: 30_000 })
  expect(await gauges(ara.page).locator('.lbl').allTextContents()).toEqual(['CPU', 'MEM'])
})

// GAUGE-6 FB-0008: 로컬 셸에도 CPU/MEM 게이지가 뜬다(GPU 는 무의존 조회 방법이 없어 생략)
test('GAUGE-6 로컬 세션에도 CPU·MEM 게이지가 뜬다(GPU 는 없다)', async ({ ara }) => {
  await newLocalShell(ara.page)
  await expect(gauges(ara.page)).toHaveCount(2, { timeout: 5_000 })
  expect(await gauges(ara.page).locator('.lbl').allTextContents()).toEqual(['CPU', 'MEM'])
  // 실머신 값이라 정확한 수치는 알 수 없다 — 형식만 확인한다(원격 게이지와 동일 표시 형식).
  await expect(gauge(ara.page, 'CPU').locator('.val')).toHaveText(/^\d{1,3}%$/)
  await expect(gauge(ara.page, 'MEM').locator('.val')).toHaveText(/^\d+\.\d\/\d+\.\dG$/)
})

// GAUGE-7 /proc 이 없는 서버(비리눅스)는 게이지만 빠지고 포트 목록은 그대로다
test('GAUGE-7 /proc 이 없어도 포트 목록은 살아 있다', async ({ ara, ssh }) => {
  const tele = makeTelemetry({ proc: false })
  await connectWithTelemetry(ara.page, ssh, tele, 'g7')
  await openBottomTool(ara.page, 'monitor')
  // FB-monitor(FB-0003): 기본값이 "사용자 포트만" — 6개 전체를 보려면 명시적으로 전체 보기.
  await showAllPorts(ara.page)
  await expect(portRows(ara.page)).toHaveCount(6, { timeout: 30_000 })
  await expect(gauges(ara.page)).toHaveCount(0)
})
