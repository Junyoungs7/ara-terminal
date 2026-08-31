import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentHookServer, type AgentHookServerHandle } from '../src/main/agent/AgentHookServer'
import { HOOK_MARK, HOOK_PANE_HEADER, HOOK_TOKEN_HEADER, installClaudeHooks, mergeHooks, tokenInSettings } from '../src/main/agent/claudeHooks'
import { CLAUDE_HOOK_EVENTS, type AgentStatus } from '../src/shared/agentStatus'

// F1a 훅 — 설치(남의 훅을 지키는가)와 수신(인증·매핑·귀속)의 검사.

const dirs: string[] = []
const servers: AgentHookServerHandle[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-hook-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const settingsPath = (home: string): string => join(home, '.claude', 'settings.json')
const readSettings = (home: string): Record<string, never> => JSON.parse(readFileSync(settingsPath(home), 'utf8'))
const writeSettings = (home: string, v: unknown): void => {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(settingsPath(home), typeof v === 'string' ? v : JSON.stringify(v, null, 2), 'utf8')
}

describe('훅 설치 — 병합이지 덮어쓰기가 아니다', () => {
  it('사용자 훅과 다른 설정을 그대로 둔다', () => {
    const home = tmp()
    const mine = { type: 'command' as const, command: 'node my-own-hook.mjs' }
    writeSettings(home, {
      env: { FOO: '1' },
      permissions: { defaultMode: 'auto' },
      hooks: { Stop: [{ hooks: [mine] }], PreCompact: [{ hooks: [mine] }] }
    })

    const { install } = installClaudeHooks(home)
    expect(install.ok).toBe(true)
    const after = readSettings(home) as unknown as {
      env: unknown
      permissions: unknown
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    // 우리와 무관한 키·이벤트는 손대지 않는다.
    expect(after.env).toEqual({ FOO: '1' })
    expect(after.permissions).toEqual({ defaultMode: 'auto' })
    expect(after.hooks.PreCompact).toEqual([{ hooks: [mine] }])
    // 우리가 쓰는 이벤트에서도 사용자 훅은 살아남고, 우리 것이 뒤에 붙는다.
    const stop = after.hooks.Stop!
    expect(stop[0]).toEqual({ hooks: [mine] })
    expect(stop.at(-1)!.hooks[0]!.command).toContain(HOOK_MARK)
    // 표에 있는 이벤트는 전부 심긴다.
    for (const e of CLAUDE_HOOK_EVENTS) expect(JSON.stringify(after.hooks[e])).toContain(HOOK_MARK)
  })

  it('두 번 심어도 늘지 않는다(우리 것만 갈아 끼운다)', () => {
    const home = tmp()
    installClaudeHooks(home)
    const first = readSettings(home)
    installClaudeHooks(home)
    // 토큰까지 그대로 재사용하므로 파일이 **완전히 같다**(매 기동마다 사용자 파일을 흔들지 않는다).
    expect(readSettings(home)).toEqual(first)
  })

  it('심어 둔 토큰을 되찾아 그대로 쓴다', () => {
    const home = tmp()
    const a = installClaudeHooks(home)
    const b = installClaudeHooks(home)
    expect(b.token).toBe(a.token)
    expect(tokenInSettings(readSettings(home))).toBe(a.token)
  })

  it('설정 파일이 없으면 첫 설치다(정상)', () => {
    const home = tmp()
    const { install } = installClaudeHooks(home)
    expect(install).toEqual({ ok: true, path: settingsPath(home) })
  })

  it('깨진 JSON 은 **덮어쓰지 않고** 사유를 말한다', () => {
    const home = tmp()
    writeSettings(home, '{ "hooks": ')
    const { install } = installClaudeHooks(home)
    expect(install.ok).toBe(false)
    expect(install.ok === false && install.reason).toBe('parse')
    // 남의 파일은 한 글자도 안 바뀐다.
    expect(readFileSync(settingsPath(home), 'utf8')).toBe('{ "hooks": ')
  })

  it('모양이 어긋난 값에도 던지지 않는다 — 훅 설치가 부팅을 막으면 안 된다', () => {
    const merged = mergeHooks({ hooks: { Stop: 'nonsense', PreToolUse: [{ hooks: 'nope' }] } }, 'tok')
    expect(merged.hooks!.Stop).toHaveLength(1)
    expect(merged.hooks!.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(merged.hooks!.Stop)).toContain(HOOK_MARK)
  })

  it('우리 훅만 골라 빼고 같은 항목의 사용자 훅은 남긴다', () => {
    const mine = { type: 'command' as const, command: 'echo mine' }
    const ours = { type: 'command' as const, command: `curl ... # ${HOOK_MARK}` }
    const merged = mergeHooks({ hooks: { Stop: [{ hooks: [mine, ours] }] } }, 'tok')
    const stop = merged.hooks!.Stop!
    expect(stop[0]).toEqual({ hooks: [mine] })
    expect(stop).toHaveLength(2)
  })

  it('훅 한 줄은 포트가 없으면 아무 일도 안 하고, 무슨 일이 있어도 exit 0 이다', () => {
    const home = tmp()
    installClaudeHooks(home)
    const cmd = (readSettings(home) as unknown as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
      .Stop!.at(-1)!.hooks[0]!.command
    expect(cmd).toContain('[ -n "$ARA_HOOK_PORT" ]')
    expect(cmd).toContain('exit 0')
    expect(cmd).toContain('127.0.0.1')
    // 이벤트는 URL 에 있다(페이로드를 파싱하지 않는 이유).
    expect(cmd).toContain('/hook/claude/Stop')
  })

  it('#160 종료 훅도 심긴다 — matcher 없이(reason 을 안 가린다)', () => {
    const home = tmp()
    installClaudeHooks(home)
    const hooks = (readSettings(home) as unknown as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> })
      .hooks
    const end = hooks.SessionEnd!.at(-1)!
    expect(end.hooks[0]!.command).toContain('/hook/claude/SessionEnd')
    // `clear`·`logout`·`prompt_input_exit`·`other` 를 전부 받는다 — 매처를 쓰면 크래시(`other`)를 놓친다.
    expect(end.matcher).toBeUndefined()
  })
})

// ── 수신 서버 ────────────────────────────────────────────────────────────────

async function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body = '{}'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function rig(token = 'tok-1'): Promise<{ port: number; server: AgentHookServerHandle; pushed: AgentStatus[] }> {
  const pushed: AgentStatus[] = []
  const server = createAgentHookServer({ token, onStatus: (s) => void pushed.push(s), bindPort: 0 })
  servers.push(server)
  const port = await server.start()
  expect(port).toBeGreaterThan(0)
  return { port, server, pushed }
}

const hookHeaders = (token: string, pane: string): Record<string, string> => ({
  [HOOK_TOKEN_HEADER]: token,
  [HOOK_PANE_HEADER]: pane
})

describe('훅 수신 — 인증·귀속·매핑', () => {
  it('토큰이 틀리면 상태가 안 바뀐다', async () => {
    const { port, server } = await rig()
    expect(await post(port, '/hook/claude/Stop', hookHeaders('wrong', 'p1'))).toBe(401)
    expect(await post(port, '/hook/claude/Stop', { [HOOK_PANE_HEADER]: 'p1' })).toBe(401)
    expect(server.statuses()).toEqual([])
  })

  it('탭을 모르면(ARA_PANE 없음) 아무 주장도 안 한다 — 아라 대화가 띄운 헤드리스 claude 가 그렇다', async () => {
    const { port, server } = await rig()
    expect(await post(port, '/hook/claude/Stop', { [HOOK_TOKEN_HEADER]: 'tok-1' })).toBe(204)
    expect(server.statuses()).toEqual([])
  })

  it('표에 있는 이벤트가 상태를 만들고 화면으로 밀린다', async () => {
    const { port, server, pushed } = await rig()
    await post(port, '/hook/claude/PreToolUse', hookHeaders('tok-1', 'p1'))
    expect(server.statuses()[0]).toMatchObject({ sessionId: 'p1', cli: 'claude', state: 'working' })
    expect(pushed).toHaveLength(1)

    await post(port, '/hook/claude/Notification', hookHeaders('tok-1', 'p1'))
    expect(server.statuses()[0]!.state).toBe('waiting')
    expect(pushed).toHaveLength(2)
  })

  it('모르는 이벤트는 상태를 안 바꾸고 화면도 안 흔든다', async () => {
    const { port, server, pushed } = await rig()
    await post(port, '/hook/claude/Notification', hookHeaders('tok-1', 'p1'))
    const started = server.statuses()[0]!.stateStartedAt
    await post(port, '/hook/claude/SubagentStop', hookHeaders('tok-1', 'p1'))
    expect(server.statuses()[0]!.state).toBe('waiting')
    expect(server.statuses()[0]!.stateStartedAt).toBe(started)
    expect(pushed).toHaveLength(2) // 상태가 안 바뀌어도 들은 것은 밀린다(updatedAt 이 움직였다)
  })

  it('큰 페이로드를 흘려보낸다 — PostToolUse 는 파일 내용을 통째로 싣고 온다', async () => {
    const { port, server } = await rig()
    const big = JSON.stringify({ tool_response: 'x'.repeat(2_000_000) })
    expect(await post(port, '/hook/claude/PostToolUse', hookHeaders('tok-1', 'p1'), big)).toBe(204)
    expect(server.statuses()[0]!.state).toBe('working')
  })

  it('모르는 경로·메서드는 거절한다', async () => {
    const { port } = await rig()
    expect(await post(port, '/hook/codex/Stop', hookHeaders('tok-1', 'p1'))).toBe(404)
    // 프로토타입 오염 경로 — `in` 으로 짰으면 여기서 상태가 만들어진다.
    expect(await post(port, '/hook/constructor/Stop', hookHeaders('tok-1', 'p1'))).toBe(404)
    expect(await post(port, '/nope', hookHeaders('tok-1', 'p1'))).toBe(404)
  })

  it('#160 세션은 살아 있고 CLI 만 죽었다 — 줄이 `작업 중`에서 안 굳는다', async () => {
    const { port, server, pushed } = await rig()
    // ① 일하는 중
    await post(port, '/hook/claude/PreToolUse', hookHeaders('tok-1', 'p1'))
    expect(server.statuses()[0]!.state).toBe('working')

    // ② 탭은 그대로 둔 채 claude 만 나간다(Ctrl+D · /exit · 크래시 — 전부 SessionEnd 로 온다)
    expect(await post(port, '/hook/claude/SessionEnd', hookHeaders('tok-1', 'p1'))).toBe(204)
    expect(server.statuses()[0]!.state).toBe('unverifiable')
    expect(pushed.at(-1)!.state).toBe('unverifiable') // 화면까지 밀린다(원장만 바뀌면 줄은 그대로다)

    // ③ **토큰은 살아 있다.** 세션이 죽은 게 아니라 CLI 만 죽었다 — 같은 탭에서 다시 띄우면
    //    그 훅은 같은 토큰으로 온다. `forget`(토큰까지 지운다)을 쓰지 않은 이유가 이 줄이다.
    expect(await post(port, '/hook/claude/SessionStart', hookHeaders('tok-1', 'p1'))).toBe(204)
    expect(server.statuses()[0]!.state).toBe('working')
  })

  it('세션이 끝나면 그 상태를 잊는다', async () => {
    const { port, server } = await rig()
    await post(port, '/hook/claude/Stop', hookHeaders('tok-1', 'p1'))
    expect(server.statuses()).toHaveLength(1)
    server.forget('p1')
    expect(server.statuses()).toEqual([])
  })

  it('LAN 주소로는 안 들린다 — 루프백 고정 바인드(MCP 와 같은 규율)', async () => {
    const { port } = await rig()
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === 'IPv4' && n.address !== '127.0.0.1')
    if (!lan) return // 랜 주소가 없는 기계(CI 컨테이너)에서는 확인할 것이 없다
    await expect(
      new Promise((resolve, reject) => {
        // 대개는 ECONNREFUSED 로 즉시 거절되고, 방화벽이 SYN 을 버리면 아무 답도 안 온다 —
        // 둘 다 "안 들린다"라 상한을 짧게 둔다(검사 시간을 2초 쓸 이유가 없다).
        const req = httpRequest({ host: lan.address, port, path: '/hook/claude/Stop', method: 'POST', timeout: 500 }, () =>
          resolve('ok')
        )
        req.on('error', reject)
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.end()
      })
    ).rejects.toBeTruthy()
  })
})
