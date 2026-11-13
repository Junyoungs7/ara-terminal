// 2.2.24 계정 추가·전환(준영님 2026-11-13) — 가짜 CLI(run 주입)·임시 userData 로만. 실제 claude·브라우저·~/.claude 를 쓰지 않는다.
// ① 로그인: 브라우저가 코드를 보여 주는 길(CLI 'Paste code here if prompted')에 코드를 stdin 으로 넣을 수 있다 · 자격 파일이 생기면 CLI 가
//    늦게 끝나도 등록 완료 · [로그인 화면 다시 열기] = 같은 login() 안에서 CLI 새로 · 취소 · Windows 는 트리째 끝낸다.
// ② 전환: 탭 계정 ≠ 고른 계정이면 movedOf 가 안내 재료를 준다(예전엔 한도 띠마저 사라졌다).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountsFeature } from '../src/main/usage/accounts'
import type { RunOptions, RunResult } from '../src/main/util/runProcess'
import { movedOf } from '../src/renderer/features/aiws/accountRestart'
import type { AgentTab } from '../src/renderer/features/aiws/agentStore'
import type { UsageState } from '../src/shared/usage'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ara-acct-login-'))
const OK: RunResult = { code: 0, stdout: '', stderr: '', error: null }
const FAIL = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr, error: new Error('Command failed: cmd /d /c claude auth login --claudeai') })
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Call = { file: string; args: readonly string[]; opts?: RunOptions }
/** 가짜 CLI — 시도마다 behave(n, 그 시도의 손잡이)를 부른다. 끝내기는 signal(리눅스)·taskkill(Windows). */
function setup(platform: NodeJS.Platform, behave: (n: number, h: { dir: string; cred: () => void; end: (r: RunResult) => void; stdin: string[] }) => void) {
  const calls: Call[] = []
  const stdins: string[][] = []
  const ends: ((r: RunResult) => void)[] = []
  let n = 0
  const acc = createAccountsFeature({
    userData: tmp(),
    defaultDir: () => tmp(),
    platform,
    loginTiming: { pollMs: 5, graceMs: 30 },
    run: (file, args, opts) => {
      calls.push({ file, args, opts })
      if (file === 'taskkill') {
        ends[Number(args[1]) - 1000]?.(FAIL('killed'))
        return Promise.resolve(OK)
      }
      return new Promise<RunResult>((resolve) => {
        const i = n++
        const stdin: string[] = []
        stdins.push(stdin)
        ends[i] = resolve
        const dir = opts!.env!['CLAUDE_CONFIG_DIR']
        opts?.signal?.addEventListener('abort', () => resolve(FAIL('aborted')))
        opts?.onSpawn?.({ pid: 1000 + i, write: (s) => void stdin.push(s) })
        behave(i, { dir, cred: () => writeFileSync(join(dir, '.credentials.json'), '{}'), end: resolve, stdin })
      })
    }
  })
  const id = acc.add('claude', 'a')
  return { acc, id, calls, stdins, logins: () => calls.filter((c) => c.file !== 'taskkill') }
}

describe('계정 로그인(가짜 CLI)', () => {
  it('브라우저가 코드를 보여 주는 길: 붙여 넣은 코드가 CLI stdin 으로 한 줄 — 그걸로 자격이 생기면 등록', async () => {
    const s = setup('win32', (_n, h) => {
      // 진짜 CLI 처럼 stdin 의 'code#state' 줄을 기다린다.
      const wait = setInterval(() => {
        if (h.stdin.join('').includes('abc#st\n')) {
          clearInterval(wait)
          h.cred()
          h.end(OK)
        }
      }, 2)
    })
    const p = s.acc.login('claude', s.id)
    await tick()
    expect(s.acc.loginCtl('claude', s.id, { op: 'code', code: ' abc#st\r\n' })).toBe(true)
    expect(await p).toEqual({ ok: true })
    expect(s.stdins[0]).toEqual(['abc#st\n'])
    expect(s.logins()[0].args).toEqual(['/d', '/c', 'claude', 'auth', 'login', '--claudeai'])
    expect(s.acc.loginCtl('claude', s.id, { op: 'code', code: 'x' })).toBe(false) // 끝난 로그인엔 없다
  })

  it('자격 파일이 생겼는데 CLI 가 안 끝난다 → 기다리지 않고 등록, 남은 CLI 는 트리째(taskkill /t) 끝낸다', async () => {
    const s = setup('win32', (_n, h) => h.cred())
    expect(await s.acc.login('claude', s.id)).toEqual({ ok: true })
    expect(s.calls.find((c) => c.file === 'taskkill')?.args).toEqual(['/pid', '1000', '/t', '/f'])
  })

  it('[로그인 화면 다시 열기]: 옛 CLI 를 끝내고 같은 login() 안에서 새로 — 두 번째가 자격을 쓰면 등록', async () => {
    const s = setup('linux', (n, h) => n === 1 && h.cred())
    const p = s.acc.login('claude', s.id)
    await tick()
    expect(s.acc.loginCtl('claude', s.id, { op: 'retry' })).toBe(true)
    expect(await p).toEqual({ ok: true })
    expect(s.logins()).toHaveLength(2)
    expect(s.logins()[0].opts?.signal?.aborted).toBe(true)
  })

  it('취소 · 같은 계정을 다시 누르면 옛 로그인은 끝난다 · 실패는 CLI 가 말한 줄로', async () => {
    const s = setup('linux', (n, h) => n === 2 && h.end(FAIL('\nLogin failed: Invalid state parameter\n')))
    const first = s.acc.login('claude', s.id)
    await tick()
    const second = s.acc.login('claude', s.id) // 설정을 나갔다 와서 다시 누름
    expect(await first).toEqual({ ok: false, error: '로그인을 취소했습니다' })
    await tick()
    expect(s.acc.loginCtl('claude', s.id, { op: 'cancel' })).toBe(true)
    expect(await second).toEqual({ ok: false, error: '로그인을 취소했습니다' })
    expect(await s.acc.login('claude', s.id)).toEqual({ ok: false, error: 'Login failed: Invalid state parameter' })
  })
})

// 실제 프로세스 순서(아라 → cmd /d /c → claude.cmd → node): stdin 이 손자까지 이어지는지, 끝낼 때 손자까지 죽는지. 가짜 claude 는 임시 폴더에만.
describe.runIf(process.platform === 'win32')('계정 로그인(실제 cmd → 가짜 claude 프로세스)', () => {
  const FAKE = String.raw`
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = process.env.CLAUDE_CONFIG_DIR
writeFileSync(join(dir, 'pid'), String(process.pid))
process.stdout.write('Opening browser to sign in…\nIf the browser didn\'t open, visit: https://example.invalid/oauth\nPaste code here if prompted > ')
if (process.argv[2] === 'hang') { writeFileSync(join(dir, '.credentials.json'), '{}'); setInterval(() => {}, 1000) }
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const [code, state] = l.trim().split('#')
  if (!code || !state) return process.stderr.write('Invalid code. Please make sure the full code was copied.\n')
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ got: l.trim() }))
  process.stdout.write('Login successful.\n')
  process.exit(0)
})
`
  const withFake = async (mode: string, body: (acc: ReturnType<typeof createAccountsFeature>, id: string, dir: string) => Promise<void>): Promise<void> => {
    const bin = tmp()
    writeFileSync(join(bin, 'fake.cjs'), FAKE)
    writeFileSync(join(bin, 'claude.cmd'), ['@echo off', `node "${join(bin, 'fake.cjs')}" ${mode}`, ''].join('\r\n'))
    const saved = process.env.PATH
    process.env.PATH = bin + ';' + saved
    try {
      const acc = createAccountsFeature({ userData: tmp(), defaultDir: () => tmp(), loginTiming: { pollMs: 50, graceMs: 300 } })
      const id = acc.add('claude', 'a')
      await body(acc, id, acc.dir('claude', id)!)
    } finally {
      process.env.PATH = saved
    }
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const pidOf = async (dir: string): Promise<number> => {
    for (let i = 0; i < 200; i++) {
      try {
        return Number(readFileSync(join(dir, 'pid'), 'utf8'))
      } catch {
        await tick(50)
      }
    }
    throw new Error('가짜 claude 가 안 떴다')
  }

  it('붙여 넣은 코드가 cmd 를 지나 claude 의 stdin 에 닿고, 그걸로 등록된다', async () => {
    await withFake('paste', async (acc, id, dir) => {
      const p = acc.login('claude', id)
      await pidOf(dir)
      expect(acc.loginCtl('claude', id, { op: 'code', code: 'abc#st' })).toBe(true)
      expect(await p).toEqual({ ok: true })
      expect(JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'))).toEqual({ got: 'abc#st' })
    })
  }, 30_000)

  it('자격을 쓰고 안 끝나는 claude: 등록하고 손자 프로세스까지 끝낸다 · 취소도 손자까지', async () => {
    await withFake('hang', async (acc, id, dir) => {
      expect(await acc.login('claude', id)).toEqual({ ok: true })
      const pid = await pidOf(dir)
      await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    })
    await withFake('paste', async (acc, id, dir) => {
      const p = acc.login('claude', id)
      const pid = await pidOf(dir)
      expect(alive(pid)).toBe(true)
      acc.loginCtl('claude', id, { op: 'cancel' })
      expect(await p).toEqual({ ok: false, error: '로그인을 취소했습니다' })
      await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    })
  }, 60_000)
})

describe('설정에서 계정을 바꾼 뒤의 탭(movedOf)', () => {
  const u = (active: string | null) =>
    ({ accounts: { claude: { active, list: [{ id: 'A', label: '업무 A' }, { id: 'B', label: '업무 B' }] }, codex: { active: null, list: [] } } }) as unknown as UsageState
  const tab = (p: Partial<AgentTab>): AgentTab => ({ sessionId: 's1', agent: 'claude', worktreeId: 'w', title: 't', line: '', exited: false, ...p })
  it('탭 계정 ≠ 고른 계정이면 {from, to}, 같거나 모르면(옛 탭)·원격·끝난 탭은 null', () => {
    expect(movedOf(u('B'), tab({ account: 'A' }))).toEqual({ from: '업무 A', to: { id: 'B', label: '업무 B' } })
    expect(movedOf(u(null), tab({ account: 'A' }))?.to.id).toBeNull()
    expect(movedOf(u('A'), tab({ account: 'A' }))).toBeNull()
    expect(movedOf(u('B'), tab({}))).toBeNull()
    expect(movedOf(u('B'), tab({ account: 'A', host: 'dev@h:22' }))).toBeNull()
    expect(movedOf(u('B'), tab({ account: 'A', exited: true }))).toBeNull()
    expect(movedOf(u('B'), tab({ agent: 'gemini', account: 'A' }))).toBeNull()
  })
})
