// #123 아라 엔진 — **화면이 받는 사건**과 **상주 프로세스의 수명**.
//
// 이 파일은 사람의 Claude 한도를 한 번도 쓰지 않는다: 파서는 순수 함수고, 프로세스는 가짜다.
// 진짜 CLI 와의 왕복은 opt-in 실증 테스트가 따로 본다(tests/claudeMcpBridge.exp.test.ts).
import { describe, it, expect, vi } from 'vitest'
import {
  buildClaudeArgs,
  interruptLine,
  parseStreamJson,
  permissionReplyLine,
  toolBrief,
  userMessageLine,
  type AiEngineEvent
} from '../src/shared/aiEngine'
import { cmdExeArgs, createClaudeEngine, encodeWinArg, type EngineProc } from '../src/main/ai/engine/ClaudeCliEngine'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 파서 ─────────────────────────────────────────────────────────────────────

describe('stream-json 파싱', () => {
  it('init 줄에서 세션 id·모델·폴더를 집는다 — 재개하려면 이 id 가 필요하다', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
      model: 'claude-opus-5',
      cwd: 'D:\\AI\\OFA',
      tools: ['Bash', 'Read']
    })
    expect(parseStreamJson(line)).toEqual([
      { t: 'ready', sessionId: 'abc-123', model: 'claude-opus-5', cwd: 'D:\\AI\\OFA', tools: ['Bash', 'Read'] }
    ])
  })

  it('어시스턴트 한 줄에 글과 도구 호출이 함께 실려 온다', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '먼저 파일을 보겠습니다.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/srv/app/server.js' } }
        ]
      }
    })
    expect(parseStreamJson(line)).toEqual([
      { t: 'text', text: '먼저 파일을 보겠습니다.' },
      { t: 'tool', id: 'tu_1', name: 'Read', brief: '/srv/app/server.js' }
    ])
  })

  it('★ 도구 결과는 user 메시지에 실려 돌아온다 — 실패도 구분한다', () => {
    const ok = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'total 72\ndrwx---' }] }
    })
    const bad = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: [{ type: 'text', text: 'permission denied' }] }] }
    })
    expect(parseStreamJson(ok)).toEqual([{ t: 'toolResult', id: 'tu_1', ok: true, brief: 'total 72 drwx---' }])
    expect(parseStreamJson(bad)).toEqual([{ t: 'toolResult', id: 'tu_2', ok: false, brief: 'permission denied' }])
  })

  it('result 줄에서 비용·시간·턴 수를 집는다', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0123,
      duration_ms: 21000,
      num_turns: 3,
      result: '끝났습니다'
    })
    expect(parseStreamJson(line)).toEqual([{ t: 'turn', costUsd: 0.0123, ms: 21000, turns: 3, text: '끝났습니다' }])
  })

  it('★ 모르는 줄은 조용히 흘린다 — CLI 가 새 이벤트를 더한 날 대화창이 죽으면 안 된다', () => {
    expect(parseStreamJson('{"type":"stream_event","event":{"x":1}}')).toEqual([])
    expect(parseStreamJson('{"type":"system","subtype":"compact_boundary"}')).toEqual([])
    expect(parseStreamJson('그냥 글자')).toEqual([])
    expect(parseStreamJson('{깨진 json')).toEqual([])
    expect(parseStreamJson('')).toEqual([])
  })

  it('권한 요청은 사건으로 올라온다(답은 사람이 한다 — #124)', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req_9',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } }
    })
    expect(parseStreamJson(line)).toEqual([{ t: 'permission', requestId: 'req_9', tool: 'Bash', brief: 'rm -rf build' }])
  })
})

describe('도구 한 줄 요약', () => {
  it('도구마다 제일 중요한 인자를 집는다', () => {
    expect(toolBrief('Bash', { command: 'npm test', description: '테스트' })).toBe('npm test')
    expect(toolBrief('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts')
    expect(toolBrief('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev')
  })

  it('모르는 도구도 빈손으로 두지 않는다 · 긴 값은 자른다', () => {
    expect(toolBrief('mcp__ara__session_input', { text: '안녕' })).toBe('안녕')
    expect(toolBrief('mcp__ara__session_list', {})).toBe('')
    expect(toolBrief('Bash', { command: 'x'.repeat(300) }).endsWith('…')).toBe(true)
  })
})

// ── 명령줄 ───────────────────────────────────────────────────────────────────

describe('명령줄 조립', () => {
  it('★ 사람이 친 글자는 argv 에 한 자도 없다 — 질문은 stdin 으로만 간다', () => {
    const args = buildClaudeArgs({ mcpConfigPath: 'C:\\tmp\\ara.json' })
    expect(args.join(' ')).toContain('--input-format stream-json')
    expect(args.join(' ')).toContain('--output-format stream-json')
    // stream-json 출력은 --verbose 를 요구한다(없으면 CLI 가 거절한다).
    expect(args).toContain('--verbose')
    expect(args).toContain('-p')
  })

  it('★ Claude Code 기본 기능을 끄지 않는다 — --bare 도, 도구 제한도 없다(설계 §3.2)', () => {
    const args = buildClaudeArgs()
    expect(args).not.toContain('--bare')
    expect(args).not.toContain('--dangerously-skip-permissions')
    // 우리 도구만 미리 통과시킨다(아라 승인 게이트가 이미 지킨다 — 두 번 묻지 않는다).
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__ara__*')
  })

  it('재개가 있으면 --resume, 없으면 새 세션 id 를 준다(둘 다 붙이지 않는다)', () => {
    expect(buildClaudeArgs({ resumeId: 's1', sessionId: 's2' })).toContain('--resume')
    expect(buildClaudeArgs({ resumeId: 's1', sessionId: 's2' })).not.toContain('--session-id')
    expect(buildClaudeArgs({ sessionId: 's2' })).toContain('--session-id')
  })

})

// ── 윈도우 명령줄(#152) ──────────────────────────────────────────────────────
// `.cmd` 셔임은 cmd.exe 를 지나야 뜨고, 그러면 **한 줄을 파서 둘이 읽는다**(cmd → CommandLineToArgvW).
// 옛 인코딩(`\"`)은 CRT 만 만족시켜서 cmd 의 따옴표 짝을 뒤집었고, 그 뒤의 `&` 가 인자를 잘랐다.

describe('윈도우 인자 인코딩', () => {
  it('★ 내장 따옴표는 `""`, `%` 는 인용 밖 `"^%"` — cmd 와 CRT 를 동시에 만족시킨다', () => {
    expect(encodeWinArg('--verbose')).toBe('"--verbose"')
    expect(encodeWinArg('C:\\my tmp\\ara.json')).toBe('"C:\\my tmp\\ara.json"')
    // `\"` 를 쓰면 cmd 가 따옴표를 하나 더 세고, 그때부터 짝이 뒤집힌다.
    expect(encodeWinArg('c"d')).toBe('"c""d"')
    // 캐럿은 인용 안에서 이스케이프가 아니라 글자다 — `%` 만 인용 밖으로 낸다.
    expect(encodeWinArg('e%F%g')).toBe('"e"^%"F"^%"g"')
    // 닫는 따옴표 앞 백슬래시는 두 배로(안 그러면 그 백슬래시가 따옴표를 먹는다).
    expect(encodeWinArg('C:\\tmp\\')).toBe('"C:\\tmp\\\\"')
    expect(encodeWinArg('C:\\U\\%N%\\')).toBe('"C:\\U\\\\"^%"N"^%"\\\\"')
    expect(encodeWinArg('')).toBe('""')
  })

  it('★ CR/LF·NUL 은 인코딩하지 않고 거부한다 — cmd 는 개행에서 명령을 끝낸다(이스케이프가 없다)', () => {
    for (const bad of ['질문\n두 줄', 'a\r\nb', 'a\0b']) expect(() => encodeWinArg(bad), bad).toThrow()
    // 셸 메타문자는 거부가 아니라 통과다 — 윈도우 계정 이름에 들어갈 수 있는 글자다.
    expect(() => encodeWinArg('C:\\Users\\R&D\\ara.json')).not.toThrow()
  })

  it('cmd 플래그를 우리가 고른다 — /d AutoRun 무시 · /v:off 지연확장 · /s 한 겹만 벗김', () => {
    expect(cmdExeArgs('claude', ['-p'])).toEqual(['/d', '/v:off', '/s', '/c', '"claude "-p""'])
    // ★ 실행 파일 이름은 인용하지 않는다 — 인용하면 셔임의 `%~dp0` 가 현재 폴더로 펴져
    //    `claude.exe` 를 못 찾는다(2026-08-30 실측). 위험한 글자가 있을 때만 인코딩한다.
    expect(cmdExeArgs('C:\\bin\\claude.cmd', [])[4]).toBe('"C:\\bin\\claude.cmd"')
    expect(cmdExeArgs('C:\\my bin\\claude.cmd', [])[4]).toBe('""C:\\my bin\\claude.cmd""')
  })

  // 문자열 비교로는 못 잡는다 — 두 파서를 다 지나 봐야 안다(후보 인코딩 하나가 여기서 떨어졌다).
  it.skipIf(process.platform !== 'win32')('★ 진짜 .cmd 셔임을 지나도 인자가 그대로 도착한다(실측)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ara-cmdline-'))
    try {
      writeFileSync(join(dir, 'printargs.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
      // npm 셔임과 같은 자리: `%*` 를 배치가 한 번 더 파싱한다.
      writeFileSync(join(dir, 'shim.cmd'), '@ECHO off\r\nnode "%~dp0printargs.js" %*\r\n')
      const vector = ['a b', 'c"d', 'e%F%g', 'h&i', 'j^k', 'C:\\U\\%ARA_TEST_VAR%\\ara.json', 'C:\\tmp\\']
      const r = spawnSync(process.env.ComSpec || 'cmd.exe', cmdExeArgs(join(dir, 'shim.cmd'), vector), {
        // 셔임 폴더가 아닌 곳에서 띄운다 — 실행 파일 이름을 인용하면 `%~dp0` 가 여기로 펴져
        // printargs.js 를 못 찾는다(셔임이 자기 옆의 파일을 찾는 그 자리다).
        cwd: process.cwd(),
        windowsVerbatimArguments: true,
        encoding: 'utf8',
        env: { ...process.env, ARA_TEST_VAR: 'EXPANDED' }
      })
      // 옛 코드에서는 `&` 가 인자를 자르고 `i" "jk"` 를 명령으로 실행했다(2026-08-30 실측).
      expect(JSON.parse(r.stdout || 'null')).toEqual(vector)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 인코더가 맞아도 **프로세스가 안 뜨면** 소용없다 — 여기만 realSpawn 을 진짜로 지난다
  // (다른 검사는 전부 spawnProc 를 끼워 넣는다).
  it.skipIf(process.platform !== 'win32')('★ 셔임으로 띄운 엔진이 실제로 붙는다 — 플래그가 그대로 도착한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ara-engine-'))
    try {
      // 받은 argv 를 tools 로 되돌려 주는 가짜 CLI. 진짜 CLI 는 한 줄도 부르지 않는다.
      writeFileSync(
        join(dir, 'fake-cli.js'),
        'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: process.argv.slice(2) }))\n'
      )
      writeFileSync(join(dir, 'shim.cmd'), '@ECHO off\r\nnode "%~dp0fake-cli.js" %*\r\n')
      const seen: AiEngineEvent[] = []
      // 공백·`&`·`%` 를 한꺼번에 — 윈도우 계정 이름에 실제로 들어갈 수 있는 모양이다.
      const cfg = 'C:\\my tmp\\R&D %ARA_TEST_VAR%\\ara.json'
      const e = createClaudeEngine({ cwd: process.cwd(), bin: join(dir, 'shim.cmd'), mcpConfigPath: cfg })
      await new Promise<void>((done) => {
        e.onEvent((ev) => {
          seen.push(ev)
          if (ev.t === 'exit') done()
        })
      })
      e.dispose()
      const ready = seen.find((x) => x.t === 'ready')
      expect(ready?.t === 'ready' && ready.sessionId).toBe('s1')
      // 우리가 만든 플래그가 한 자도 안 바뀌고 도착했다.
      expect(ready?.t === 'ready' && ready.tools).toEqual(buildClaudeArgs({ mcpConfigPath: cfg }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('stdin 으로 보내는 줄', () => {
  it('질문은 stream-json 사용자 메시지 한 줄이다(개행으로 끝난다)', () => {
    const line = userMessageLine('한글도 그대로')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '한글도 그대로' }] }
    })
  })

  it('중지·권한 응답도 한 줄짜리 control 메시지다', () => {
    expect(JSON.parse(interruptLine('r1')).request.subtype).toBe('interrupt')
    expect(JSON.parse(permissionReplyLine('r2', true)).response.response.behavior).toBe('allow')
    expect(JSON.parse(permissionReplyLine('r2', false)).response.response.behavior).toBe('deny')
  })
})

// ── 프로세스 수명 ────────────────────────────────────────────────────────────

function fakeProc(): EngineProc & {
  emitOut(s: string): void
  emitErr(s: string): void
  exit(code: number | null): void
  fail(msg: string): void
  written: string[]
  killed: number
} {
  const h: Record<string, ((a?: unknown) => void)[]> = {}
  const outs: ((c: Buffer | string) => void)[] = []
  const errs: ((c: Buffer | string) => void)[] = []
  const written: string[] = []
  const self = {
    stdout: { on: (_e: 'data', fn: (c: Buffer | string) => void) => outs.push(fn) },
    stderr: { on: (_e: 'data', fn: (c: Buffer | string) => void) => errs.push(fn) },
    stdin: { write: (s: string) => written.push(s), end: () => written.push('<END>') },
    kill: () => (self.killed += 1),
    on: (e: 'exit' | 'error', fn: (a?: unknown) => void) => void (h[e] = [...(h[e] ?? []), fn]),
    emitOut: (s: string) => outs.forEach((f) => f(s)),
    emitErr: (s: string) => errs.forEach((f) => f(s)),
    exit: (code: number | null) => (h.exit ?? []).forEach((f) => f(code)),
    fail: (msg: string) => (h.error ?? []).forEach((f) => f({ message: msg })),
    written,
    killed: 0
  }
  return self as unknown as ReturnType<typeof fakeProc>
}

const engineWith = (p: EngineProc) => {
  const seen: AiEngineEvent[] = []
  const e = createClaudeEngine({ cwd: 'D:\\AI\\OFA', spawnProc: () => p })
  e.onEvent((ev) => seen.push(ev))
  return { e, seen }
}

describe('상주 프로세스', () => {
  it('★ 조각으로 오는 stdout 을 개행에서만 자른다 — 반쪽 JSON 을 파싱하지 않는다', () => {
    const p = fakeProc()
    const { seen } = engineWith(p)
    p.emitOut('{"type":"system","subtype":"init","session_id":"s1"')
    expect(seen).toEqual([]) // 아직 줄이 안 끝났다
    p.emitOut(',"model":"m","cwd":"c"}\n')
    expect(seen).toEqual([{ t: 'ready', sessionId: 's1', model: 'm', cwd: 'c', tools: [] }])
  })

  it('한 번에 여러 줄이 와도 순서대로 낸다', () => {
    const p = fakeProc()
    const { seen } = engineWith(p)
    p.emitOut(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ㄱ' }] } }) +
        '\n' +
        JSON.stringify({ type: 'result', total_cost_usd: 1, duration_ms: 2, num_turns: 1, result: 'ㄴ' }) +
        '\n'
    )
    expect(seen.map((e) => e.t)).toEqual(['text', 'turn'])
  })

  it('질문은 stdin 으로 나간다(명령줄이 아니다)', () => {
    const p = fakeProc()
    const { e } = engineWith(p)
    e.send('서버 목록 알려 줘')
    expect(JSON.parse(p.written[0]).message.content[0].text).toBe('서버 목록 알려 줘')
  })

  it('★ 죽으면 그대로 알린다 — 조용히 되살리지 않는다(같은 질문이 두 번 청구된다)', () => {
    const p = fakeProc()
    const { seen } = engineWith(p)
    p.emitErr('Error: ENOENT claude')
    p.exit(1)
    expect(seen.map((e) => e.t)).toEqual(['error', 'exit'])
    expect(seen[0]).toMatchObject({ message: 'Error: ENOENT claude' })
  })

  it('정상 종료(0)에는 오류를 지어내지 않는다', () => {
    const p = fakeProc()
    const { seen } = engineWith(p)
    p.exit(0)
    expect(seen).toEqual([{ t: 'exit', code: 0 }])
  })

  it('실행 자체가 안 되면(claude 없음) 오류와 종료가 함께 온다', () => {
    const p = fakeProc()
    const { seen } = engineWith(p)
    p.fail('spawn claude ENOENT')
    expect(seen).toEqual([
      { t: 'error', message: 'spawn claude ENOENT' },
      { t: 'exit', code: null }
    ])
  })

  it('★ 중지는 control 요청을 먼저 보내고, 안 들으면 내린다', () => {
    vi.useFakeTimers()
    const p = fakeProc()
    const { e } = engineWith(p)
    e.interrupt()
    expect(JSON.parse(p.written[0]).request.subtype).toBe('interrupt')
    expect(p.killed).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(p.killed).toBe(1)
    vi.useRealTimers()
  })

  it('★ dispose 는 stdin 을 닫고 프로세스를 내린다 — 고아를 남기지 않는다', () => {
    const p = fakeProc()
    const { e, seen } = engineWith(p)
    e.dispose()
    expect(p.written).toContain('<END>')
    expect(p.killed).toBe(1)
    // 내린 뒤에는 아무것도 흘리지 않는다(구독자도 지웠다).
    p.emitOut('{"type":"result","num_turns":1}\n')
    expect(seen).toEqual([])
  })

  it('죽은 뒤에 보낸 것은 조용히 버린다(예외를 던지지 않는다)', () => {
    const p = fakeProc()
    const { e } = engineWith(p)
    p.exit(1)
    const before = p.written.length
    expect(() => e.send('늦은 질문')).not.toThrow()
    expect(p.written.length).toBe(before)
  })
})
