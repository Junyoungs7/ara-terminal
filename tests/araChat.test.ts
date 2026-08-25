// #124 아라 MCP 물리기 + 권한 왕복 — **main 쪽 한 층**(화면은 #125).
//
// 여기서 지키는 것 넷:
//  ① 우리 토큰이 **사용자 토큰을 무효로 만들지 않는다**(외부 클라이언트가 조용히 끊기면 안 된다)
//  ② 작업 폴더 규칙(§3.3) — 원격 경로를 로컬 폴더로 잘못 쓰지 않는다
//  ③ 권한은 **사람이 답한다** — 대신 승인하는 자리가 없다
//  ④ 닫으면 흔적이 없다(프로세스·토큰 파일)
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createAraChat, type AraChatEvent } from '../src/main/ai/AraChat'
import { isLocalPath, mcpConfigJson, pickEngineCwd, prepareAraMcp } from '../src/main/ai/engine/araMcp'
import {
  hashToken,
  MCP_SELF_TOKEN_VAULT_KEY,
  MCP_TOKEN_VAULT_KEY,
  type McpServerHandle,
  type TokenVault
} from '../src/main/mcp/McpServer'
import type { AiEngine, AiEngineEvent } from '../src/shared/aiEngine'

function memVault(): TokenVault & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), has: (k) => map.has(k) }
}

function fakeServer(o: { enabled?: boolean; port?: number } = {}): McpServerHandle & { enabledCalls: number } {
  let on = o.enabled ?? false
  const h = {
    enabledCalls: 0,
    setEnabled: async (v: boolean) => {
      h.enabledCalls += 1
      on = v
      return { ok: true as const, port: o.port ?? 39217 }
    },
    isEnabled: () => on,
    port: () => (on ? (o.port ?? 39217) : 0),
    connectedCount: () => 0,
    disconnectClient: () => {},
    stop: async () => {}
  }
  return h
}

/** 가짜 엔진 — 프로세스 없이 사건을 흘려 넣는다. */
function fakeEngine(): AiEngine & { sent: string[]; replies: [string, boolean][]; interrupts: number; disposed: number; fire(e: AiEngineEvent): void } {
  const subs = new Set<(e: AiEngineEvent) => void>()
  const self = {
    sent: [] as string[],
    replies: [] as [string, boolean][],
    interrupts: 0,
    disposed: 0,
    send: (t: string) => self.sent.push(t),
    respondPermission: (id: string, ok: boolean) => self.replies.push([id, ok]),
    interrupt: () => (self.interrupts += 1),
    dispose: () => (self.disposed += 1),
    onEvent: (fn: (e: AiEngineEvent) => void) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    fire: (e: AiEngineEvent) => [...subs].forEach((f) => f(e))
  }
  return self
}

describe('MCP 설정 파일', () => {
  it('★ 도구 이름 접두어가 --allowedTools 와 같아야 한다(mcp__ara__*)', () => {
    const cfg = JSON.parse(mcpConfigJson(39217, 'tok'))
    expect(Object.keys(cfg.mcpServers)).toEqual(['ara'])
    expect(cfg.mcpServers.ara.url).toBe('http://127.0.0.1:39217/mcp')
    expect(cfg.mcpServers.ara.headers.Authorization).toBe('Bearer tok')
  })

  it('★ 우리 토큰은 **아라 전용 키**로 간다 — 사용자 토큰을 무효로 만들지 않는다', async () => {
    const vault = memVault()
    vault.set(MCP_TOKEN_VAULT_KEY, hashToken('사용자-토큰'))
    const h = await prepareAraMcp(fakeServer({ enabled: true }), vault)
    expect(h).not.toBeNull()
    // 사용자 것은 그대로.
    expect(vault.get(MCP_TOKEN_VAULT_KEY)).toBe(hashToken('사용자-토큰'))
    // 우리 것은 새로 생겼고, **해시만** 저장된다.
    const selfHash = vault.get(MCP_SELF_TOKEN_VAULT_KEY)!
    expect(selfHash).toMatch(/^[0-9a-f]{64}$/)
    // 파일에 든 원문 토큰이 그 해시와 맞는다(= 그 토큰으로 서버에 들어갈 수 있다).
    const raw = JSON.parse(readFileSync(h!.configPath, 'utf8')).mcpServers.ara.headers.Authorization.slice('Bearer '.length)
    expect(hashToken(raw)).toBe(selfHash)
    h!.cleanup()
  })

  it('서버가 꺼져 있으면 켜 준다 · 못 켜면 null(그래도 대화는 시작한다)', async () => {
    const off = fakeServer({ enabled: false })
    const h = await prepareAraMcp(off, memVault())
    expect(off.enabledCalls).toBe(1)
    expect(h).not.toBeNull()
    h!.cleanup()

    const broken = { ...fakeServer(), setEnabled: async () => Promise.reject(new Error('포트 점유')) } as McpServerHandle
    expect(await prepareAraMcp(broken, memVault())).toBeNull()
  })

  it('★ 닫으면 토큰이 든 파일이 사라진다', async () => {
    const h = (await prepareAraMcp(fakeServer({ enabled: true }), memVault()))!
    expect(existsSync(h.configPath)).toBe(true)
    h.cleanup()
    expect(existsSync(h.configPath)).toBe(false)
  })
})

describe('작업 폴더 고르기(§3.3)', () => {
  const local = process.platform === 'win32' ? 'D:\\work\\app' : '/home/jun/app'
  const remote = '/srv/app'
  const home = process.platform === 'win32' ? 'C:/ara' : '/var/ara'
  const pick = (o: { sessionType: 'local' | 'ssh' | 'rdp' | null; sessionCwd: string | null; lastLocal: string | null }) =>
    pickEngineCwd({ ...o, fallback: home })

  it('로컬 셸이면 그 셸의 폴더에서 돈다 — 그 폴더의 CLAUDE.md·훅을 읽는 것이 이득이다', () => {
    expect(pick({ sessionType: 'local', sessionCwd: local, lastLocal: null })).toBe(local)
  })

  it('★ SSH 세션의 원격 경로를 로컬 폴더로 쓰지 않는다 — 마지막 로컬 폴더로 떨어진다', () => {
    expect(pick({ sessionType: 'ssh', sessionCwd: remote, lastLocal: local })).toBe(local)
  })

  it('★ 쓸 로컬 폴더가 없어도 **묻지 않는다** — 아라 폴더에서 시작한다', () => {
    // 2026-08-25 준영님 결정: 아라는 특정 폴더에 매인 물건이 아니다. 터미널·원격 일은 세션
    // 도구로 하고, 폴더는 "로컬 파일을 만질 때의 기본 자리"일 뿐이라 시작을 막을 이유가 없다.
    expect(pick({ sessionType: 'ssh', sessionCwd: remote, lastLocal: null })).toBe(home)
    expect(pick({ sessionType: null, sessionCwd: null, lastLocal: null })).toBe(home)
  })

  it('로컬 경로 판정 — 윈도우에서 원격 경로가 통과하면 안 된다', () => {
    if (process.platform === 'win32') {
      expect(isLocalPath('D:\\a')).toBe(true)
      expect(isLocalPath('\\\\srv\\share')).toBe(true)
      expect(isLocalPath('/srv/app')).toBe(false)
      expect(isLocalPath('~/app')).toBe(false)
    } else {
      expect(isLocalPath('/srv/app')).toBe(true)
      expect(isLocalPath('C:\\a')).toBe(false)
    }
  })
})

describe('아라 대화 한 벌', () => {
  const local = process.platform === 'win32' ? 'D:\\work' : '/work'
  const araHome = process.platform === 'win32' ? 'C:/ara' : '/var/ara'
  const setup = (o: { session?: { type: 'local' | 'ssh'; cwd: string | null } | null; lastLocal?: string | null } = {}) => {
    const seen: AraChatEvent[] = []
    const eng = fakeEngine()
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => o.session ?? null,
      lastLocalCwd: () => o.lastLocal ?? null,
      araCwd: () => araHome,
      emit: (e) => seen.push(e),
      makeEngine: () => eng
    })
    return { chat, eng, seen }
  }

  it('열면 폴더와 MCP 물림 여부를 알린다', async () => {
    const { chat, seen } = setup({ session: { type: 'local', cwd: local } })
    expect(await chat.open()).toEqual({ ok: true })
    expect(seen).toEqual([{ t: 'opened', cwd: local, withMcp: true, engine: 'cli' }])
    expect(chat.isOpen()).toBe(true)
  })

  it('★ 원격만 보고 있어도 **연다** — 아라 폴더에서 시작하고 원격은 세션 도구로 만진다', async () => {
    const { chat, seen } = setup({ session: { type: 'ssh', cwd: '/srv' } })
    expect(await chat.open()).toEqual({ ok: true })
    expect(seen).toEqual([{ t: 'opened', cwd: araHome, withMcp: true, engine: 'cli' }])
    expect(chat.isOpen()).toBe(true)
  })

  it('사용자가 고른 폴더가 규칙을 이긴다', async () => {
    const { chat, seen } = setup({ session: { type: 'ssh', cwd: '/srv' } })
    await chat.open({ cwd: local })
    expect(seen[0]).toEqual({ t: 'opened', cwd: local, withMcp: true, engine: 'cli' })
  })

  it('★ 권한 요청은 대기열에 담긴다 — 화면이 늦게 붙어도 잃지 않는다', async () => {
    const { chat, eng } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    eng.fire({ t: 'permission', requestId: 'r1', tool: 'Edit', brief: '/work/a.ts' })
    expect(chat.pending()).toEqual([{ requestId: 'r1', tool: 'Edit', brief: '/work/a.ts' }])
  })

  it('★ 답은 사람이 한 것만 나간다 · 같은 요청에 두 번 답하지 않는다', async () => {
    const { chat, eng } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    eng.fire({ t: 'permission', requestId: 'r1', tool: 'Bash', brief: 'rm -rf build' })
    chat.respond('r1', false)
    chat.respond('r1', true) // 늦게 온 두 번째 답 — 버린다
    chat.respond('없는요청', true) // 대기열에 없다 — 버린다
    expect(eng.replies).toEqual([['r1', false]])
    expect(chat.pending()).toEqual([])
  })

  it('세션 id 를 기억한다 — 다음에 이어서 열 때 쓴다', async () => {
    const { chat, eng } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    eng.fire({ t: 'ready', sessionId: 's-99', model: 'm', cwd: local, tools: [] })
    expect(chat.resumeId()).toBe('s-99')
  })

  it('★ 프로세스가 죽으면 이 층도 함께 정리한다(유령 대기열 금지)', async () => {
    const { chat, eng, seen } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    eng.fire({ t: 'permission', requestId: 'r1', tool: 'Bash', brief: 'x' })
    eng.fire({ t: 'exit', code: 1 })
    expect(seen.map((e) => e.t)).toEqual(['opened', 'permission', 'exit', 'closed'])
    expect(chat.isOpen()).toBe(false)
    expect(chat.pending()).toEqual([])
  })

  it('★ 다시 열면 앞의 프로세스를 내린다 — 둘이 같은 대화를 물면 답이 섞인다', async () => {
    const { chat, eng } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    await chat.open()
    expect(eng.disposed).toBe(1)
  })

  it('닫으면 프로세스를 내리고 닫힘을 알린다', async () => {
    const { chat, eng, seen } = setup({ session: { type: 'local', cwd: local } })
    await chat.open()
    chat.close()
    expect(eng.disposed).toBe(1)
    expect(seen.at(-1)).toEqual({ t: 'closed' })
    // 닫힌 뒤 보내는 것은 아무 일도 하지 않는다(예외 없이).
    expect(() => chat.send('늦은 질문')).not.toThrow()
    expect(eng.sent).toEqual([])
  })
})

// ── #126 부재·실패 처리 + API 키 폴백 ────────────────────────────────────────
// **claude 가 없는 PC 에서 무슨 일이 일어나는가**가 이 절의 전부다. 셸이 뱉는 로케일별 오류
// 문자열을 짐작해 분류하는 대신 띄우기 전에 where/which 로 본다 — 그래서 그 조회를 가로챈다.
vi.mock('../src/main/util/localCli', () => ({ hasLocalCli: () => Promise.resolve(hasClaude) }))
let hasClaude = true

describe('엔진이 없을 때 · 폴백 (#126)', () => {
  const local = process.platform === 'win32' ? 'D:/work' : '/home/jun/work'
  const mk = (o: { api?: boolean } = {}) => {
    const seen: AraChatEvent[] = []
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => ({ type: 'local', cwd: local }),
      lastLocalCwd: () => local,
      araCwd: () => local,
      emit: (e) => seen.push(e),
      // makeEngine 을 주지 않는다 — 그게 있으면 "진짜로 띄우는 판"이 아니라 조회를 건너뛴다.
      ...(o.api ? { api: { vault: memVault() as never, getPrefs: () => ({ provider: 'anthropic' as const, model: 'm' }) } } : {})
    })
    return { chat, seen }
  }

  it('★ claude 가 없으면 띄우지 않고 알린다 — 셸 오류 문자열을 짐작하지 않는다', async () => {
    hasClaude = false
    const { chat, seen } = mk()
    expect(await chat.open()).toEqual({ ok: false, noEngine: true })
    expect(seen).toEqual([{ t: 'noEngine' }])
    expect(chat.isOpen()).toBe(false)
  })

  it('★ API 키 폴백은 폴더도 MCP 도 묻지 않는다 — 도구가 없으니 의미가 없다', async () => {
    hasClaude = false
    const { chat, seen } = mk({ api: true })
    expect(await chat.open({ engine: 'api' })).toEqual({ ok: true })
    expect(seen).toEqual([{ t: 'opened', cwd: null, withMcp: false, engine: 'api' }])
    chat.close()
  })

  it('폴백을 쓸 수 없으면 그렇다고 말한다 — 조용히 A 로 되돌리지 않는다', async () => {
    hasClaude = false
    const { chat, seen } = mk()
    expect(await chat.open({ engine: 'api' })).toEqual({ ok: false })
    expect(seen[0]).toMatchObject({ t: 'error' })
    expect(chat.isOpen()).toBe(false)
  })

  // "있으면 평소대로 연다"는 따로 두지 않는다 — 위 '열면 폴더와 MCP 물림 여부를 알린다'가
  // 이미 그 길이다(엔진을 주입한 판이라 조회 자체를 지나가지 않는다).
})

// ── #135 문지기 ──────────────────────────────────────────────────────────────
describe('문지기 (#135)', () => {
  const local = process.platform === 'win32' ? 'D:/work' : '/home/jun/work'
  const mk = (gate?: { write: boolean; exec: boolean }) => {
    const seen: AraChatEvent[] = []
    const engines: { args: unknown; eng: ReturnType<typeof fakeEngine> }[] = []
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => ({ type: 'local', cwd: local }),
      lastLocalCwd: () => local,
      araCwd: () => local,
      emit: (e) => seen.push(e),
      ...(gate ? { gate: () => gate } : {}),
      makeEngine: (args) => {
        const eng = fakeEngine()
        engines.push({ args, eng })
        return eng
      }
    })
    return { chat, seen, engines }
  }

  it('등급을 끄면 그 도구들이 막을 목록으로 간다 · 기본은 아무것도 안 붙는다', async () => {
    const { chat, engines } = mk({ write: false, exec: true })
    await chat.open()
    expect((engines[0]!.args as { disallowed?: string[] }).disallowed).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

    const plain = mk()
    await plain.chat.open()
    expect((plain.engines[0]!.args as { disallowed?: string[] }).disallowed).toBeUndefined()
  })

  it('★ 막힌 도구는 결과에서 알아채고 화면에 올린다 — 평범한 실패는 아니다', async () => {
    const { chat, seen, engines } = mk({ write: false, exec: true })
    await chat.open()
    engines[0]!.eng.fire({
      t: 'toolResult',
      id: 't1',
      ok: false,
      brief: 'Error: No such tool available: Write. Write is disabled for this session, in subagents as well as here.'
    })
    expect(seen.at(-1)).toEqual({ t: 'blocked', tool: 'Write', cls: 'write' })

    engines[0]!.eng.fire({ t: 'toolResult', id: 't2', ok: false, brief: 'exit 1' })
    expect(seen.at(-1)).toMatchObject({ t: 'toolResult' })
  })

  it('★ 허용하면 같은 대화를 --resume 으로 다시 문다 — 런타임으로는 못 되돌린다(실측)', async () => {
    const { chat, engines } = mk({ write: false, exec: true })
    await chat.open()
    engines[0]!.eng.fire({ t: 'ready', sessionId: 'sess-1', model: 'm', cwd: local, tools: [] })
    await chat.allow('write')

    expect(engines).toHaveLength(2)
    const second = engines[1]!.args as { resumeId?: string; disallowed?: string[]; cwd: string }
    expect(second.resumeId).toBe('sess-1') // 대화를 잃지 않는다
    expect(second.cwd).toBe(local) // 폴더도 그대로
    expect(second.disallowed).toBeUndefined() // 이제 안 막는다
    expect(engines[0]!.eng.disposed).toBe(1) // 앞의 프로세스는 내린다
  })

  it('허용은 **이 대화 동안**이다 — 닫으면 설정으로 돌아간다', async () => {
    const { chat, engines } = mk({ write: false, exec: true })
    await chat.open()
    await chat.allow('write')
    chat.close()
    await chat.open()
    expect((engines.at(-1)!.args as { disallowed?: string[] }).disallowed).toEqual([
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit'
    ])
  })
})
