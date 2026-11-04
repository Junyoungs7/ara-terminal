// 원격 3차 R4 원격 채팅 보기 — 하네스 exec 을 WSL 임시 홈의 진짜 셸로 돌려(tests/managedOrcad.test.ts 와 같은 방식) 설치 동의 → 원격 Claude 탭(가짜 claude) →
// 가짜 claude 가 실행 인자의 --settings 훅으로 서버 훅(transcript_path·prompt)을 부르면 앱이 같은 연결의 read 로 서버 claude-shared 의 jsonl 을 읽어 채팅 메시지를 낸다.
// 경로 탈출 거절·상한·증분·본래 로그인 파일 묶기는 vitest(tests/remoteChat.test.ts · managedOrcad '원격 채팅 보기'). WSL·python3 가 없으면 건너뛴다. 실서버에는 붙지 않는다.
// 2차 실행 실패(채팅 30초 내내 빈 것)의 원인: WSL PATH 에 Windows 의 진짜 claude(/mnt/c/nvm4w/nodejs/claude)가 있어 원격 탭에서 진짜 Claude 가 떠
// PTY 로 친 훅 명령을 Claude 입력칸이 먹었다. 그래서 원격 명령을 가짜 claude(설정의 POSIX 경로 명령은 원격에도 쓰인다 — remoteAgentSettings)로 고정하고
// 단계마다(가짜 시작 → 훅 rc → orcad 대장의 마지막 상태 → 앱 채팅) 단언한다.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ServerChannel } from 'ssh2'
import { test, expect, connectNewSshProfile, dialog, dialogConfirm } from './fixtures'

const drawer = '.settings-page.open'
const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
const WRAP = 'cd "$1" && HOME="$1" exec sh -c "$2"'
const runner = (home: string, cmd: string): [string, string[]] => (WIN ? ['wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', WRAP, 'sh', home, cmd]] : ['sh', ['-c', WRAP, 'sh', home, cmd]])
const READY = (WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'python3', '-c', 'import pty'], { windowsHide: true }) : spawnSync('python3', ['-c', 'import pty'])).status === 0

/** 시험이 orcad 대장을 직접 본다(소켓 + 토큰 — 같은 임시 홈). */
const LIST_PY = [
  'import json, os, socket',
  'd = os.path.join(os.environ["HOME"], ".ara-server")',
  's = socket.socket(socket.AF_UNIX)',
  's.connect(os.path.join(d, "orcad.sock"))',
  'tok = open(os.path.join(d, "token")).read().strip()',
  's.sendall((json.dumps({"type": "hello", "protocol": 1, "token": tok}) + "\\n" + json.dumps({"type": "list", "rid": 1}) + "\\n").encode())',
  'buf = b""',
  'while True:',
  '    d2 = s.recv(65536)',
  '    if not d2: break',
  '    buf += d2',
  '    for line in buf.split(b"\\n"):',
  '        try: m = json.loads(line)',
  '        except ValueError: continue',
  '        if m.get("type") == "reply" and m.get("rid") == 1:',
  '            print(json.dumps(m.get("result"))); raise SystemExit',
  ''
].join('\n')

test('SERVE-R4-1 원격 Claude 탭 채팅 보기 — 서버 transcript 가 채팅 메시지로', async ({ launch, userDataDir, ssh }) => {
  test.skip(!READY, 'WSL·python3 없음')
  const mk = WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'mktemp', '-d', '-t', 'ara-e2e-r4-XXXXXX'], { windowsHide: true }) : spawnSync('mktemp', ['-d', '-t', 'ara-e2e-r4-XXXXXX'])
  const home = mk.stdout.toString().trim()
  const sftpRoot = WIN ? `//wsl.localhost/${DISTRO}${home}` : home
  const sh = (cmd: string): string => spawnSync(...runner(home, cmd), { windowsHide: true, timeout: 30_000 }).stdout.toString()
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

  const tp = `${home}/.ara-server/claude-shared/projects/-repo/e2e.jsonl`
  const J = (o: unknown): string => JSON.stringify(o)
  // 가짜 claude: 시작 표식 → --settings 의 UserPromptSubmit 훅을 claude 처럼(stdin JSON) 부르고 rc·출력을 남긴다 → 에이전트처럼 살아 있는다.
  writeFileSync(
    `${sftpRoot}/fake-claude`,
    [
      '#!/usr/bin/env python3',
      'import json, os, subprocess, sys, time',
      'h = os.environ["HOME"]',
      'open(os.path.join(h, "fake.started"), "w").write(" ".join(sys.argv[1:]))',
      'a = sys.argv[1:]',
      'cfg = json.load(open(a[a.index("--settings") + 1]))',
      `p = {"hook_event_name": "UserPromptSubmit", "session_id": "e2e", "transcript_path": ${J(tp)}, "prompt": "원격 채팅 보기 확인"}`,
      'res = []',
      'for g in cfg["hooks"]["UserPromptSubmit"]:',
      '    for hk in g["hooks"]:',
      '        r = subprocess.run(hk["command"], shell=True, input=json.dumps(p).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)',
      '        res.append("rc=%d out=%s err=%s sess=%s" % (r.returncode, r.stdout.decode().strip(), r.stderr.decode().strip()[-200:], os.environ.get("ARA_ORCAD_SESSION", "")))',
      'open(os.path.join(h, "hook.ok"), "w").write("\\n".join(res))',
      'print("FAKE-CLAUDE HOOKED")',
      'time.sleep(600)',
      ''
    ].join('\n')
  )
  sh('chmod 700 "$HOME/fake-claude" && mkdir -p "$HOME/.ara-server/claude-shared/projects/-repo"')
  // 설정의 POSIX 경로 명령은 원격에도 그대로 쓰인다 — 서버에 진짜 claude 가 있어도 가짜가 뜬다.
  writeFileSync(`${userDataDir}/agents.json`, J({ agents: { claude: { command: `${home}/fake-claude` } }, migratedAiCliFlags: true, chatNaming: false }))

  const h = await ssh({ password: 'pw-serve-r4', sftpRoot, execHandler: exec })
  const { page } = await launch(userDataDir)
  try {
    await connectNewSshProfile(page, { name: 'serve-r4', port: h.port, password: 'pw-serve-r4' })
    await page.keyboard.press('Control+,')
    await page.click(`${drawer} .sp-nav [data-section="managed"]`)
    await page.click(`${drawer} [data-managed="install"]`)
    await expect(dialog(page)).toBeVisible()
    await dialogConfirm(page)
    await expect(page.locator(`${drawer} [data-managed="remove"]`)).toBeVisible({ timeout: 60_000 })
    await page.keyboard.press('Escape')

    // transcript 는 claude-shared 에 미리 둔다(가짜 claude 는 쓰지 않는다).
    writeFileSync(
      `${sftpRoot}/.ara-server/claude-shared/projects/-repo/e2e.jsonl`,
      [
        J({ type: 'user', uuid: 'u1', message: { role: 'user', content: '원격 채팅 보기 확인' } }),
        J({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: '생각' }, { type: 'text', text: 'REMOTE CHAT OK' }] } })
      ].join('\n') + '\n'
    )

    // connectNewSshProfile 의 기본 사용자 = dev.
    const hostKey = `dev@127.0.0.1:${h.port}`
    const r = await page.evaluate(([cwd, host]) => window.ev.agents.launch('claude', cwd, undefined, undefined, undefined, host), [home, hostKey] as const)
    expect(r).toMatchObject({ ok: true })
    const sid = (r as { sessionId: string }).sessionId
    // 앱이 먼저 채팅을 연다(훅보다 먼저일 수 있다 — 그러면 경로를 몰라 빈 화면, 훅이 오면 열린 화면이 읽기 시작해야 한다).
    await page.evaluate((s) => window.ev.agents.chatOpen(s), sid)

    // 단계 1: 가짜 claude 가 원격 PTY 에서 떴다(인자에 서버 훅 설정).
    await expect.poll(() => existsSync(`${sftpRoot}/fake.started`), { timeout: 30_000, message: '가짜 claude 시작' }).toBe(true)
    expect(readFileSync(`${sftpRoot}/fake.started`, 'utf8')).toContain('/.ara-server/claude-hooks.json')
    // 단계 2: 훅 명령이 돌았다(rc 0 · {} · 세션 env 에 ARA_ORCAD_SESSION = 그 탭).
    await expect.poll(() => (existsSync(`${sftpRoot}/hook.ok`) ? readFileSync(`${sftpRoot}/hook.ok`, 'utf8') : ''), { timeout: 30_000, message: '서버 훅 실행' }).toContain(`rc=0 out={} err= sess=${sid}`)
    // 단계 3: orcad 대장의 마지막 상태에 그 경로가 묶였다.
    const listed = JSON.parse(sh(`python3 -c '${LIST_PY.replace(/'/g, `'\\''`)}'`) || '[]') as { id: string; status?: { payload?: Record<string, unknown> } }[]
    expect(listed.find((x) => x.id === sid)?.status?.payload).toMatchObject({ hook_event_name: 'UserPromptSubmit', transcript_path: tp, prompt: '원격 채팅 보기 확인' })
    // 단계 3b: 앱이 그 status 사건을 받았다(같은 사건이 채팅 경로도 싣는다) — 상태가 훅에서 왔으면 '추정'이 아니다.
    await expect
      .poll(async () => (await page.evaluate(() => window.ev.agents.statuses())).find((v: { sessionId: string }) => v.sessionId === sid), { timeout: 15_000, message: '앱이 서버 훅 사건을 받음' })
      .toMatchObject({ state: 'working', estimated: false })
    // 단계 4: 앱 채팅(열린 화면이 훅으로 읽기 시작 · 다시 열어도 기억한 경로). 생각함 블록은 text 에 생각 글을 싣는다(3차 실행 실패 — 기대값이 'thinking' 이었다).
    await expect
      .poll(async () => (await page.evaluate((s) => window.ev.agents.chatOpen(s), sid)).messages.map((m: { blocks: { type: string; text?: string }[] }) => m.blocks.map((b) => b.text ?? b.type).join('|')), { timeout: 30_000, message: '앱 채팅' })
      .toEqual(['원격 채팅 보기 확인', '생각|REMOTE CHAT OK'])
    await page.evaluate((s) => window.ev.agents.chatClose(s), sid)
    await page.evaluate(([host, s]) => window.ev.agents.killRemote(host, s), [hostKey, sid] as const)
  } finally {
    sh('python3 "$HOME/.ara-server/orcad.py" stop; rm -rf "$HOME/.ara-server"')
    if (WIN) spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'rm', '-rf', home], { windowsHide: true })
    else spawnSync('rm', ['-rf', home])
  }
})
