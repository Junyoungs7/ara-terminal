// 원격 3차 R4 — 원격 탭 채팅 보기. (1) remoteChat(main): 꼬리 → 오프셋 증분 · 새 파일이면 처음부터 · 옛 orcad 면 그만 묻기.
// (2) orcad read(서버 python): 경로 검사(claude-shared·accounts 아래 .jsonl 만 — 링크를 푼 뒤), 상한·꼬리, 온전한 줄만, 증분, 줄어든 파일.
// (2)는 진짜 Linux python 이 돌려야 한다 — Windows 는 WSL 임시 폴더(managedOrcad.test.ts 와 같은 방식), 없으면 건너뛴다. 실서버에는 붙지 않는다.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRemoteChat } from '../src/main/agents/remoteChat'
import { ORCAD_PY } from '../src/main/managed/orcadScript'
import type { AgentChatEvent, TranscriptSlice } from '@shared/agentChat'

const J = (o: unknown): string => JSON.stringify(o)
const user = (uuid: string, text: string): string => J({ type: 'user', uuid, message: { role: 'user', content: text } })
const asst = (uuid: string, mid: string, content: unknown[]): string => J({ type: 'assistant', uuid, message: { id: mid, role: 'assistant', content } })
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** orcad read 와 같은 규칙의 메모리 파일(온전한 줄만 · offset null/넘침 = 꼬리). */
function fakeServer(): { files: Map<string, string>; calls: (number | null)[]; read: (id: string, path: string, offset: number | null) => Promise<TranscriptSlice>; fail?: string } {
  const s = {
    files: new Map<string, string>(),
    calls: [] as (number | null)[],
    fail: undefined as string | undefined,
    read: async (_id: string, path: string, offset: number | null): Promise<TranscriptSlice> => {
      s.calls.push(offset)
      if (s.fail) throw new Error(s.fail)
      const all = s.files.get(path) ?? ''
      const reset = offset !== null && offset > all.length
      const start = offset === null || reset ? 0 : offset
      const end = all.lastIndexOf('\n') + 1
      return { size: all.length, next: Math.max(start, end), text: end > start ? all.slice(start, end) : '', reset }
    }
  }
  return s
}

describe('remoteChat — 서버 transcript 를 orcad read 로', () => {
  it('훅 경로 → 꼬리 → 증분 · 덜 쓴 줄은 다음에 · 새 파일이면 처음부터', async () => {
    const srv = fakeServer()
    const pushed: AgentChatEvent[] = []
    const rc = createRemoteChat({ read: srv.read, push: (e) => pushed.push(e), pollMs: 20 })
    rc.bind('t1', 'claude')
    expect(rc.has('t1')).toBe(true)
    expect(rc.has('local')).toBe(false)

    // 훅 전에 열면 빈 화면(경로를 모른다) — 묻지도 않는다.
    expect(await rc.open('t1')).toEqual({ messages: [], file: null })
    expect(srv.calls).toEqual([])

    const p = '/h/.ara-server/claude-shared/projects/-repo/s1.jsonl'
    srv.files.set(p, user('u1', '로그인 고쳐 줘') + '\n' + asst('a1', 'm1', [{ type: 'thinking', thinking: '살펴본다' }, { type: 'text', text: '봅니다' }]) + '\n')
    rc.hook('t1', { hook_event_name: 'UserPromptSubmit', transcript_path: p })
    await tick(5)
    expect(pushed).toHaveLength(1)
    expect(pushed[0].reset).toBe(true)
    expect(pushed[0].messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(pushed[0].messages[1].blocks.map((b) => b.type)).toEqual(['thinking', 'text'])

    // 덜 쓴 줄(줄바꿈 전)은 안 온다 → 끝나면 그 줄만.
    const before = srv.files.get(p)!.length
    srv.files.set(p, srv.files.get(p)! + asst('a2', 'm2', [{ type: 'text', text: '고쳤' }]).slice(0, 20))
    await tick(60)
    expect(pushed).toHaveLength(1)
    srv.files.set(p, srv.files.get(p)!.slice(0, before) + asst('a2', 'm2', [{ type: 'text', text: '고쳤습니다' }]) + '\n')
    await tick(60)
    expect(pushed).toHaveLength(2)
    expect(pushed[1].reset).toBeUndefined()
    expect(pushed[1].messages).toHaveLength(1)
    expect(pushed[1].messages[0].blocks).toEqual([{ type: 'text', text: '고쳤습니다' }])
    // 증분: 처음 null(꼬리) 뒤로는 바이트 위치.
    expect(srv.calls[0]).toBeNull()
    expect(srv.calls.slice(1).every((x) => typeof x === 'number')).toBe(true)

    // /clear — 새 파일: 처음부터, 화면 통째로.
    const p2 = p.replace('s1', 's2')
    srv.files.set(p2, user('u9', '새 일') + '\n')
    rc.hook('t1', { hook_event_name: 'SessionStart', transcript_path: p2 })
    await tick(5)
    const last = pushed[pushed.length - 1]
    expect(last.reset).toBe(true)
    expect(last.messages.map((m) => m.blocks)).toEqual([[{ type: 'text', text: '새 일' }]])

    // 닫으면 더 묻지 않는다. 다시 열면 기억한 경로의 꼬리.
    rc.close('t1')
    const n = srv.calls.length
    await tick(60)
    expect(srv.calls.length).toBe(n)
    expect((await rc.open('t1')).file).toBe(p2)
    rc.forget('t1')
    expect(rc.has('t1')).toBe(false)
  })

  it('옛 orcad(read 모름)면 그 화면은 그만 묻는다 · 끊김은 다시 묻는다', async () => {
    const srv = fakeServer()
    const rc = createRemoteChat({ read: srv.read, push: () => {}, pollMs: 20 })
    rc.bind('a', 'claude')
    rc.bind('b', 'claude')
    rc.hook('a', { transcript_path: '/x/a.jsonl' })
    rc.hook('b', { transcript_path: '/x/b.jsonl' })
    srv.fail = 'unknown request'
    await rc.open('a')
    await tick(80)
    expect(srv.calls).toHaveLength(1)
    srv.calls.length = 0
    srv.fail = 'not attached'
    await rc.open('b')
    await tick(80)
    expect(srv.calls.length).toBeGreaterThan(1)
    rc.stop()
  })
})

// ── orcad read(서버 python) ──
const DISTRO = process.env['ARA_TEST_WSL_DISTRO'] || 'Ubuntu'
const WIN = process.platform === 'win32'
const py = (args: string[]): ReturnType<typeof spawnSync> => (WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', 'python3', ...args], { windowsHide: true }) : spawnSync('python3', args))
const READY = py(['-c', 'import os; print(1)']).status === 0
const sh = (args: string[]): ReturnType<typeof spawnSync> => (WIN ? spawnSync('wsl.exe', ['-d', DISTRO, '-e', ...args], { windowsHide: true }) : spawnSync(args[0], args.slice(1)))

describe.skipIf(!READY)('orcad read — 경로 검사 · 상한 · 꼬리 · 증분', () => {
  let dir = ''
  beforeAll(() => {
    dir = sh(['mktemp', '-d', '-t', 'ara-read-XXXXXX']).stdout.toString().trim()
    expect(dir).toMatch(/ara-read-/)
    writeFileSync(`${WIN ? `//wsl.localhost/${DISTRO}` : ''}${dir}/orcad.py`, ORCAD_PY)
  })
  afterAll(() => {
    if (dir) sh(['rm', '-rf', dir])
  })

  it('claude-shared·accounts 아래 .jsonl 만 · 링크를 풀어 밖이면 거절 · 큰 파일은 꼬리만 · 온전한 줄만 · 증분 · 줄면 다시', () => {
    // 서버 쪽 준비와 호출을 python 한 번에 — 결과는 JSON 한 줄.
    const script = [
      'import json, os, sys',
      'D = sys.argv[1]',
      'sys.path.insert(0, D)',
      'import orcad',
      'S = orcad.SHARED',
      'os.makedirs(os.path.join(S, "projects", "-repo"))',
      'os.makedirs(os.path.join(orcad.ACCOUNTS, "abcdef012345"))',
      'os.symlink(os.path.join(S, "projects"), os.path.join(orcad.ACCOUNTS, "abcdef012345", "projects"))',
      'os.makedirs(os.path.join(D, "home", ".claude", "projects", "-repo"))',
      'open(os.path.join(D, "home", ".claude", "projects", "-repo", "x.jsonl"), "w").write("{}\\n")',
      'open(os.path.join(D, "secret.jsonl"), "w").write("{\\"secret\\": 1}\\n")',
      'os.symlink(os.path.join(D, "secret.jsonl"), os.path.join(S, "projects", "-repo", "link.jsonl"))',
      'os.makedirs(os.path.join(S, "projects", "-repo", "dir.jsonl"))',
      'big = os.path.join(S, "projects", "-repo", "big.jsonl")',
      'with open(big, "w") as f:',
      '    for i in range(60000):',
      '        f.write(json.dumps({"type": "user", "n": i, "pad": "x" * 80}) + "\\n")',
      'out = {}',
      'def go(k, *a):',
      '    try:',
      '        out[k] = orcad.read_transcript(*a)',
      '    except Exception as e:',
      '        out[k] = {"error": str(e)}',
      'p = os.path.join(S, "projects", "-repo", "s.jsonl")',
      'open(p, "w").write("{\\"a\\": 1}\\n{\\"a\\": 2}\\n{\\"a\\": 3")',
      'go("first", p, None, None)',
      'go("viaAccount", os.path.join(orcad.ACCOUNTS, "abcdef012345", "projects", "-repo", "s.jsonl"), None, None)',
      'open(p, "a").write("}\\n{\\"a\\": 4}\\n")',
      'go("more", p, out["first"]["next"], None)',
      'go("past", p, 10 ** 9, None)',
      'go("big", big, None, None)',
      'go("small", p, None, 12)',
      'go("long", p, 0, 3)',
      'go("dotdot", os.path.join(S, "..", "..", "secret.jsonl"), None, None)',
      'go("userClaude", os.path.join(D, "home", ".claude", "projects", "-repo", "x.jsonl"), None, None)',
      'go("link", os.path.join(S, "projects", "-repo", "link.jsonl"), None, None)',
      'go("relative", "claude-shared/projects/-repo/s.jsonl", None, None)',
      'go("notJsonl", orcad.TOKEN, None, None)',
      'go("dir", os.path.join(S, "projects", "-repo", "dir.jsonl"), None, None)',
      'go("missing", os.path.join(S, "projects", "-repo", "none.jsonl"), None, None)',
      'go("badOffset", p, -1, None)',
      'go("boolOffset", p, True, None)',
      'go("strOffset", p, "5", None)',
      'go("notStr", 5, None, None)',
      // 서버 본래 로그인: 그 세션의 훅이 알려 준 ~/.claude/projects 파일 하나만(HOME 은 임시 폴더로 — 진짜 홈을 안 본다).
      'os.environ["HOME"] = os.path.join(D, "home")',
      'mine = os.path.join(D, "home", ".claude", "projects", "-repo", "x.jsonl")',
      'out["ownOk"] = orcad.own_transcript(mine) == os.path.realpath(mine)',
      'open(os.path.join(D, "home", ".claude", "settings.jsonl"), "w").write("{}\\n")',
      'out["ownRejects"] = [orcad.own_transcript(p) for p in (os.path.join(D, "secret.jsonl"), os.path.join(D, "home", ".claude", "settings.jsonl"), os.path.join(D, "home", ".claude", "projects", "..", "settings.jsonl"), "home/.claude/projects/-repo/x.jsonl", os.path.join(D, "home", ".claude", "projects", "-repo", "dir.json"), 5)]',
      'go("ownRead", mine, None, None, orcad.own_transcript(mine))',
      'go("ownOther", mine, None, None, os.path.realpath(os.path.join(S, "projects", "-repo", "s.jsonl")))',
      'out["bigText"] =len(out["big"].pop("text").encode("utf-8"))',
      'out["bigFirst"] = json.loads(orcad.read_transcript(big, None, None)["text"].split("\\n")[0])["n"]',
      'out["bigReal"] = os.path.getsize(big)',
      'out["READ_MAX"] = orcad.READ_MAX',
      'print(json.dumps(out))'
    ].join('\n')
    const r = py(['-c', script, dir])
    expect(r.stderr.toString()).toBe('')
    const o = JSON.parse(r.stdout.toString()) as Record<string, any>
    // 첫 읽기 = 온전한 줄만(덜 쓴 셋째 줄은 다음에).
    expect(o.first).toEqual({ size: 25, next: 18, text: '{"a": 1}\n{"a": 2}\n', reset: false })
    // 계정 폴더의 링크로 열어도 같은 파일(링크를 푼 뒤 claude-shared 안).
    expect(o.viaAccount.text).toBe(o.first.text)
    // 증분: 이어서 = 새 줄만.
    expect(o.more.text).toBe('{"a": 3}\n{"a": 4}\n')
    expect(o.more.next).toBe(o.more.size)
    // 끝을 넘는 위치(다시 쓴 파일) = 꼬리부터 + reset.
    expect(o.past.reset).toBe(true)
    // 큰 파일 = 꼬리만(상한 이하), 첫 줄은 잘린 줄을 버린 온전한 줄.
    expect(o.bigReal).toBeGreaterThan(5_000_000)
    expect(o.bigText).toBeLessThanOrEqual(o.READ_MAX)
    expect(o.bigText).toBeGreaterThan(o.READ_MAX - 200)
    expect(o.big.next).toBe(o.bigReal)
    expect(o.bigFirst).toBeGreaterThan(40000)
    // 작은 상한 — 꼬리의 온전한 줄만.
    expect(o.small.text).toBe('{"a": 4}\n')
    // 상한보다 긴 줄은 건너뛴다(멈추지 않는다).
    expect(o.long).toEqual({ size: o.more.size, next: 3, text: '', reset: false })
    // 탈출·밖·링크·종류·상대 경로는 모두 거절.
    for (const k of ['dotdot', 'userClaude', 'link', 'relative', 'notJsonl', 'dir', 'notStr']) expect(o[k], k).toEqual({ error: 'path not allowed' })
    for (const k of ['badOffset', 'boolOffset', 'strOffset']) expect(o[k], k).toEqual({ error: 'bad offset' })
    expect(o.missing.error).toMatch(/No such file/)
    // 서버 본래 로그인 — 그 세션이 받은 파일 하나만 열리고, 다른 파일을 받은 세션이면 거절. projects 밖·.. ·상대·종류는 묶지도 않는다.
    expect(o.ownOk).toBe(true)
    expect(o.ownRejects).toEqual([null, null, null, null, null, null])
    expect(o.ownRead.text).toBe('{}\n')
    expect(o.ownOther).toEqual({ error: 'path not allowed' })
  })
})
