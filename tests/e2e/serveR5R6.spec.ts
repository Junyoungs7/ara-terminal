// 원격 3차 R5 상주 모드(기본 켜짐) · R6 연결 견고성.
// SERVE-R5-1: managed.spec 처럼 하네스 exec 은 흉내만 — 채택 동의 화면의 상주 고지 · 설정 › 관리형 서버의 상주 스위치(기본 켜짐 → 끄면 서버 설치 폴더에 파일 하나).
// SERVE-R6-1: 하네스 exec 을 WSL 임시 홈의 진짜 셸로(serveR4.spec 와 같은 방식, 가짜 claude — 진짜 claude 가 잡히지 않게) — 서버의 다리 프로세스를 죽여
//   연결을 끊은 뒤 다시 붙으면 같은 세션이 replay 로 이어진다. 상주 켜짐/끔의 생존·자동 재시도 간격·옛 서버의 '모르는 요청'·다른 PC 입력·통신 판 불일치·제거 흔적 0 은
//   vitest(tests/managedOrcad.test.ts 'R5 상주'·'R6', tests/aiwsAgentStore.test.ts 'R6 자동 다시 연결'). WSL·python3 가 없으면 R6-1 은 건너뛴다. 실서버에는 붙지 않는다.
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogConfirm } from './fixtures'

const drawer = '.settings-page.open'
const LINUX = 'os=Linux\narch=x86_64\nhome=/home/tester\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

function fakeRemote(probeOut: string): { cmds: string[]; handler: (command: string, stream: ServerChannel) => void } {
  const cmds: string[] = []
  return {
    cmds,
    handler: (command, stream) => {
      cmds.push(command)
      if (command.includes('uname -s')) stream.write(probeOut)
      stream.exit(0)
      stream.end()
    }
  }
}

// SERVE-R5-1 상주는 기본 켜짐 — 채택 화면에 "아라를 꺼도 서버에서 계속 실행 · 재부팅되면 멈춤" 고지, 설정의 스위치가 켜진 채로 보이고,
// 끄면 서버 설치 폴더에 resident-off 파일 하나만 만든다(서버를 띄우지 않는다 — orcad.py 를 부르지 않음).
test('SERVE-R5-1 상주 모드 — 동의 화면 고지 · 설정에서 서버별로 끄기', async ({ ara, ssh }) => {
  const version = await ara.app.evaluate(({ app }) => app.getVersion())
  const remote = fakeRemote(`${LINUX}installed=${version}\n`)
  const h = await ssh({ password: 'pw-serve-r5', execHandler: remote.handler })
  await connectNewSshProfile(ara.page, { name: 'serve-r5', port: h.port, password: 'pw-serve-r5' })
  await ara.page.keyboard.press('Control+,')
  await ara.page.click(`${drawer} .sp-nav [data-section="managed"]`)
  // 쉬운 말 — 설정 설명에도 데몬·orcad 라는 말이 없다.
  await expect(ara.page.locator(`${drawer} [data-sec="managed"] > .set-note`).first()).not.toContainText('데몬')
  await ara.page.click(`${drawer} [data-managed="install"]`)
  const d = dialog(ara.page)
  await expect(d).toContainText('이 서버에 아라 서버가 이미 있습니다')
  await expect(d).toContainText('아라를 꺼도 서버에서 계속 실행')
  await expect(d).toContainText('서버가 재부팅되면 멈추')
  await expect(d).not.toContainText('데몬')
  await dialogConfirm(ara.page)
  await expect(ara.page.locator(`${drawer} [data-managed="remove"]`)).toBeVisible({ timeout: 30_000 })

  const sw = ara.page.locator(`${drawer} [data-managed="resident"] [role="switch"]`)
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  const before = remote.cmds.length
  await sw.click()
  await expect(ara.page.locator(`${drawer} [data-managed="msg"]`)).toContainText('상주를 껐습니다')
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  const sent = remote.cmds.slice(before)
  expect(sent.some((c) => c.includes('resident-off'))).toBe(true)
  expect(sent.some((c) => c.includes('orcad.py'))).toBe(false)
  // 다시 켜면 그 파일을 지운다.
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  expect(remote.cmds.slice(before).some((c) => c.includes('rm -f') && c.includes('resident-off'))).toBe(true)
})

const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
const WRAP = 'cd "$1" && HOME="$1" exec sh -c "$2"'
const runner = (home: string, cmd: string): [string, string[]] => (WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', WRAP, 'sh', home, cmd]] : ['sh', ['-c', WRAP, 'sh', home, cmd]])
const READY = (WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'python3', '-c', 'import pty'], { windowsHide: true }) : spawnSync('python3', ['-c', 'import pty'])).status === 0

type R6Win = { __r6?: string; __r6exit?: number }

// SERVE-R6-1 다리(SSH exec 채널)가 끊기면 탭은 끊김(잃음 코드), 서버 세션은 산다 → 다시 붙으면 같은 세션 id 로 replay 가 오고 입력이 이어진다.
test('SERVE-R6-1 다리가 끊겨도 같은 세션으로 다시 붙고 replay 로 화면이 이어진다', async ({ launch, userDataDir, ssh }) => {
  test.skip(!READY, 'WSL·python3 없음')
  const mk = WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '-t', 'ara-e2e-r6-XXXXXX'], { windowsHide: true }) : spawnSync('mktemp', ['-d', '-t', 'ara-e2e-r6-XXXXXX'])
  const home = mk.stdout.toString().trim()
  const sftpRoot = WIN ? `//wsl.localhost/${DISTRO}${home}` : home
  const sh = (cmd: string): string => spawnSync(...runner(home, cmd), { windowsHide: true, timeout: 30_000 }).stdout.toString()
  const exec = (command: string, stream: ServerChannel): void => {
    const [f, a] = runner(home, command)
    const child = spawn(f, a, { windowsHide: true })
    child.stdout.on('data', (b: Buffer) => stream.write(b))
    child.stderr.on('data', (b: Buffer) => stream.stderr.write(b))
    stream.on('data', (b: Buffer) => child.stdin.write(b))
    const endIn = (): void => void (child.stdin.writable && child.stdin.end())
    stream.on('end', endIn)
    stream.on('close', endIn)
    child.stdin.on('error', () => {})
    child.on('close', (code) => {
      try {
        stream.exit(code ?? 1)
        stream.end()
      } catch {
        /* 채널이 이미 닫힘 */
      }
    })
  }
  // 가짜 claude: 준비 표식을 찍고, 받은 줄을 되돌려 찍는다(에이전트처럼 살아 있다). 진짜 claude 는 띄우지 않는다.
  writeFileSync(
    `${sftpRoot}/fake-claude`,
    ['#!/usr/bin/env python3', 'import sys', 'print("FAKE-R6 READY", flush=True)', 'for line in sys.stdin:', '    print("GOT:" + line.strip(), flush=True)', ''].join('\n')
  )
  sh('chmod 700 "$HOME/fake-claude"')
  writeFileSync(`${userDataDir}/agents.json`, JSON.stringify({ agents: { claude: { command: `${home}/fake-claude` } }, migratedAiCliFlags: true, chatNaming: false }))

  const h = await ssh({ password: 'pw-serve-r6', sftpRoot, execHandler: exec })
  const { page } = await launch(userDataDir)
  try {
    await connectNewSshProfile(page, { name: 'serve-r6', port: h.port, password: 'pw-serve-r6' })
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="managed"]`)
    await page.click(`${drawer} [data-managed="install"]`)
    await expect(dialog(page)).toBeVisible()
    await dialogConfirm(page)
    await expect(page.locator(`${drawer} [data-managed="remove"]`)).toBeVisible({ timeout: 60_000 })
    await page.keyboard.press('Escape')

    // connectNewSshProfile 의 기본 사용자 = dev.
    const hostKey = `dev@127.0.0.1:${h.port}`
    const r = await page.evaluate(([cwd, host]) => window.ev.agents.launch('claude', cwd, undefined, undefined, undefined, host), [home, hostKey] as const)
    expect(r).toMatchObject({ ok: true })
    const sid = (r as { sessionId: string }).sessionId
    // 출력은 렌더러가 session.attach 를 불러야 push 된다(그 전엔 main 백로그에만 — MainSessionManager attached). 터미널 칸이 없으니 시험이 직접 붙는다.
    // 다시 붙을 때(adopt)도 새 핸들이라 다시 attach 한다 — 돌려받는 백로그에 replay 가 들어 있다.
    const attachOut = (s: string): Promise<void> =>
      page.evaluate(async (x) => {
        const w = window as unknown as R6Win
        const r = await window.ev.session.attach(x)
        w.__r6 = (w.__r6 ?? '') + new TextDecoder().decode(r.backlog)
      }, s)
    await page.evaluate((s) => {
      const w = window as unknown as R6Win
      w.__r6 = ''
      window.ev.session.onData(s, (c) => (w.__r6 += new TextDecoder().decode(c)))
      window.ev.session.onExit(s, (info) => (w.__r6exit = info.exitCode))
    }, sid)
    await attachOut(sid)
    const out = (): Promise<string> => page.evaluate(() => (window as unknown as R6Win).__r6 ?? '')
    await expect.poll(out, { timeout: 30_000, message: '가짜 claude 준비' }).toContain('FAKE-R6 READY')
    await page.evaluate((s) => window.ev.session.input(s, 'r6-before\r'), sid)
    await expect.poll(out, { timeout: 15_000 }).toContain('GOT:r6-before')

    // 서버의 다리 프로세스를 죽인다(노트북 절전·망 바뀜 흉내) → 이 PC 의 탭만 끊김.
    sh('pkill -f "$HOME/.ara-server/orcad.py connect"')
    await expect.poll(() => page.evaluate(() => (window as unknown as R6Win).__r6exit ?? null), { timeout: 20_000, message: '끊김' }).not.toBeNull()

    // 다시 붙기(렌더러의 자동 재시도·[지금 다시 연결]이 부르는 것과 같은 길) → 같은 세션 id, replay 로 이전 화면이 다시 온다.
    await page.evaluate(() => ((window as unknown as R6Win).__r6 = ''))
    await expect
      .poll(async () => {
        const x = await page.evaluate((host) => window.ev.agents.reconnect(host), hostKey)
        return x.ok ? x.tabs.map((t: { sessionId: string }) => t.sessionId) : x.error
      }, { timeout: 30_000, message: '다시 붙기' })
      .toEqual([sid])
    await attachOut(sid)
    await expect.poll(out, { timeout: 15_000, message: 'replay' }).toContain('GOT:r6-before')
    await page.evaluate((s) => window.ev.session.input(s, 'r6-after\r'), sid)
    await expect.poll(out, { timeout: 15_000, message: '다시 붙은 뒤 입력' }).toContain('GOT:r6-after')
    await page.evaluate(([host, s]) => window.ev.agents.killRemote(host, s), [hostKey, sid] as const)
  } finally {
    sh('python3 "$HOME/.ara-server/orcad.py" stop; rm -rf "$HOME/.ara-server"')
    if (WIN) spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'rm', '-rf', home], { windowsHide: true })
    else spawnSync('rm', ['-rf', home])
  }
})
