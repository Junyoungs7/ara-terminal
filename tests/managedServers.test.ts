// M8 DM-02·03 관리형 서버 — 순수 판정(동의 상태·지원 판정·판 비교·업데이트 판정·제거 검증 목록). 원격 실증은 managedOrcad.test.ts.
import { describe, expect, it } from 'vitest'
import {
  MANAGED_DIR,
  MANAGED_MARK,
  UNINSTALL_SCRIPT,
  VERIFY_SCRIPT,
  adoptKindOf,
  consentOf,
  consentPlan,
  decideUpdate,
  hostKeyOf,
  parseProbe,
  remnantsOf,
  remoteHookCommand,
  remoteHookFile,
  remoteHookLaunch,
  serverAccountsOf,
  accountErrorText,
  accountLoginLine,
  serverRowsOf,
  serverStateOf,
  supportOf,
  versionCmp,
  type ManagedRecord
} from '../src/shared/managedServers'
import { ORCAD_PY } from '../src/main/managed/orcadScript'
import { HOOK_TARGETS } from '../src/shared/agentHooks'
import { CLAUDE_HISTORY } from '../src/main/usage/accounts'

const linux = 'os=Linux\narch=x86_64\nhome=/home/dev\npython=/usr/bin/python3\npyver=3.10\npymods=1\n'

describe('probe → 지원 판정', () => {
  it('Linux + python3 3.6 이상 + 모듈 = 지원', () => {
    const p = parseProbe(linux)
    expect(p).toMatchObject({ os: 'Linux', arch: 'x86_64', home: '/home/dev', pyver: '3.10', pymods: true, installed: null })
    expect(supportOf(p)).toEqual({ ok: true })
    expect(supportOf(parseProbe(linux.replace('3.10', '3.6')))).toEqual({ ok: true })
  })
  it('지원 안 함은 이유를 단다', () => {
    expect(supportOf(parseProbe(linux.replace('Linux', 'Darwin')))).toEqual({ ok: false, reason: 'os' })
    expect(supportOf(parseProbe('os=Linux\npython=\n'))).toEqual({ ok: false, reason: 'python' })
    expect(supportOf(parseProbe(linux.replace('3.10', '3.5')))).toEqual({ ok: false, reason: 'pythonOld' })
    expect(supportOf(parseProbe(linux.replace('3.10', '2.7')))).toEqual({ ok: false, reason: 'pythonOld' })
    expect(supportOf(parseProbe(linux.replace('pymods=1\n', '')))).toEqual({ ok: false, reason: 'pythonModules' })
    // 빈 출력(명령이 죽음)은 지원한다고 말하지 않는다.
    expect(supportOf(parseProbe(''))).toEqual({ ok: false, reason: 'os' })
  })
  it('설치된 판을 읽는다 · CRLF 도', () => {
    expect(parseProbe(linux.replace(/\n/g, '\r\n') + 'installed=2.11.0\r\n').installed).toBe('2.11.0')
  })
})

describe('판 비교·업데이트 판정', () => {
  it('versionCmp', () => {
    expect(versionCmp('2.11.0', '2.11.0')).toBe(0)
    expect(versionCmp('2.9.0', '2.11.0')).toBe(-1)
    expect(versionCmp('2.11.1', '2.11')).toBe(1)
    expect(versionCmp('3.0.0-beta.1', '3.0.0')).toBe(0)
  })
  it('없으면 설치, 같으면 그대로, 새 판은 낮추지 않음, 돌고 있으면 미룸, 아니면 교체', () => {
    expect(decideUpdate({ installed: null, app: '2.11.0', liveSessions: 0 })).toBe('install')
    expect(decideUpdate({ installed: '2.11.0', app: '2.11.0', liveSessions: 3 })).toBe('current')
    expect(decideUpdate({ installed: '2.12.0', app: '2.11.0', liveSessions: 0 })).toBe('keepNewer')
    expect(decideUpdate({ installed: '2.10.0', app: '2.11.0', liveSessions: 1 })).toBe('defer')
    expect(decideUpdate({ installed: '2.10.0', app: '2.11.0', liveSessions: 0 })).toBe('update')
  })
})

describe('제거 검증 목록', () => {
  it('흔적 0', () => {
    expect(remnantsOf('dir=no\nproc=0\ncron=0\nsystemd=0\naccounts=0\ncreds=0\n')).toEqual([])
  })
  it('남은 것을 이름으로', () => {
    expect(remnantsOf('dir=yes\nproc=2\ncron=1\nsystemd=0\naccounts=2\ncreds=1\n')).toEqual(['dir', 'proc:2', 'cron:1', 'accounts:2', 'creds:1'])
  })
  it('못 잰 것은 "없다"가 아니라 unknown', () => {
    expect(remnantsOf('')).toEqual(['unknown:dir', 'unknown:proc', 'unknown:cron', 'unknown:systemd', 'unknown:accounts', 'unknown:creds'])
    expect(remnantsOf('dir=no\nproc=\ncron=x\nsystemd=0\naccounts=0\ncreds=0')).toEqual(['unknown:proc', 'unknown:cron'])
  })
  it('검증·제거 명령이 설치 폴더와 표식을 본다(오타 한 글자면 0 이 거짓말이 된다)', () => {
    for (const s of [VERIFY_SCRIPT, UNINSTALL_SCRIPT]) {
      expect(s).toContain(`$HOME/${MANAGED_DIR}`)
      expect(s).toContain(`${MANAGED_MARK}=$D`)
    }
    expect(ORCAD_PY).toContain(`MARK = '${MANAGED_MARK}'`)
  })
})

describe('동의', () => {
  const rec: ManagedRecord = { hostKey: 'dev@10.0.0.5:22', consentedAt: '2026-11-01T00:00:00Z', version: '2.11.0', state: 'installed', checkedAt: '2026-11-01T00:00:00Z' }
  it('호스트·계정별', () => {
    expect(hostKeyOf({ username: 'dev', host: '10.0.0.5', port: 22 })).toBe('dev@10.0.0.5:22')
    expect(consentOf([rec], 'dev@10.0.0.5:22')).toBe('consented')
    expect(consentOf([rec], 'root@10.0.0.5:22')).toBe('none')
    expect(consentOf([], 'dev@10.0.0.5:22')).toBe('none')
  })
  it('동의 화면: 무엇을(경로·크기) · 어디에 · 상주 · 소켓 · 지우는 법', () => {
    const p = consentPlan('dev@h:22', parseProbe(linux), 12345, 64, 6)
    expect(p.dir).toBe('/home/dev/.ara-server')
    expect(p.files).toEqual([
      { path: '/home/dev/.ara-server/orcad.py', bytes: 12345 },
      { path: '/home/dev/.ara-server/token', bytes: 64 },
      { path: '/home/dev/.ara-server/version', bytes: 6 },
      { path: '/home/dev/.ara-server/claude-hooks.json', bytes: new TextEncoder().encode(remoteHookFile('claude')).length },
      { path: '/home/dev/.ara-server/gemini-hooks.json', bytes: new TextEncoder().encode(remoteHookFile('gemini')).length }
    ])
    expect(p.runtimeFiles.every((f) => f.startsWith(p.dir + '/'))).toBe(true)
    expect(p.socket).toBe('/home/dev/.ara-server/orcad.sock')
    expect(p.process).toContain('orcad.py serve')
    expect(p.manualRemove).toContain('rm -rf ~/.ara-server')
    expect(p.support).toEqual({ ok: true })
  })
})

describe('orcad.py 는 String.raw 안에 산다', () => {
  it('파이썬 글이 템플릿을 깨지 않았다(시작·끝이 온전)', () => {
    expect(ORCAD_PY.startsWith('#!/usr/bin/env python3\n')).toBe(true)
    expect(ORCAD_PY.trimEnd().endsWith('sys.exit(64)')).toBe(true)
    // 파이썬의 '\n' 이 진짜 줄바꿈으로 바뀌지 않았다(String.raw).
    expect(ORCAD_PY).toContain("+ '\\n').encode('utf-8')")
  })
})

// R1 다른 PC 에서 이어 보기 — 채택(이미 설치됨) 판 비교, 돌고 있나 읽기, 서버 세션 목록 줄.
describe('R1 채택·서버 세션 목록', () => {
  it('돌고 있나(소켓)를 읽는다 — 없으면 false(세려고 서버를 띄우지 않는다)', () => {
    expect(parseProbe(linux + 'running=1\ninstalled=2.2.11\n')).toMatchObject({ running: true, installed: '2.2.11' })
    expect(parseProbe(linux + 'installed=2.2.11\n').running).toBe(false)
  })
  it('채택 판 비교 — 같음·서버가 옛 판·서버가 새 판', () => {
    expect(adoptKindOf('2.2.11', '2.2.11')).toBe('same')
    expect(adoptKindOf('2.2.9', '2.2.11')).toBe('older')
    expect(adoptKindOf('2.3.0', '2.2.11')).toBe('newer')
    // 채택 뒤의 실제 처리는 decideUpdate — 옛 판 + 세션 있음 = 미룸(세션 보존), 없음 = 올림, 새 판 = 낮추지 않음.
    expect(decideUpdate({ installed: '2.2.9', app: '2.2.11', liveSessions: 2 })).toBe('defer')
    expect(decideUpdate({ installed: '2.2.9', app: '2.2.11', liveSessions: 0 })).toBe('update')
    expect(decideUpdate({ installed: '2.3.0', app: '2.2.11', liveSessions: 0 })).toBe('keepNewer')
  })
  it('채택 화면 내용에 이 PC 판·세션 수가 실린다', () => {
    const plan = consentPlan('dev@h:22', parseProbe(linux + 'installed=2.2.9\n'), 100, 64, 6, { app: '2.2.11', sessions: 3 })
    expect(plan).toMatchObject({ app: '2.2.11', sessions: 3, dir: '/home/dev/.ara-server' })
  })
  it('서버 list → 목록 줄: 제목 순서(이름 > 첫 지시 제목 > 실행 제목), 만든 PC, 보는 PC, 이 PC 에 열림, 최근 시작이 위', () => {
    const rows = serverRowsOf(
      'dev@h:22',
      [
        { id: 'a', cwd: '/w/a', meta: { agent: 'claude', title: 'Claude · a', pc: 'OFFICE', startedAt: 100 }, viewers: ['OFFICE'] },
        { id: 'b', cwd: '/w/b', meta: { agent: 'codex', title: 'Codex · b', genTitle: '쿠폰 반올림', startedAt: 300 }, viewers: [] },
        { id: 'c', cwd: '/w/c', meta: { title: 'x', genTitle: 'g', name: '정산 CSV', startedAt: 200 } }
      ],
      (id) => id === 'a'
    )
    expect(rows.map((r) => [r.id, r.title])).toEqual([
      ['b', '쿠폰 반올림'],
      ['c', '정산 CSV'],
      ['a', 'Claude · a']
    ])
    expect(rows[2]).toMatchObject({ hostKey: 'dev@h:22', agent: 'claude', pc: 'OFFICE', viewers: ['OFFICE'], here: true })
    expect(rows[0]).toMatchObject({ pc: null, viewers: [], here: false })
    expect(rows[1].viewers).toEqual([]) // 옛 서버(viewers 없음)
  })
  it('orcad 가 R1 요청(detach·meta)과 viewers 사건을 안다', () => {
    expect(ORCAD_PY).toContain("if t == 'detach':")
    expect(ORCAD_PY).toContain("if t == 'meta':")
    expect(ORCAD_PY).toContain("'type': 'viewers'")
  })
})

// 3차 R2 서버에서 상태 판정 — 원격 실행에만 주는 훅 설정(설치 폴더 안), orcad hook 요청·status 사건, 목록 상태 칸.
describe('R2 서버 훅', () => {
  it('훅 설정 = 로컬과 같은 이벤트 목록, 명령은 서버의 orcad.py hook <cli>($HOME — 따옴표 안에서도 펴진다)', () => {
    expect(remoteHookCommand('claude')).toBe('python3 "$HOME/.ara-server/orcad.py" hook claude')
    for (const src of ['claude', 'gemini'] as const) {
      const f = JSON.parse(remoteHookFile(src)) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
      expect(Object.keys(f.hooks).sort()).toEqual([...HOOK_TARGETS[src].events].sort())
      for (const defs of Object.values(f.hooks)) expect(defs.map((d) => d.hooks[0].command)).toEqual([remoteHookCommand(src)])
      expect(Object.keys(f)).toEqual(['hooks']) // statusLine 등 다른 것은 싣지 않는다
    }
  })
  it('원격 실행 인자: Claude --settings 파일 · Gemini 시스템 기본값 env · 옛 서버(hookDir 없음)·Codex 는 없음', () => {
    expect(remoteHookLaunch('claude', '/home/dev/.ara-server')).toEqual({ extraArgs: ['--settings', '/home/dev/.ara-server/claude-hooks.json'] })
    expect(remoteHookLaunch('gemini', '/home/dev/.ara-server')).toEqual({ extraEnv: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/home/dev/.ara-server/gemini-hooks.json' } })
    expect(remoteHookLaunch('claude', null)).toEqual({})
    expect(remoteHookLaunch('codex', '/home/dev/.ara-server')).toEqual({})
  })
  it('서버 대장의 마지막 상태 → 목록 칸(기존 글리프 이름)', () => {
    expect(serverStateOf({ source: 'claude', payload: { hook_event_name: 'UserPromptSubmit' }, at: 1 })).toBe('working')
    expect(serverStateOf({ source: 'claude', payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, at: 1 })).toBe('blocked')
    expect(serverStateOf({ source: 'claude', payload: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, at: 1 })).toBe('question')
    expect(serverStateOf({ source: 'claude', payload: { hook_event_name: 'Stop' }, at: 1 })).toBe('idle')
    expect(serverStateOf({ source: 'gemini', payload: { hook_event_name: 'BeforeAgent' }, at: 1 })).toBe('working')
    expect(serverStateOf(undefined)).toBeNull()
    expect(serverStateOf({ source: 'codex', payload: { hook_event_name: 'Stop' } })).toBeNull()
    expect(serverStateOf({ source: 'claude', payload: { hook_event_name: 'Notification' } })).toBeNull()
    const rows = serverRowsOf('dev@h:22', [{ id: 'a', cwd: '/x', meta: {}, status: { source: 'claude', payload: { hook_event_name: 'Stop' }, at: 1 } }, { id: 'b', cwd: '/x', meta: {} }], () => false)
    expect(rows.map((r) => r.state)).toEqual(['idle', null])
  })
  it('orcad 가 hook 요청·status 사건·hello hookDir·세션 env 를 안다', () => {
    expect(ORCAD_PY).toContain("if t == 'hook':")
    expect(ORCAD_PY).toContain("'type': 'status'")
    expect(ORCAD_PY).toContain("reply['hookDir'] = DIR")
    expect(ORCAD_PY).toContain('env[SESSION_ENV] = self.id')
    expect(ORCAD_PY).toContain("elif cmd == 'hook':")
  })
})

describe('R3 서버 계정', () => {
  it('orcad 의 공유 목록 = 로컬 계정의 CLAUDE_HISTORY(R0 와 같은 목록)', () => {
    const m = ORCAD_PY.match(/^CLAUDE_HISTORY = \(([^)]*)\)/m)
    expect(m).not.toBeNull()
    expect(m![1].split(',').map((x) => x.trim().replace(/'/g, ''))).toEqual([...CLAUDE_HISTORY])
  })
  it('서버 훅은 session_id(다른 계정으로 이어서)·error(한도)를 넘긴다', () => {
    expect(ORCAD_PY).toMatch(/HOOK_KEYS = \([^)]*'session_id'[^)]*'error'\)/)
  })
  it('제거 검증이 계정 폴더·자격 증명 파일을 센다', () => {
    expect(VERIFY_SCRIPT).toContain('echo accounts=')
    expect(VERIFY_SCRIPT).toContain('-name .credentials.json -o -name auth.json')
  })
  it('목록 읽기 — 모르는 모양은 거르고, 없는 기본은 null', () => {
    const v = serverAccountsOf({
      accounts: [
        { id: 'a1', agent: 'claude', label: '업무 A', loggedIn: true, email: 'a@x', createdAt: 1 },
        { id: 'a2', agent: 'gemini', label: '?' },
        { id: 'a3', agent: 'codex', label: '' },
        'x'
      ],
      default: 'zz'
    })
    expect(v).toEqual({
      accounts: [
        { id: 'a1', agent: 'claude', label: '업무 A', loggedIn: true, email: 'a@x', createdAt: 1 },
        { id: 'a3', agent: 'codex', label: 'a3', loggedIn: false, email: null, createdAt: null }
      ],
      default: null
    })
    expect(serverAccountsOf(null)).toEqual({ accounts: [], default: null })
  })
  it('실패는 이유 + 할 일 한 줄(옛 서버·쓰는 중·없음), 모르는 것은 그대로', () => {
    expect(accountErrorText('unknown request')).toMatch(/옛 판.*—/)
    expect(accountErrorText('account in use')).toMatch(/끝낸 뒤/)
    expect(accountErrorText('no such account')).toMatch(/새로 고쳐/)
    expect(accountErrorText('boom')).toBe('boom')
  })
  it('로그인 줄은 끝나면 셸도 닫는다 · 로그인 칸은 서버 세션 목록에 안 나온다', () => {
    expect(accountLoginLine('claude')).toBe('claude auth login; exit')
    expect(accountLoginLine('codex')).toBe('codex login --device-auth; exit')
    const rows = serverRowsOf('h', [{ id: 'l', cwd: '/', meta: { kind: 'login', title: 'B' } }, { id: 'x', cwd: '/', meta: { agent: 'claude', title: 't' } }], () => false)
    expect(rows.map((r) => r.id)).toEqual(['x'])
  })
})
