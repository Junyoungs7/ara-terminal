/**
 * 아라 대화 한 벌(#124) — **엔진·MCP 설정·권한 대기열의 주인.**
 *
 * 화면(#125)은 이 객체와만 이야기한다: 열고, 보내고, 권한에 답하고, 멈추고, 닫는다.
 * 엔진이 A(로컬 Claude Code)든 B(API 키)든 이 층은 그대로다 — 그게 #123 에서 사건 모양을
 * 하나로 맞춘 이유다.
 *
 * 이 파일이 지키는 것:
 *  ① **하나만 산다.** 관제실은 여럿일 이유가 없다(설계 §8). 다시 열면 앞의 것을 내린다.
 *  ② **권한은 사람이 답한다.** 여기서 대신 승인하는 자리는 없다 — 대기열에 담아 화면에 올리고,
 *     사람의 답을 그대로 프로세스에 돌려준다(§3.4).
 *  ③ **닫으면 흔적이 없다.** 프로세스를 내리고 토큰이 든 임시 설정 파일을 지운다.
 */
import type { AiEngine, AiEngineEvent } from '@shared/aiEngine'
import type { McpServerHandle, TokenVault } from '../mcp/McpServer'
import { createClaudeEngine } from './engine/ClaudeCliEngine'
import { createFakeEngine } from './engine/FakeEngine'
import { createApiEngine } from './engine/ApiEngine'
import { isFakeAi, type AiPrefs, type KeyVault } from './AraSession'
import { hasLocalCli } from '../util/localCli'
import { blockedToolOf, classOfTool, disallowedTools, GATE_ALL_PASS, type AraGate } from '@shared/aiGate'
import { pickEngineCwd, prepareAraMcp, type AraMcpHandoff } from './engine/araMcp'

/** 엔진을 띄울 때 주는 것 — 주입 seam(makeEngine)과 진짜 생성자가 같은 모양을 쓴다. */
export type ClaudeEngineArgs = { cwd: string; mcpConfigPath?: string; resumeId?: string; disallowed?: readonly string[] }

export type AraChatDeps = {
  server: McpServerHandle
  vault: TokenVault
  /**
   * 지금 보고 있는 세션(작업 폴더를 여기서 고른다 — §3.3).
   * **활성 세션을 아는 것은 렌더러다**(main 의 세션 원장에는 "어느 탭을 보고 있나"가 없다) —
   * 그래서 화면이 open() 에 실어 보내고, 이 함수는 그게 없을 때의 대비다.
   */
  activeSession: () => { type: 'local' | 'ssh' | 'rdp'; cwd: string | null } | null
  /** 마지막으로 쓴 로컬 폴더(없으면 null → 아라 폴더로 떨어진다). */
  lastLocalCwd: () => string | null
  /**
   * 아무것도 못 고를 때 가는 자리(늘 존재해야 한다 — 호출자가 만들어 둔다).
   * **묻지 않기 위해** 있는 값이다: 아라는 특정 폴더에 매인 물건이 아니고, 터미널·원격 일은
   * 세션 도구로 한다(2026-08-25 준영님 결정).
   */
  araCwd: () => string
  /** 화면으로 올리는 길. */
  emit: (e: AraChatEvent) => void
  /** 테스트 주입 — 없으면 진짜 claude 를 띄운다. */
  makeEngine?: (o: ClaudeEngineArgs) => AiEngine
  /**
   * B 엔진(API 키)이 쓸 것들 — `claude` 가 없는 PC 의 폴백(설계 §5, #126).
   * 없으면 폴백을 못 연다(그 사실을 화면에 그대로 알린다 — 조용히 A 로 되돌리지 않는다).
   */
  api?: { vault: KeyVault; getPrefs: () => AiPrefs }
  /** 문지기 등급(#135). 없으면 아무것도 막지 않는다 — 0.1.0 까지의 행동이 기본이다. */
  gate?: () => AraGate
}

/** 어느 엔진으로 열려 있나. 돈도 능력도 다르므로 **화면에 늘 보인다**(§5). */
export type AraEngineKind = 'cli' | 'api'

/** 화면이 받는 것 = 엔진 사건 + 이 층이 아는 것 몇 개. */
export type AraChatEvent =
  | AiEngineEvent
  /** 열렸다 — 어느 엔진으로, 어느 폴더에서, MCP 도구가 물렸는지. */
  | { t: 'opened'; cwd: string | null; withMcp: boolean; engine: AraEngineKind }
  /** 이 PC 에 `claude` 가 없다 — 설치하든지 API 키로 가든지(설계 §5). */
  | { t: 'noEngine' }
  /** 문지기가 도구를 막았다(#135). cls 단위로 허용한다 — 허용은 `--resume` 재기동이다. */
  | { t: 'blocked'; tool: string; cls: 'write' | 'exec' }
  /** 닫혔다. */
  | { t: 'closed' }

export type AraChat = {
  /** 대화를 연다. cwd 를 주면 그것을 쓰고(사용자가 고른 폴더), 없으면 §3.3 규칙으로 고른다. */
  open(o?: {
    cwd?: string
    resumeId?: string
    /** 화면이 알려 주는 지금 세션. 없으면 deps.activeSession() 을 본다. */
    active?: { type: 'local' | 'ssh' | 'rdp'; cwd: string | null } | null
    /** 기본은 A(로컬 Claude Code). 'api' 는 사람이 폴백을 고른 것이다 — 우리가 몰래 바꾸지 않는다. */
    engine?: AraEngineKind
  }): Promise<{ ok: boolean; noEngine?: boolean }>
  send(text: string): void
  /** 권한 요청에 답한다. 대기열에 없는 id 는 조용히 버린다(늦게 온 답). */
  respond(requestId: string, allow: boolean): void
  interrupt(): void
  /** 막힌 등급을 **이 대화 동안** 연다. 프로세스를 --resume 으로 다시 띄운다(실측: 런타임 변경 불가). */
  allow(cls: 'write' | 'exec'): Promise<void>
  close(): void
  /** 지금 답을 기다리는 권한 요청들 — 화면이 다시 그릴 때 쓴다. */
  pending(): { requestId: string; tool: string; brief: string }[]
  isOpen(): boolean
  /** 이어서 열 때 쓸 세션 id(엔진이 알려 준 것). */
  resumeId(): string | null
}

export function createAraChat(deps: AraChatDeps): AraChat {
  let engine: AiEngine | null = null
  let handoff: AraMcpHandoff | null = null
  let offEvent: (() => void) | null = null
  let sessionId: string | null = null
  // 이 대화 동안만 열어 준 등급. 닫으면 사라진다 — 설정을 대신 바꾸지 않는다.
  const granted = new Set<'write' | 'exec'>()
  // 다시 띄울 때 그대로 쓰려고 붙잡아 둔다(허용은 같은 폴더·같은 대화로 이어져야 한다).
  let lastCwd: string | null = null
  const waiting = new Map<string, { requestId: string; tool: string; brief: string }>()

  /** 엔진 사건 → 이 층의 규칙 → 화면. **두 엔진이 같은 배선을 쓴다**(그러라고 모양을 맞췄다). */
  const wire = (e0: AiEngine): void => {
    offEvent = e0.onEvent((e) => {
      if (e.t === 'ready' && e.sessionId) sessionId = e.sessionId
      // 권한 요청은 대기열에 담는다 — 화면이 늦게 붙어도 잃지 않는다.
      if (e.t === 'permission') waiting.set(e.requestId, { requestId: e.requestId, tool: e.tool, brief: e.brief })
      // 문지기가 막은 것 — 도구 결과에 그 사실이 실려 온다(실측 §3.4f). 화면이 사람에게 묻는다.
      if (e.t === 'toolResult' && !e.ok) {
        const tool = blockedToolOf(e.brief)
        const cls = tool ? classOfTool(tool) : null
        if (tool && cls) {
          deps.emit(e)
          deps.emit({ t: 'blocked', tool, cls })
          return
        }
      }
      // 프로세스가 죽었으면 이 층도 함께 정리한다(고아·유령 대기열 금지).
      if (e.t === 'exit') {
        deps.emit(e)
        teardown()
        deps.emit({ t: 'closed' })
        return
      }
      deps.emit(e)
    })
  }

  const teardown = (): void => {
    offEvent?.()
    offEvent = null
    engine?.dispose()
    engine = null
    handoff?.cleanup()
    handoff = null
    waiting.clear()
  }

  /** 지금 걸려 있는 등급 = 설정 − 이 대화에서 연 것. */
  const effective = (): AraGate => {
    const g = deps.gate?.() ?? GATE_ALL_PASS
    return { write: g.write || granted.has('write'), exec: g.exec || granted.has('exec') }
  }

  return {
    async open(o = {}) {
      // 다시 열면 앞의 것을 내린다 — 두 프로세스가 같은 대화를 물면 답이 섞인다.
      if (engine) teardown()

      // ── B 엔진(API 키). 도구가 없으니 작업 폴더도 MCP 도 의미가 없다 — 그 둘을 통째로 건너뛴다.
      if (o.engine === 'api') {
        if (!deps.api) {
          deps.emit({ t: 'error', message: 'API 키 엔진을 쓸 수 없습니다.' })
          return { ok: false }
        }
        engine = createApiEngine(deps.api)
        wire(engine)
        deps.emit({ t: 'opened', cwd: null, withMcp: false, engine: 'api' })
        return { ok: true }
      }

      const active = o.active !== undefined ? o.active : deps.activeSession()
      const cwd =
        o.cwd ??
        pickEngineCwd({
          sessionType: active?.type ?? null,
          sessionCwd: active?.cwd ?? null,
          lastLocal: deps.lastLocalCwd(),
          fallback: deps.araCwd()
        })

      // **띄우기 전에 있는지 본다.** 없는 것을 띄우면 셸이 로케일별로 다른 말("... is not
      // recognized" / "명령을 찾을 수 없습니다")을 stderr 로 뱉고, 우리는 그 문자열을 짐작해서
      // 분류하게 된다. where/which 한 번이 그 짐작을 통째로 없앤다.
      const real = !deps.makeEngine && !isFakeAi()
      if (real && !(await hasLocalCli('claude'))) {
        deps.emit({ t: 'noEngine' })
        return { ok: false, noEngine: true }
      }

      // MCP 를 못 물려도 대화는 시작한다 — Claude Code 기본 기능은 그대로 산다(§3.2).
      handoff = await prepareAraMcp(deps.server, deps.vault)

      // ARA_AI_FAKE=1 이면 캔드 엔진(F16 관행). 주입(makeEngine)이 있으면 그게 먼저다.
      const make = deps.makeEngine ?? (isFakeAi() ? () => createFakeEngine() : (x: ClaudeEngineArgs) => createClaudeEngine(x))
      lastCwd = cwd
      const disallowed = disallowedTools(effective())
      engine = make({
        cwd,
        ...(handoff ? { mcpConfigPath: handoff.configPath } : {}),
        ...(o.resumeId ? { resumeId: o.resumeId } : {}),
        ...(disallowed.length > 0 ? { disallowed } : {})
      })
      wire(engine)
      deps.emit({ t: 'opened', cwd, withMcp: handoff !== null, engine: 'cli' })
      return { ok: true }
    },

    send: (text) => engine?.send(text),

    respond: (requestId, allow) => {
      if (!waiting.delete(requestId)) return
      engine?.respondPermission(requestId, allow)
    },

    interrupt: () => engine?.interrupt(),

    async allow(cls) {
      // 런타임으로는 못 되돌린다(실측) — 같은 대화를 --resume 으로 다시 문다.
      if (granted.has(cls)) return
      granted.add(cls)
      const resumeId = sessionId
      await this.open({
        ...(lastCwd ? { cwd: lastCwd } : {}),
        ...(resumeId ? { resumeId } : {}),
        active: null
      })
    },

    close: () => {
      granted.clear()
      if (!engine) return
      teardown()
      deps.emit({ t: 'closed' })
    },

    pending: () => [...waiting.values()],
    isOpen: () => engine !== null,
    resumeId: () => sessionId
  }
}
