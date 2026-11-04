// 원격 3차 R4 원격 채팅 보기 — 하네스 exec 을 WSL 임시 홈의 진짜 셸로 돌려(tests/managedOrcad.test.ts 와 같은 방식) 설치 동의 → 원격 Claude 탭 →
// 그 세션 안에서 서버 훅(transcript_path·prompt)을 부르면 앱이 같은 연결의 read 로 서버 claude-shared 의 jsonl 을 읽어 채팅 메시지를 낸다.
// 경로 탈출 거절·상한·증분은 vitest(tests/remoteChat.test.ts · managedOrcad '원격 채팅 보기'). WSL·python3 가 없으면 건너뛴다. 실서버에는 붙지 않는다.
// 처음 돌리는 시험이라 셀렉터·시간 초과가 틀릴 수 있다(작성만 — 메인이 돌린다).
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogConfirm } from './fixtures'

const drawer = '.settings-page.open'
const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
const WRAP = 'cd "$1" && HOME="$1" exec sh -c "$2"'
const runner = (home: string, cmd: string): [string, string[]] => (WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', WRAP, 'sh', home, cmd]] : ['sh', ['-c', WRAP, 'sh', home, cmd]])
const READY = (WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'python3', '-c', 'import pty'], { windowsHide: true }) : spawnSync('python3', ['-c', 'import pty'])).status === 0

test('SERVE-R4-1 원격 Claude 탭 채팅 보기 — 서버 transcript 가 채팅 메시지로', async ({ ara, ssh }) => {
  test.skip(!READY, 'WSL·python3 없음')
  const mk = WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '-t', 'ara-e2e-r4-XXXXXX'], { windowsHide: true }) : spawnSync('mktemp', ['-d', '-t', 'ara-e2e-r4-XXXXXX'])
  const home = mk.stdout.toString().trim()
  const sftpRoot = WIN ? `//wsl.localhost/${DISTRO}${home}` : home
  const exec = (command: string, stream: ServerChannel): void => {
    const [f, a] = runner(home, command)
    const child = spawn(f, a, { windowsHide: true })
    child.stdout.on('data', (d: Buffer) => stream.write(d))
    child.stderr.on('data', (d: Buffer) => stream.stderr.write(d))
    stream.on('data', (d: Buffer) => child.stdin.write(d))
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
  const h = await ssh({ password: 'pw-serve-r4', sftpRoot, execHandler: exec })
  const { page } = ara
  try {
    await connectNewSshProfile(page, { name: 'serve-r4', port: h.port, password: 'pw-serve-r4' })
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="managed"]`)
    await page.click(`${drawer} [data-managed="install"]`)
    await expect(dialog(page)).toBeVisible()
    await dialogConfirm(page)
    await expect(page.locator(`${drawer} [data-managed="remove"]`)).toBeVisible({ timeout: 60_000 })
    await page.keyboard.press('Escape')

    const tp = `${home}/.ara-server/claude-shared/projects/-repo/e2e.jsonl`
    spawnSync(...runner(home, 'mkdir -p "$HOME/.ara-server/claude-shared/projects/-repo"'), { windowsHide: true })
    const J = (o: unknown): string => JSON.stringify(o)
    writeFileSync(
      `${sftpRoot}/.ara-server/claude-shared/projects/-repo/e2e.jsonl`,
      [
        J({ type: 'user', uuid: 'u1', message: { role: 'user', content: '원격 채팅 보기 확인' } }),
        J({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '생각' }, { type: 'text', text: 'REMOTE CHAT OK' }] } })
      ].join('\n') + '\n'
    )
    writeFileSync(`${sftpRoot}/p.json`, J({ hook_event_name: 'UserPromptSubmit', session_id: 'e2e', transcript_path: tp, prompt: '원격 채팅 보기 확인' }))

    // connectNewSshProfile 의 기본 사용자 = dev(1차 실행 실패 원인: tester 로 가정해 동의 기록이 없는 호스트로 띄웠다).
    const hostKey = `dev@127.0.0.1:${h.port}`
    const r = await page.evaluate(([cwd, host]) => window.ev.agents.launch('claude', cwd, undefined, undefined, undefined, host), [home, hostKey] as const)
    expect(r).toMatchObject({ ok: true })
    const sid = (r as { sessionId: string }).sessionId
    // 서버에 claude 가 없어도 셸은 남는다 — 그 세션 안에서 서버 훅을 부른다(ARA_ORCAD_SESSION 은 orcad 가 넣었다).
    await page.evaluate(([s]) => window.ev.session.input(s, 'python3 "$HOME/.ara-server/orcad.py" hook claude < "$HOME/p.json"\n'), [sid] as const)
    await expect
      .poll(async () => (await page.evaluate((s) => window.ev.agents.chatOpen(s), sid)).messages.map((m: { blocks: { type: string; text?: string }[] }) => m.blocks.map((b) => b.text ?? b.type).join('|')), { timeout: 30_000 })
      .toEqual(['원격 채팅 보기 확인', 'thinking|REMOTE CHAT OK'])
    await page.evaluate((s) => window.ev.agents.chatClose(s), sid)
    await page.evaluate(([host, s]) => window.ev.agents.killRemote(host, s), [hostKey, sid] as const)
  } finally {
    spawnSync(...runner(home, 'python3 "$HOME/.ara-server/orcad.py" stop; rm -rf "$HOME/.ara-server" "$HOME/p.json"'), { windowsHide: true, timeout: 30_000 })
    if (WIN) spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'rm', '-rf', home], { windowsHide: true })
    else spawnSync('rm', ['-rf', home])
  }
})
