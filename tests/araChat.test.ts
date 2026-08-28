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
import { clearStaleSelfToken, isLocalPath, mcpConfigJson, pickEngineCwd, prepareAraMcp } from '../src/main/ai/engine/araMcp'
import {
  hashToken,
  MCP_SELF_TOKEN_VAULT_KEY,
  MCP_TOKEN_VAULT_KEY,
  type McpServerHandle,
  type TokenVault
} from '../src/main/mcp/McpServer'
import type { AiEngine, AiEngineEvent } from '../src/shared/aiEngine'

function memVault(): TokenVault & { map: Map<string, string>; delete(key: string): void } {
  const map = new Map<string, string>()
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    has: (k) => map.has(k),
    // 진짜 vault(SecretStore)에는 원래 있는 것이다. TokenVault 계약에만 없어서 **아라 토큰을
    // 지우는 사람이 하나도 없었다**(2026-08-28 감사) — araMcp.SelfTokenVault 가 이제 요구한다.
    delete: (k) => void map.delete(k)
  }
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
function fakeEngine(): AiEngine & {
  sent: string[]
  replies: [string, boolean][]
  modes: string[]
  models: string[]
  interrupts: number
  disposed: number
  fire(e: AiEngineEvent): void
} {
  const subs = new Set<(e: AiEngineEvent) => void>()
  const self = {
    sent: [] as string[],
    replies: [] as [string, boolean][],
    modes: [] as string[],
    models: [] as string[],
    interrupts: 0,
    disposed: 0,
    send: (t: string) => self.sent.push(t),
    respondPermission: (id: string, ok: boolean) => self.replies.push([id, ok]),
    setMode: (m: string) => self.modes.push(m),
    setModel: (m: string) => self.models.push(m),
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

  /**
   * ★ 2026-08-26 **방침이 뒤집혔다.** 전에는 여기서 몰래 켰다("사용자가 안 켜 뒀다고 아라가 도구를
   * 잃을 이유는 없다"). 그런데 이제 서버가 기본으로 켜져 있고, 끄는 화면은 *"끄면 아라가 우리 도구를
   * 못 씁니다"* 라고 경고한다. 그래 놓고 여기서 도로 켜면 **그 경고가 거짓말**이 되고 사용자가 끈
   * 것이 조용히 되살아난다.
   */
  it('★ 서버가 꺼져 있으면 켜지 않고 null — 사용자가 끈 것을 되살리지 않는다', async () => {
    const off = fakeServer({ enabled: false })
    expect(await prepareAraMcp(off, memVault())).toBeNull()
    // 켜려는 시도 자체가 없어야 한다(있으면 설정 화면의 경고가 거짓이 된다).
    expect(off.enabledCalls).toBe(0)
  })

  it('켜져 있으면 설정 파일을 만들어 준다(그때만 아라가 도구를 쥔다)', async () => {
    const on = fakeServer({ enabled: true })
    const h = await prepareAraMcp(on, memVault())
    expect(h).not.toBeNull()
    h!.cleanup()
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
    const vault = memVault()
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault,
      activeSession: () => o.session ?? null,
      lastLocalCwd: () => o.lastLocal ?? null,
      araCwd: () => araHome,
      emit: (e) => seen.push(e),
      makeEngine: () => eng
    })
    return { chat, eng, seen, vault }
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
    // home: true 가 붙는다 — 화면은 이 경로를 감춘다(#137, 아래 '작업 폴더 표시' 참고).
    expect(seen).toEqual([{ t: 'opened', cwd: araHome, withMcp: true, engine: 'cli', home: true }])
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

  /**
   * ★ 2026-08-28 배포 전 감사. **발급자만 있고 삭제자가 저장소에 하나도 없었다.**
   *
   * 임시 폴더의 설정 파일(`ara-mcp-` 로 시작하는 자리의 `mcp.json`)에는 원문 토큰이 들어 있고
   * 정상 종료 경로에서만 지워진다. 그 짝인 해시가 vault 에 남아 있으면 크래시가 남긴 그 파일을
   * 주운 쪽이 **재시작을 넘어 영원히** 우리 MCP 서버에 들어올 수 있다. 파일과 토큰을 함께 죽인다.
   */
  it('★ 닫으면 토큰 자체를 무효로 만든다 — 파일만 지워서는 그 토큰이 계속 통한다', async () => {
    const { chat, vault } = setup({ session: { type: 'local', cwd: local } })
    vault.set(MCP_TOKEN_VAULT_KEY, hashToken('사용자-토큰'))
    await chat.open()
    expect(vault.get(MCP_SELF_TOKEN_VAULT_KEY)).toMatch(/^[0-9a-f]{64}$/)
    chat.close()
    expect(vault.get(MCP_SELF_TOKEN_VAULT_KEY)).toBeNull()
    // 사용자 토큰은 건드리지 않는다 — 외부 클라이언트에 넣어 둔 것이 조용히 끊기면 안 된다.
    expect(vault.get(MCP_TOKEN_VAULT_KEY)).toBe(hashToken('사용자-토큰'))
  })

  it('★ 부팅 정리로 지난 실행이 남긴 토큰을 무효로 만든다 — 사용자 토큰은 그대로', () => {
    const vault = memVault()
    vault.set(MCP_TOKEN_VAULT_KEY, hashToken('사용자-토큰'))
    vault.set(MCP_SELF_TOKEN_VAULT_KEY, hashToken('크래시가-남긴-아라-토큰'))
    clearStaleSelfToken(vault)
    expect(vault.get(MCP_SELF_TOKEN_VAULT_KEY)).toBeNull()
    expect(vault.get(MCP_TOKEN_VAULT_KEY)).toBe(hashToken('사용자-토큰'))
    // 남은 것이 없어도 조용히 지나간다(부팅 경로라 던지면 앱이 안 뜬다).
    expect(() => clearStaleSelfToken(memVault())).not.toThrow()
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

  it('★ claude 가 없으면 띄우지 않는다 — 셸 오류 문자열을 짐작하지 않는다', async () => {
    hasClaude = false
    const { chat, seen } = mk() // api 를 안 준 판 = 갈 곳이 없다
    expect(await chat.open()).toEqual({ ok: false, noEngine: true })
    expect(seen).toEqual([{ t: 'noEngine' }])
    expect(chat.isOpen()).toBe(false)
  })

  it('★ claude 가 없고 폴백이 있으면 **알리고 넘어간다**(2026-08-25 준영님 지시)', async () => {
    hasClaude = false
    const { chat, seen } = mk({ api: true })
    expect(await chat.open()).toEqual({ ok: true })
    // 조용히 바꾸지 않는다 — 왜 넘어갔는지 사건으로 먼저 알리고, 그다음 API 로 열린다.
    expect(seen.map((e) => e.t)).toEqual(['noEngine', 'opened'])
    expect(seen[1]).toMatchObject({ engine: 'api' })
    chat.close()
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


// ── #136 계획 먼저 ───────────────────────────────────────────────────────────
// 실측(2026-08-25)이 정한 흐름을 굳혀 둔다: plan 모드는 실제 편집을 막고, 승인 뒤
// control 요청으로 **acceptEdits** 로 갈아 끼우면 같은 프로세스에서 그대로 실행된다.
// `default` 로 바꾸면 "권한을 아직 허용하지 않았다"로 또 막힌다 — 그래서 목표 모드가 중요하다.
describe('계획 먼저 (#136)', () => {
  const local = process.platform === 'win32' ? 'D:/work' : '/work'
  const setup = () => {
    const seen: AraChatEvent[] = []
    const engines: { args: { permissionMode?: string }; eng: ReturnType<typeof fakeEngine> }[] = []
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => ({ type: 'local', cwd: local }),
      lastLocalCwd: () => local,
      araCwd: () => local,
      emit: (e) => seen.push(e),
      makeEngine: (args) => {
        const eng = fakeEngine()
        engines.push({ args, eng })
        return eng
      }
    })
    return { chat, seen, engines }
  }

  it('기본은 꺼져 있다 — 평소 대화는 그냥 한다', async () => {
    const { chat, engines } = setup()
    await chat.open()
    expect(engines[0]!.args.permissionMode).toBeUndefined()
  })

  it('★ 도는 중에 켜고 끈다 — 프로세스를 다시 띄우지 않는다', async () => {
    const { chat, seen, engines } = setup()
    await chat.open()
    chat.setPlanMode(true)
    expect(engines[0]!.eng.modes).toEqual(['plan'])
    expect(engines).toHaveLength(1) // 재기동 없음
    expect(seen.at(-1)).toEqual({ t: 'planMode', on: true })

    chat.setPlanMode(false)
    expect(engines[0]!.eng.modes).toEqual(['plan', 'acceptEdits'])
    // 같은 값을 두 번 부르면 아무 일도 없다(화면 토글이 흔들려도 요청이 쌓이지 않는다).
    chat.setPlanMode(false)
    expect(engines[0]!.eng.modes).toHaveLength(2)
  })

  it('열기 전에 켜 두면 인자로 나간다 · 닫으면 꺼진다', async () => {
    const { chat, engines } = setup()
    chat.setPlanMode(true)
    await chat.open()
    expect(engines[0]!.args.permissionMode).toBe('plan')

    chat.close()
    await chat.open()
    expect(engines[1]!.args.permissionMode).toBeUndefined()
  })

  it('★ 승인하면 **acceptEdits** 로 풀고 진행을 보낸다 — default 로는 또 막힌다(실측)', async () => {
    const { chat, seen, engines } = setup()
    chat.setPlanMode(true)
    await chat.open()
    chat.approvePlan()

    const eng = engines[0]!.eng
    expect(eng.modes).toEqual(['acceptEdits'])
    expect(eng.sent).toEqual(['좋아, 그 계획대로 진행해 줘.'])
    expect(seen.at(-1)).toEqual({ t: 'planMode', on: false })
    expect(engines).toHaveLength(1) // 같은 프로세스·같은 대화
  })

  it('안 열려 있으면 승인은 아무 일도 하지 않는다(늦게 누른 버튼)', () => {
    const { chat, seen } = setup()
    expect(() => chat.approvePlan()).not.toThrow()
    expect(seen).toEqual([])
  })
})

// ── #137 모델 고르기 ─────────────────────────────────────────────────────────
// 실측(2026-08-25): `set_model` 이 control 채널로 먹는다 — success 뒤 init 이 새 모델로 다시 온다.
// 그래서 이 고르기는 **재기동 없이** 즉시 반영되고 대화가 끊기지 않는다.
describe('모델 고르기 (#137)', () => {
  const local = process.platform === 'win32' ? 'D:/work' : '/work'
  const setup = () => {
    const seen: AraChatEvent[] = []
    const engines: { args: { model?: string }; eng: ReturnType<typeof fakeEngine> }[] = []
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => ({ type: 'local', cwd: local }),
      lastLocalCwd: () => local,
      araCwd: () => local,
      emit: (e) => seen.push(e),
      makeEngine: (args) => {
        const eng = fakeEngine()
        engines.push({ args, eng })
        return eng
      }
    })
    return { chat, seen, engines }
  }

  it('기본은 안 고른 상태 — 사용자의 ~/.claude 기본값을 그대로 쓴다', async () => {
    const { chat, engines } = setup()
    await chat.open()
    expect(engines[0]!.args.model).toBeUndefined()
  })

  it('★ 도는 중에 바꾼다 — 프로세스를 다시 띄우지 않는다', async () => {
    const { chat, seen, engines } = setup()
    await chat.open()
    chat.setModel('claude-haiku-4-5-20251001')
    expect(engines[0]!.eng.models).toEqual(['claude-haiku-4-5-20251001'])
    expect(engines).toHaveLength(1)
    expect(seen.at(-1)).toEqual({ t: 'model', model: 'claude-haiku-4-5-20251001' })
    // 같은 값을 두 번 고르면 아무 일도 없다.
    chat.setModel('claude-haiku-4-5-20251001')
    expect(engines[0]!.eng.models).toHaveLength(1)
  })

  it('고른 뒤 다시 열면 인자로 나간다 · 닫으면 기본으로 돌아간다', async () => {
    const { chat, engines } = setup()
    await chat.open()
    chat.setModel('claude-opus-5')
    await chat.open()
    expect(engines[1]!.args.model).toBe('claude-opus-5')
    chat.close()
    await chat.open()
    expect(engines[2]!.args.model).toBeUndefined()
  })
})

// ── #137 아라 폴더는 화면에서 감춘다 ─────────────────────────────────────────
describe('작업 폴더 표시 (#137)', () => {
  it("★ 고를 것이 없어 떨어진 자리는 home 으로 표시한다 — 화면이 그 경로를 감춘다", async () => {
    const seen: AraChatEvent[] = []
    const home = process.platform === 'win32' ? 'C:/ara-home' : '/var/ara-home'
    const chat = createAraChat({
      server: fakeServer({ enabled: true }),
      vault: memVault(),
      activeSession: () => null,
      lastLocalCwd: () => null,
      araCwd: () => home,
      emit: (e) => seen.push(e),
      makeEngine: () => fakeEngine()
    })
    await chat.open()
    expect(seen[0]).toMatchObject({ t: 'opened', cwd: home, home: true })
    chat.close()
  })
})
