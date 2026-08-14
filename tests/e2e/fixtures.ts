// T1 공통 픽스처 — 앱 기동/종료 · 임시 userData · SSH(ssh2) 하네스 · 터미널 조회 헬퍼.
// 모든 spec 이 이 파일 하나만 import 한다(테스트별 기동 코드 중복 금지).
//
// 격리 원칙:
//  · userData 는 테스트마다 새 임시 디렉토리(--user-data-dir) — 실사용 workspace.json/vault 를 건드리지 않는다.
//  · SSH 는 기존 tests/ssh-harness.ts(ssh2 인메모리 서버)를 재사용한다 — 외부 서버 접속 금지(DLP).
//  · 파일 전송은 임시 디렉토리 ↔ 루프백 하네스로만 한다.
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerChannel } from 'ssh2'
import { startPasswordServer, type Harness } from '../ssh-harness'

export const REPO_ROOT = resolve(__dirname, '..', '..')
const MAIN_JS = join(REPO_ROOT, 'out', 'main', 'index.js')

// __evTerm/__evPersist 는 앱이 노출하는 E2E seam(프로덕션에도 존재하나 앱은 호출하지 않는다).
type TermProbe = {
  scrollback?: number
  cursorStyle?: string
  cursorBlink?: boolean
  windowsMode?: boolean
  unicode: string
  theme?: Record<string, string>
  selectAll: () => void
  getSelection: () => string
  text: () => string
}
declare global {
  interface Window {
    __evTerm: (sessionId: string) => TermProbe | null
    __evPersist?: () => Promise<void>
  }
}

export type Ara = {
  app: ElectronApplication
  page: Page
  userData: string
}

export function tempDir(prefix = 'ara-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function rmDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Windows 에서 pty 가 아직 잡고 있으면 실패할 수 있다 — 임시 디렉토리라 남아도 무해하다.
  }
}

// 실 main(out/main/index.js)을 임시 userData 로 기동. GPU 는 끈다(CI/원격 데스크톱에서
// SwiftShader 로 떨어지면 WebGL 렌더러가 오히려 불안정 — 앱이 DOM 렌더러로 폴백한다).
export async function launchAra(userData: string): Promise<Ara> {
  const app = await electron.launch({
    args: [MAIN_JS, `--user-data-dir=${userData}`, '--disable-gpu'],
    cwd: REPO_ROOT,
    timeout: 60_000,
    // W3 F16: ARA_AI_FAKE=1 이 있으면 AraSession 이 실 Anthropic SDK 대신 캔드 스트림을 쓴다
    // (isFakeAi()). 항상 켜 둔다 — AI 를 건드리지 않는 나머지 테스트에는 영향이 없고, 아라
    // 시나리오가 실키·네트워크 없이 돈다(DLP).
    // ARA_E2E: 창을 showInactive() 로 띄워 사용자 화면에서 포커스를 뺏지 않는다(main/index.ts).
    env: { ...process.env, ARA_AI_FAKE: '1', ARA_E2E: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 30_000 })
  // 부트 복원이 끝나 화면이 확정될 때까지(빈 상태는 안내 없이 .pane-grid 만 남으므로 그 자체로 충분 — UI-tabbar).
  await page.waitForSelector('.pane-grid', { timeout: 40_000 })
  return { app, page, userData }
}

// 종료 직전 최신 스냅샷 저장을 강제한다. 렌더러 persist 는 workspace:save(30s 디바운스)까지만 가고
// 실제 디스크 기록은 before-quit 의 flush 다 — 복원 시나리오는 이 순서를 지켜야 저장이 확정된다.
export async function persist(page: Page): Promise<void> {
  await page.evaluate(() => window.__evPersist?.()).catch(() => {})
  await page.waitForTimeout(300)
}

// 정상 종료(app.quit → before-quit → workspace.json flush + pty 정리).
export async function quitAra(a: Ara): Promise<void> {
  const closed = a.app.waitForEvent('close').catch(() => {})
  // quit() 은 프로세스를 내리므로 evaluate 응답이 오지 않는다 — 다음 tick 으로 미뤄 호출만 하고 빠진다.
  await a.app.evaluate(({ app }) => void setTimeout(() => app.quit(), 0)).catch(() => {})
  await Promise.race([closed, new Promise((r) => setTimeout(r, 10_000))])
  await a.app.close().catch(() => {})
}

type SshFactory = (opts?: Parameters<typeof startPasswordServer>[0]) => Promise<Harness>

export type Launcher = (userData: string) => Promise<Ara>

export const test = base.extend<{
  userDataDir: string
  ara: Ara
  ssh: SshFactory
  launch: Launcher
  holdPort: (port: number) => Promise<number>
}>({
  // 앱을 손수 기동/재기동하는 테스트(복원 시나리오)는 이 픽스처만 쓴다.
  userDataDir: async ({}, use) => {
    const dir = tempDir()
    await use(dir)
    rmDir(dir)
  },
  // 대부분의 테스트: 깨끗한 앱 1회 기동 → 종료.
  // ssh 를 (쓰지 않더라도) 의존으로 잡는다: Playwright 는 셋업 역순으로 해체하므로 ssh 가 먼저
  // 생성돼야 앱이 먼저 내려간다. 반대 순서면 앱이 붙잡고 있는 커넥션 때문에 server.close() 가 영영
  // 끝나지 않는다(실측: teardown 에서 120s 타임아웃).
  ara: async ({ userDataDir, ssh: _ssh }, use) => {
    const a = await launchAra(userDataDir)
    await use(a)
    await quitAra(a)
  },
  // 종료→재기동을 손수 하는 테스트(복원 시나리오)용. 실패로 중간에 빠져나가도 앱이 남지 않게 추적한다.
  // ara 와 같은 이유로 ssh 를 앞세운다(해체 역순 — 앱이 ssh 서버보다 먼저 내려가야 한다).
  launch: async ({ ssh: _ssh }, use) => {
    const started: Ara[] = []
    await use(async (userData: string) => {
      const a = await launchAra(userData)
      started.push(a)
      return a
    })
    for (const a of started) await quitAra(a).catch(() => {})
  },
  // ssh2 인메모리 서버 팩토리. 테스트가 만든 서버는 전부 자동 정리한다.
  ssh: async ({}, use) => {
    const created: Harness[] = []
    await use(async (opts) => {
      const h = await startPasswordServer(opts)
      created.push(h)
      return h
    })
    // 앱이 이미 내려갔어도 끊기지 않은 소켓이 남을 수 있다 — 워커를 붙잡지 않도록 상한을 둔다.
    for (const h of created) {
      await Promise.race([h.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))])
    }
  },
  // W2 F8: 테스트가 로컬 포트를 미리 점유한다(포워딩 폴백·OAuth 콜백 충돌). 0 을 주면 임의 포트를
  // 잡아 그 번호를 돌려준다. 실패로 중간에 빠져나가도 반드시 돌려준다 — 남기면 다음 테스트가 막힌다.
  holdPort: async ({}, use) => {
    const held: Server[] = []
    await use(async (port: number) => {
      const s = createServer()
      await new Promise<void>((resolve_, reject) => {
        s.once('error', reject)
        s.listen(port, '127.0.0.1', resolve_)
      })
      held.push(s)
      return (s.address() as AddressInfo).port
    })
    for (const s of held) await new Promise<void>((r) => s.close(() => r()))
  }
})

export { expect }

// ── 세션 헬퍼 ──────────────────────────────────────────────────────────────

/**
 * 사이드바를 [연결] 탭으로 되돌린다. SSH 에 접속하면 앱이 자동으로 [파일] 탭으로 넘어가므로
 * (실사용 편의 — 접속 직후 하는 일이 대개 파일 보기다) 접속 뒤에 트리를 클릭하려면 먼저 돌아와야 한다.
 * 두 패널은 항상 렌더돼 있고 CSS 로만 감춰지므로, 이 단계를 빼면 "요소는 찾았는데 안 보인다"로 실패한다.
 */
export async function openConnTab(page: Page): Promise<void> {
  const tab = page.locator('button.sb-tab').filter({ hasText: '연결' })
  if (!(await tab.evaluate((el) => el.classList.contains('active')).catch(() => true))) await tab.click()
  await expect(page.locator('.sb-panel.active .tree')).toBeVisible({ timeout: 10_000 })
}

/**
 * 사이드바를 [파일] 탭으로 **맞춘다**. Ctrl+Shift+E 는 토글이라, SSH 접속 직후처럼 이미 파일 탭이
 * 열려 있으면 오히려 닫아 버린다(그래서 "요소는 찾았는데 안 보인다"로 죽는다). 상태를 보고 맞춘다.
 */
export async function openFileTab(page: Page): Promise<void> {
  const tab = page.locator('button.sb-tab').filter({ hasText: '파일' })
  const active = await tab.evaluate((el) => el.classList.contains('active')).catch(() => false)
  if (!active) await tab.click()
  await expect(page.locator('.sb-panel.active .sftp-wrap')).toBeVisible({ timeout: 10_000 })
}

export async function sessionList(page: Page) {
  return page.evaluate(() => window.ev.session.list())
}

export async function sessionIds(page: Page): Promise<string[]> {
  return (await sessionList(page)).map((s) => s.id)
}

// xterm 버퍼 텍스트(WebGL/DOM 렌더러 무관 — 화면 확인의 유일한 신뢰 경로).
export async function termText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((sid) => window.__evTerm(sid)?.text() ?? '', sessionId)
}

export async function sendInput(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(([sid, d]) => window.ev.session.input(sid, d), [sessionId, data])
}

// 셸 한 줄 실행(플랫폼 개행 차이 흡수).
export async function runCommand(page: Page, sessionId: string, cmd: string): Promise<void> {
  await sendInput(page, sessionId, cmd + (process.platform === 'win32' ? '\r' : '\n'))
}

export async function expectTermText(
  page: Page,
  sessionId: string,
  re: RegExp,
  timeout = 20_000
): Promise<void> {
  await expect
    .poll(async () => termText(page, sessionId), { timeout, intervals: [200, 300, 500] })
    .toMatch(re)
}

// 로컬 셸 하나를 탭바 ＋ 클릭으로 연다(실사용 경로 — 원클릭, UI-tabbar). 새로 생긴 세션 id 반환.
export async function newLocalShell(page: Page): Promise<string> {
  const before = await sessionIds(page)
  await page.click('.tterm-add')
  await expect.poll(async () => (await sessionIds(page)).length, { timeout: 20_000 }).toBe(before.length + 1)
  const id = (await sessionIds(page)).find((x) => !before.includes(x))
  if (!id) throw new Error('새 세션 id 를 찾지 못했다')
  // 프롬프트가 찍히기 전에는 입력이 유실될 수 있다 — 셸이 살아났는지 확인한다.
  await expect.poll(async () => (await termText(page, id)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  return id
}

// ── 연결 관리자(SSH) 헬퍼 ──────────────────────────────────────────────────

export type SshProfileForm = {
  name: string
  host?: string
  port: number
  username?: string
  password: string
  group?: string
}

// 라벨로 폼 입력칸을 찾는다(폼에 id/for 가 없다 — 라벨 텍스트가 유일한 안정 앵커).
export function field(page: Page, label: string) {
  return page.locator(`.prof-form .fld:has(> label:text-is("${label}")) input`).first()
}

// 연결 관리자에서 프로필을 새로 만들고 [저장 후 접속] 까지 누른다(TOFU 확인은 호출측 몫).
export async function fillNewProfile(page: Page, f: SshProfileForm): Promise<void> {
  await page.click('.modal .prof-list .pl-hd .kbd') // ＋ 새 프로필
  await field(page, '연결 이름').fill(f.name)
  await field(page, '호스트').fill(f.host ?? '127.0.0.1')
  await field(page, '포트').fill(String(f.port))
  await field(page, '사용자').fill(f.username ?? 'dev')
  if (f.group) await page.locator('.prof-form .fld:has(> label:text-is("그룹")) input').fill(f.group)
  await page.click('.prof-form .seg-ctl button:has-text("비밀번호")')
  await field(page, '비밀번호').fill(f.password)
}

export function connModal(page: Page) {
  return page.locator('.overlay.open:not(.dlg-overlay) .modal')
}

// 앱 공용 확인 다이얼로그(.dlg-overlay). 네이티브 confirm 은 쓰지 않는다.
export function dialog(page: Page) {
  return page.locator('.dlg-overlay .modal.sm')
}

export async function dialogConfirm(page: Page): Promise<void> {
  await dialog(page).locator('.modal-ft .btn.pri, .modal-ft .btn.dgr').click()
}

// 취소 = 아무 일도 일어나지 않아야 하는 쪽. 확인 다이얼로그의 값어치는 여기에 있다.
export async function dialogCancel(page: Page): Promise<void> {
  await dialog(page).locator('.modal-ft .btn.sec').last().click()
  await expect(dialog(page)).toHaveCount(0)
}

// 프로필 저장 → 접속 → (최초 접속이면) 호스트키 신뢰 → 세션 생성까지. 새 SSH 세션 id 반환.
// 터미널 패널에 포커스를 준다(단축키가 xterm 커스텀 키 핸들러를 거치려면 필요).
// 포커스가 helper textarea 로 옮겨간 뒤, xterm 이 파서 큐를 비울 때까지 잠깐 둔다:
// 그 사이에 xterm 이 셸의 DA 질의 응답(`ESC[?1;2c`)과 포커스 리포트(`ESC[I`)를 onData 로 흘리는데,
// 바로 타이핑을 시작하면 그 청크가 글자 사이에 끼어든다(F11 히스토리 수집이 여기서 깨진다 — 백로그 M-4).
export async function focusTerminal(page: Page): Promise<void> {
  await page.locator('.pane-grid .pane:visible .term-pane').first().click()
  await expect
    .poll(
      () => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false),
      { timeout: 10_000 }
    )
    .toBe(true)
  await page.waitForTimeout(700)
}

export async function connectNewSshProfile(page: Page, f: SshProfileForm): Promise<string> {
  const before = await sessionIds(page)
  await page.keyboard.press('Control+Shift+M')
  await connModal(page).waitFor()
  await fillNewProfile(page, f)
  await page.click('.modal-ft .btn.pri')
  // 최초 접속(TOFU): 지문 확인 다이얼로그 → 신뢰하고 연결.
  await dialog(page).waitFor({ timeout: 20_000 })
  await expect(dialog(page)).toContainText('처음 보는 호스트키')
  await dialogConfirm(page)
  await expect.poll(async () => (await sessionIds(page)).length, { timeout: 30_000 }).toBe(before.length + 1)
  const id = (await sessionIds(page)).find((x) => !before.includes(x))
  if (!id) throw new Error('SSH 세션 id 를 찾지 못했다')
  return id
}

// ── W1 원격 텔레메트리 · 로그 tail 하네스 ──────────────────────────────────
// 트랙 B 가 `tests/ssh-harness.ts` 에 넣은 execHandler 옵션 위에 올린 얇은 껍데기.
// 실서버 대신 ssh2 루프백 서버가 `ss`//proc/nvidia-smi 출력과 `tail -F` 스트림을 흉내 낸다.
// 테스트는 `state` 를 바꿔 서버 상태 변화를(포트 추가·GPU 없음·/proc 없음) 만들어 낸다.

// 실제 `ss -tlnp` 형식. 마지막 줄은 users:() 가 통째로 빠진 소켓(= 프로세스를 읽을 권한 없음).
export const SS_OUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=812,fd=3))
LISTEN 0      511        127.0.0.1:8080       0.0.0.0:*     users:(("node",pid=2451,fd=18))
LISTEN 0      128          0.0.0.0:5432       0.0.0.0:*     users:(("postgres",pid=1044,fd=6))
LISTEN 0      511          0.0.0.0:443        0.0.0.0:*     users:(("nginx",pid=1180,fd=8))
LISTEN 0      128             [::]:22            [::]:*     users:(("sshd",pid=812,fd=4))
LISTEN 0      70         127.0.0.1:33060      0.0.0.0:*
`

// ss 가 없는 서버의 netstat -tlnp 폴백 형식(마지막 줄은 리슨이 아니라 버려야 한다).
export const NETSTAT_OUT = `Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address     Foreign Address    State       PID/Program name
tcp        0      0 0.0.0.0:22        0.0.0.0:*          LISTEN      812/sshd
tcp        0      0 127.0.0.1:5432    0.0.0.0:*          LISTEN      -
tcp6       0      0 :::443            :::*               LISTEN      1180/nginx: master
tcp        0      0 10.0.0.5:22       10.0.0.9:51234     ESTABLISHED 3312/sshd
`

// tail 채널 하나 — 테스트가 줄을 밀어 넣고(write) 원격 정리 여부(closed)를 관측한다.
export type TailChannel = {
  command: string
  write: (line: string) => void
  writeErr: (line: string) => void
  closed: boolean
}

export type TeleHarness = {
  // 다음 바퀴부터 반영되는 서버 상태. load=0 이면 /proc/stat 누적치가 그대로라 CPU 가 계속 0% 다
  // (완전히 놀고 있는 서버) — "첫 바퀴 0% → 다음 바퀴 실값"을 타이밍에 기대지 않고 만들 수 있다.
  state: { ports: string; proc: boolean; gpu: string | null; load: number }
  // 수집 명령이 원격으로 나간 횟수(수동 새로고침이 폴링 주기를 앞당겼는지 판정).
  rounds: () => number
  tails: TailChannel[]
  exec: (command: string, stream: ServerChannel) => void
}

export function makeTelemetry(init?: Partial<TeleHarness['state']>): TeleHarness {
  // gpu 는 nvidia-smi 가 주는 줄 그대로: `사용률, 사용메모리MiB, 총메모리MiB`(nounits).
  const state = { ports: SS_OUT, proc: true, gpu: '61, 2048, 24576' as string | null, load: 1, ...init }
  const tails: TailChannel[] = []
  let rounds = 0
  // 바퀴마다 /proc/stat 누적치를 늘린다 — CPU 는 두 샘플의 차이라 값이 고정이면 늘 0% 다.
  // 증분 user 250 + system 250 + idle 900 + iowait 50 → 500/1450 = 34%.
  const cpu = { user: 120_000, system: 60_000, idle: 900_000, iowait: 20_000 }

  const exec = (command: string, stream: ServerChannel): void => {
    if (command.startsWith('tail ')) {
      const ch: TailChannel = {
        command,
        write: (line) => stream.write(line + '\r\n'),
        writeErr: (line) => stream.stderr.write(line + '\r\n'),
        closed: false
      }
      const done = (): void => {
        ch.closed = true
      }
      stream.on('finish', done)
      stream.on('close', done)
      tails.push(ch)
      return
    }
    rounds++
    cpu.user += 250 * state.load
    cpu.system += 250 * state.load
    cpu.idle += 900 * state.load
    cpu.iowait += 50 * state.load
    const stat = state.proc
      ? `cpu  ${cpu.user} 0 ${cpu.system} ${cpu.idle} ${cpu.iowait} 0 0 0 0 0\n` +
        'MemTotal:       32869180 kB\nMemFree:         2100340 kB\nMemAvailable:   20481024 kB\n'
      : ''
    stream.write(`${state.ports}__ARA_STAT__\n${stat}__ARA_GPU__\n${state.gpu ? state.gpu + '\n' : ''}`)
    stream.exit(0)
    stream.end()
  }

  return { state, rounds: () => rounds, tails, exec }
}

// 포트 목록이 그려질 때까지 기다렸다가 [모니터]를 연다(FB-ui2: 우측 액티비티 바로 이관).
export async function openMonitorTab(page: Page): Promise<void> {
  await page.click('.act-item[data-activity="monitor"]')
}

export function portRows(page: Page) {
  return page.locator('.pmon-list .prow')
}

// FB-monitor(FB-0003): 기본값이 "사용자 포트만"이라 <1024 시스템 포트를 숨긴다 — 원본 파싱 결과
// 전체를 보고 싶은 테스트(MON-1/2/4/8/10/11 등)는 이걸로 "전체 보기"로 바꾼 뒤 확인한다.
export async function showAllPorts(page: Page): Promise<void> {
  await page.click('.pmon-range button[data-value="all"]')
}

// ── W2 F8 포워딩 · 내장 브라우저 하네스 ────────────────────────────────────

// 원격 목적지는 ssh 하네스의 direct-tcpip 채널이 흉내 낸다(실서버 없음 — DLP). 들어온 요청에
// HTTP 200 을 돌려주므로 내장 브라우저가 **터널을 통해** 실제로 페이지를 그린다. `hits` 는
// 프로토콜 레벨 증거다: 원격 목적지가 정말 127.0.0.1:<remotePort> 였는지 여기서 확인한다.
export type TcpipHarness = {
  hits: { destIP: string; destPort: number }[]
  handler: (info: { destIP: string; destPort: number }, channel: ServerChannel) => void
}

export function makeTcpip(html = '<h1>터널 너머 원격 페이지 · 한글</h1>'): TcpipHarness {
  const hits: TcpipHarness['hits'] = []
  const handler = (info: { destIP: string; destPort: number }, ch: ServerChannel): void => {
    hits.push(info)
    let answered = false
    ch.on('data', () => {
      if (answered) return // keep-alive 로 여러 요청이 와도 한 번만 답한다(connection: close)
      answered = true
      const body = Buffer.from(html, 'utf8')
      ch.write(
        `HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\n` +
          `content-length: ${body.length}\r\nconnection: close\r\n\r\n`
      )
      ch.write(body)
      ch.end()
    })
    ch.on('error', () => {
      /* 브라우저가 먼저 끊는 경우 — 테스트 판정과 무관 */
    })
  }
  return { hits, handler }
}

// "그 번호 그대로 열려야 한다"(OAuth 콜백·미리보기)를 검사할 때 쓰는 **예약** 포트.
// bind(0) 로 빈 번호를 골라 쓰면 안 된다: 돌려준 직후 다른 워커의 holdPort(0) 가 같은 번호를 집어 가
// 원인 없는 실패가 난다(실제로 겪었다). 그래서 번호를 테스트마다 고정으로 나눠 갖는다 —
// 개발자 PC 에서 흔한 3000·8080 도, Windows 임시 포트 범위(49152~)도 피한 대역이다.
const RESERVED_BASE = 39000

export async function reservedPort(slot: number): Promise<number> {
  const port = RESERVED_BASE + slot
  const s = createServer()
  const free = await new Promise<boolean>((r) => {
    s.once('error', () => r(false))
    s.listen(port, '127.0.0.1', () => r(true))
  })
  await new Promise<void>((r) => s.close(() => r()))
  if (!free) throw new Error(`예약 포트 ${port} 가 이미 사용 중입니다 — 그 프로그램을 끄고 다시 실행하세요`)
  return port
}

// `ss -tlnp` 한 줄짜리 응답(원격이 그 포트 하나만 듣고 있는 서버).
export function portsListing(port: number, proc = 'vite', pid = 2451): string {
  return (
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n' +
    `LISTEN 0      511        127.0.0.1:${port}       0.0.0.0:*     users:(("${proc}",pid=${pid},fd=18))\n`
  )
}

// 내장 브라우저 창은 preload 가 없어 Playwright 가 Page 로 붙잡지 못한다 — main 에서 본다.
export async function windowInfos(app: ElectronApplication): Promise<{ title: string; url: string }[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), url: w.webContents.getURL() }))
  )
}

// 메인 창은 file:// 을 로드한다 — 그 외 창이 내장 브라우저다.
export async function browserWindows(app: ElectronApplication): Promise<{ title: string; url: string }[]> {
  return (await windowInfos(app)).filter((w) => !w.url.startsWith('file:'))
}

type ShellSpy = { external: string[]; paths: string[] }

// main 의 shell.openExternal / openPath 를 가로챈다. 원본은 부르지 않는다 — 실제 OS 브라우저나
// 탐색기가 뜨면 검증 세션이 오염된다(그리고 CI 에서는 아무도 그 창을 닫아 주지 않는다).
export async function spyShell(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __araShellSpy?: ShellSpy }
    if (g.__araShellSpy) return
    const spy: ShellSpy = { external: [], paths: [] }
    g.__araShellSpy = spy
    const s = shell as unknown as Record<string, unknown>
    s.openExternal = (url: string): Promise<void> => {
      spy.external.push(url)
      return Promise.resolve()
    }
    s.openPath = (p: string): Promise<string> => {
      spy.paths.push(p)
      return Promise.resolve('')
    }
  })
}

export async function spyCalls(app: ElectronApplication): Promise<ShellSpy> {
  return app.evaluate(() => (globalThis as unknown as { __araShellSpy: ShellSpy }).__araShellSpy)
}

// 화면에 그려진 URL 글자의 중심 좌표. xterm 링크는 DOM 요소가 아니라 **좌표로** 판정되므로
// (Linkifier 가 마우스 위치의 셀을 링크와 대조한다) 글자 위치를 Range 로 직접 잰다.
async function linkPoint(page: Page, text: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((needle) => {
    for (const rowsEl of Array.from(document.querySelectorAll('.xterm-rows'))) {
      if (!(rowsEl as HTMLElement).offsetParent) continue // 비활성 패널
      for (const row of Array.from(rowsEl.children)) {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        const nodes: { node: Text; at: number }[] = []
        let line = ''
        while (walker.nextNode()) {
          const n = walker.currentNode as Text
          nodes.push({ node: n, at: line.length })
          line += n.data
        }
        const i = line.indexOf(needle)
        if (i < 0) continue
        const end = i + needle.length
        // 한 줄이 여러 span 으로 쪼개져 있어도 시작·끝 텍스트 노드를 찾아 하나의 Range 로 묶는다.
        const startN = [...nodes].reverse().find((x) => x.at <= i)
        const endN = [...nodes].reverse().find((x) => x.at < end)
        if (!startN || !endN) continue
        const range = document.createRange()
        range.setStart(startN.node, i - startN.at)
        range.setEnd(endN.node, Math.min(end - endN.at, endN.node.data.length))
        const r = range.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
    }
    return null
  }, text)
}

// 터미널에 찍힌 URL 을 Ctrl+클릭한다(그냥 클릭으로는 열리지 않는다 — R3.3).
export async function ctrlClickLink(page: Page, url: string): Promise<void> {
  await expect.poll(() => linkPoint(page, url), { timeout: 20_000 }).not.toBeNull()
  const pt = (await linkPoint(page, url))!
  await page.mouse.move(pt.x, pt.y)
  // xterm 은 hover 로 링크를 확정한 뒤에야 click 을 그 링크로 넘긴다.
  await page.waitForTimeout(200)
  await page.keyboard.down('Control')
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Control')
}
