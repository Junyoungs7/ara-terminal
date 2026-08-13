// FB-monitor(FB-0004) — tmux 액션을 [모니터] 탭 버튼 줄에서 트리 우클릭 서브메뉴로 옮겼다.
// 예전엔 로컬 pty 를 __evAdopt 로 "SSH 로 편입"해 UI 게이트만 열면 충분했다(session.input 매크로는
// 백엔드 종류를 안 가린다). 이번 서브메뉴는 목록 조회(tmux:listSessions)가 **실제 ssh2 커넥션**을
// 요구해서(sessions.sshClient() 가 SshBackend 만 인정) 진짜 ssh2 루프백 하네스로 접속한다(실서버 없음 — DLP).
// 하네스의 shell 채널은 받은 바이트를 그대로 되쏘는 에코 서버라(ssh-harness.ts) session.input() 이
// 보낸 문자열이 termText 에 그대로 나타난다 — 원래 tmuxbar E2E 와 같은 판정 방식을 유지한다.
import type { ServerChannel } from 'ssh2'
import type { Page } from '@playwright/test'
import { test, expect, connectNewSshProfile, openConnTab, newLocalShell, dialog, dialogConfirm, sessionList, termText } from './fixtures'

const TMUX_LS_CMD = 'tmux ls 2>&1'

// 트리의 세션 행 하나(연결 직후엔 서버 노드 하위에 정확히 하나) 우클릭 → tmux 항목 호버 → 서브메뉴.
async function openTmuxSubmenu(page: Page): Promise<void> {
  await page.locator('.tree .sess-node').first().click({ button: 'right' })
  await expect(page.locator('.ctx-menu .ctx-item[data-action="session.tmux"]')).toBeVisible()
  await page.hover('.ctx-menu .ctx-item[data-action="session.tmux"]')
  await expect(page.locator('.ctx-submenu')).toBeVisible()
}

// TMUX-1 로컬 세션은 SSH 가 아니므로 우클릭 메뉴에 tmux 항목이 없다(원격 셸이 없다).
test('TMUX-1 로컬 세션 우클릭 메뉴에는 tmux 항목이 없다', async ({ ara }) => {
  const { page } = ara
  await newLocalShell(page)
  await page.locator('.tree .sess-node').first().click({ button: 'right' })
  await expect(page.locator('.ctx-menu')).toBeVisible()
  await expect(page.locator('.ctx-menu .ctx-item[data-action="session.tmux"]')).toHaveCount(0)
})

// TMUX-2 SSH 세션 우클릭 → tmux 항목 호버 → 서브메뉴에 고정 항목(새 세션·분리·이전창·다음창)이 뜬다.
// 이 서버는 tmux 서버가 없는 상태(no server running)라 "세션 없음" 안내가 함께 뜬다.
test('TMUX-2 SSH 세션 우클릭에서 tmux 를 호버하면 서브메뉴가 열린다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux2',
    execHandler: (_cmd, stream: ServerChannel) => {
      stream.write('no server running on /tmp/tmux-1000/default\n')
      stream.exit(1)
      stream.end()
    }
  })
  await connectNewSshProfile(page, { name: 'tmux2', port: h.port, password: 'pw-tmux2' })
  await openConnTab(page)
  await openTmuxSubmenu(page)

  const ids = await page
    .locator('.ctx-submenu .ctx-item')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.action))
  expect(ids).toEqual([
    'session.tmux.new',
    'tmux.status', // 서버 없음(세션 0개) 안내
    'session.tmux.detach',
    'session.tmux.prevWindow',
    'session.tmux.nextWindow'
  ])
  await expect(page.locator('.ctx-submenu .ctx-item[data-action="tmux.status"]')).toHaveText('실행 중인 세션이 없습니다')
  await expect(page.locator('.ctx-submenu .ctx-item[data-action="tmux.status"]')).toHaveClass(/disabled/)
})

// TMUX-3 ★ [새 세션] — 이름 다이얼로그 → 즉시 실행되는 tmux new 명령이 터미널로 전송된다.
test('TMUX-3 ★ [새 세션] 이 이름을 물어 즉시 실행되는 tmux 명령을 터미널로 보낸다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux3',
    execHandler: (_c, s: ServerChannel) => {
      s.exit(0)
      s.end()
    }
  })
  const id = await connectNewSshProfile(page, { name: 'tmux3', port: h.port, password: 'pw-tmux3' })
  await openConnTab(page)
  await openTmuxSubmenu(page)
  await page.click('.ctx-submenu .ctx-item[data-action="session.tmux.new"]')
  await expect(dialog(page)).toBeVisible()
  await page.fill('.dlg-input', 'work')
  await dialogConfirm(page)
  await expect.poll(() => termText(page, id)).toContain("tmux new -s 'work'")
})

// TMUX-4 실행 중인 세션이 있으면 서브메뉴에 이름이 뜨고, 클릭하면 다이얼로그 없이 바로 붙기 명령이 전송된다.
test('TMUX-4 실행 중인 세션 이름을 클릭하면 즉시 붙기 명령이 전송된다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux4',
    execHandler: (command, stream: ServerChannel) => {
      if (command === TMUX_LS_CMD) stream.write('deploy: 1 windows (created Mon Aug  3 10:00:00 2026) [80x24]\n')
      stream.exit(0)
      stream.end()
    }
  })
  const id = await connectNewSshProfile(page, { name: 'tmux4', port: h.port, password: 'pw-tmux4' })
  await openConnTab(page)
  await openTmuxSubmenu(page)
  await expect(page.locator('.ctx-submenu .ctx-item[data-action="session.tmux.attach:deploy"]')).toHaveText('deploy')
  await page.click('.ctx-submenu .ctx-item[data-action="session.tmux.attach:deploy"]')
  // 다이얼로그 없이 — 서브메뉴가 이미 실제 이름을 알고 있으니 다시 묻지 않는다.
  await expect(dialog(page)).toHaveCount(0)
  await expect.poll(() => termText(page, id)).toContain("tmux a -t 'deploy'")
})

// TMUX-5 tmux 미설치 서버는 "설치 안 됨" — "세션 없음"과 다른 안내다(무의미한 "모르겠음" 반복 금지).
test('TMUX-5 tmux 가 없는 서버는 설치 안내로 구분된다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux5',
    execHandler: (command, stream: ServerChannel) => {
      if (command === TMUX_LS_CMD) {
        stream.write('bash: tmux: command not found\n')
        stream.exit(127)
      } else {
        stream.exit(0)
      }
      stream.end()
    }
  })
  await connectNewSshProfile(page, { name: 'tmux5', port: h.port, password: 'pw-tmux5' })
  await openConnTab(page)
  await openTmuxSubmenu(page)
  await expect(page.locator('.ctx-submenu .ctx-item[data-action="tmux.status"]')).toHaveText('tmux가 설치되어 있지 않습니다')
})

// TMUX-6 ★ 셸 특수문자가 든 이름도 단일 인용된 채로 통째로 전송된다(명령 주입 방지 — tmux.test.ts 의
// quoteShellArg 규칙과 동일해야 한다).
test('TMUX-6 ★ 세미콜론이 든 이름도 안전하게 단일 인용된 채로 전송된다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux6',
    execHandler: (_c, s: ServerChannel) => {
      s.exit(0)
      s.end()
    }
  })
  const id = await connectNewSshProfile(page, { name: 'tmux6', port: h.port, password: 'pw-tmux6' })
  await openConnTab(page)
  await openTmuxSubmenu(page)
  await page.click('.ctx-submenu .ctx-item[data-action="session.tmux.new"]')
  await page.fill('.dlg-input', 'a; rm -rf /')
  await dialogConfirm(page)
  await expect.poll(() => termText(page, id)).toContain("tmux new -s 'a; rm -rf /'")
})

// TMUX-7 분리 · 다음 창 — prefix 키(Ctrl+b, 제어문자라 화면엔 안 남는다) 다음 글자 하나만 정확히 전송된다.
test('TMUX-7 분리·창 전환은 prefix 키 조합을 그대로 보낸다(제어문자 제외 딱 한 글자)', async ({ ara, ssh }) => {
  const { page } = ara
  // 채널에 실제로 쓰인 바이트를 하네스가 직접 캡처(onShellData, HIST-5·6 과 같은 패턴)해 비교한다
  // — 화면 렌더링과 무관하게 앱이 보낸 것 그대로를 본다.
  const written: string[] = []
  const h = await ssh({
    password: 'pw-tmux7',
    onShellData: (d) => written.push(d),
    execHandler: (_c, s: ServerChannel) => {
      s.exit(0)
      s.end()
    }
  })
  await connectNewSshProfile(page, { name: 'tmux7', port: h.port, password: 'pw-tmux7' })
  await openConnTab(page)

  // 백로그 M-9 이후 앱은 셸 채널로 아무것도 안 보낸다(CWD 는 /proc 에서 읽는다 — remoteCwd.ts).
  // 그래서 여기까지 쓰인 바이트는 0 이어야 하고, 이 뒤에 오는 것은 전부 tmux 입력이다.
  expect(written.join('')).toBe('')
  const before1 = written.length
  await openTmuxSubmenu(page)
  await page.click('.ctx-submenu .ctx-item[data-action="session.tmux.detach"]')
  await expect.poll(() => written.length).toBeGreaterThan(before1)
  // buildTmuxInput({kind:'detach'}) === '\x02d'(tmux.test.ts) — prefix + 문자 하나, 그 이상 없다.
  expect(written.slice(before1).join('')).toBe('\x02d')

  const before2 = written.length
  await openTmuxSubmenu(page)
  await page.click('.ctx-submenu .ctx-item[data-action="session.tmux.nextWindow"]')
  await expect.poll(() => written.length).toBeGreaterThan(before2)
  expect(written.slice(before2).join('')).toBe('\x02n')
})

// TMUX-8 SSH 세션을 닫으면 트리에서 그 세션 행이 사라진다(우클릭 대상 자체가 없어진다).
test('TMUX-8 SSH 세션을 닫으면 트리에서 세션 행이 사라진다', async ({ ara, ssh }) => {
  const { page } = ara
  const h = await ssh({
    password: 'pw-tmux8',
    execHandler: (_c, s: ServerChannel) => {
      s.exit(0)
      s.end()
    }
  })
  await connectNewSshProfile(page, { name: 'tmux8', port: h.port, password: 'pw-tmux8' })
  await openConnTab(page)
  await expect(page.locator('.tree .sess-node')).toHaveCount(1)

  await page.locator('.tree .sess-node').first().click({ button: 'right' })
  await page.click('.ctx-menu .ctx-item[data-action="session.close"]')
  // SSH 종료는 되돌릴 수 없어(원격 작업이 끊긴다) 확인을 한 번 받는다 — 그 다이얼로그가 생긴 뒤
  // 이 테스트가 갱신되지 않아 세션이 안 닫힌 채 통과를 기다리고 있었다.
  await expect(dialog(page)).toContainText('세션을 종료할까요?')
  await dialogConfirm(page)
  await expect.poll(async () => (await sessionList(page)).length).toBe(0)
  await expect(page.locator('.tree .sess-node')).toHaveCount(0)
})
