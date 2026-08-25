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
import { pickEngineCwd, prepareAraMcp, writePersona, type AraMcpHandoff } from './engine/araMcp'
import { buildPersona } from '@shared/araPersona'

/** 엔진을 띄울 때 주는 것 — 주입 seam(makeEngine)과 진짜 생성자가 같은 모양을 쓴다. */
export type ClaudeEngineArgs = {
  cwd: string
  mcpConfigPath?: string
  resumeId?: string
  permissionMode?: string
  model?: string
  personaFile?: string
}

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
  /** 사용자 호칭(#138). 빈 문자열이면 기본 호칭으로 부른다. */
  callName?: () => string
}

/** 어느 엔진으로 열려 있나. 돈도 능력도 다르므로 **화면에 늘 보인다**(§5). */
export type AraEngineKind = 'cli' | 'api'

/** 화면이 받는 것 = 엔진 사건 + 이 층이 아는 것 몇 개. */
export type AraChatEvent =
  | AiEngineEvent
  /**
   * 열렸다 — 어느 엔진으로, 어느 폴더에서, MCP 도구가 물렸는지.
   * `home: true` 면 그 폴더는 **아라 폴더**(고를 것이 없어 떨어진 자리)라 화면이 경로를 감춘다 —
   * `…\AppData\…ra-home` 은 사람에게 아무것도 알려 주지 않는다(2026-08-25 준영님).
   */
  | { t: 'opened'; cwd: string | null; withMcp: boolean; engine: AraEngineKind; home?: true }
  /** 이 PC 에 `claude` 가 없다 — 설치하든지 API 키로 가든지(설계 §5). */
  | { t: 'noEngine' }
  /** 닫혔다. */
  | { t: 'closed' }
  /**
   * 계획 모드가 켜졌나/꺼졌나(#136). 화면이 이 값으로 [계획 먼저] 표시와 승인 버튼을 정한다.
   * 우리가 부른 것뿐 아니라 승인으로 풀린 것도 여기로 나간다 — 화면이 스스로 짐작하지 않는다.
   */
  | { t: 'planMode'; on: boolean }
  /** 지금 고른 모델(#137). 빈 문자열이면 사용자 기본값이다. */
  | { t: 'model'; model: string }

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
  /**
   * 계획 먼저 켜기/끄기(#136). **도는 중에도 바뀐다** — control 요청으로 모드만 갈아 끼운다
   * (실측: 재기동도 --resume 도 필요 없다).
   */
  setPlanMode(on: boolean): void
  /** 계획을 받아들였다 — 실행 모드로 풀고 "그대로 진행해" 를 보낸다. */
  approvePlan(): void
  /**
   * 모델을 고른다(#137). **도는 중에 바뀐다** — 재기동도 --resume 도 없다(실측).
   * 빈 문자열은 "사용자 기본값" 이라 열 때 인자를 안 붙인다(도는 중에는 되돌릴 말이 없어 무시한다).
   */
  setModel(model: string): void
  /** 권한 요청에 답한다. 대기열에 없는 id 는 조용히 버린다(늦게 온 답). */
  respond(requestId: string, allow: boolean): void
  interrupt(): void
  close(): void
  /** 지금 답을 기다리는 권한 요청들 — 화면이 다시 그릴 때 쓴다. */
  pending(): { requestId: string; tool: string; brief: string }[]
  isOpen(): boolean
  /** 이어서 열 때 쓸 세션 id(엔진이 알려 준 것). */
  resumeId(): string | null
}

/** 계획만 세우고 아무것도 안 건드리는 모드(실측: 실제 편집이 막힌다). */
const PLAN = 'plan'
/** 승인 뒤 갈아 끼우는 모드. `default` 는 또 막힌다 — permissionModeLine 주석 참고. */
const RUN = 'acceptEdits'
/** 승인 = 사람이 버튼을 누른 것. 그 뜻을 모델에게 한 줄로 전한다. */
const APPROVE_TEXT = '좋아, 그 계획대로 진행해 줘.'

export function createAraChat(deps: AraChatDeps): AraChat {
  let engine: AiEngine | null = null
  let handoff: AraMcpHandoff | null = null
  let persona: { path: string; cleanup: () => void } | null = null
  let offEvent: (() => void) | null = null
  let sessionId: string | null = null
  // 계획 먼저인가. 열 때 --permission-mode 로 나가고, 도는 중에는 control 요청으로 바뀐다.
  let planMode = false
  // 고른 모델(#137). 빈 문자열 = 사용자의 ~/.claude 기본값.
  let model = ''
  const waiting = new Map<string, { requestId: string; tool: string; brief: string }>()

  /** 엔진 사건 → 이 층의 규칙 → 화면. **두 엔진이 같은 배선을 쓴다**(그러라고 모양을 맞췄다). */
  const wire = (e0: AiEngine): void => {
    offEvent = e0.onEvent((e) => {
      if (e.t === 'ready' && e.sessionId) sessionId = e.sessionId
      // 권한 요청은 대기열에 담는다 — 화면이 늦게 붙어도 잃지 않는다.
      if (e.t === 'permission') waiting.set(e.requestId, { requestId: e.requestId, tool: e.tool, brief: e.brief })
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
    persona?.cleanup()
    persona = null
    waiting.clear()
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
        // 2026-08-25 준영님 지시: **자연스럽게 API 로 넘어간다.** 앞서는 "지갑이 바뀌니 사람이
        // 고른다"로 두 갈래를 보여 줬는데, 쓰는 사람 입장에서는 갈 곳이 하나뿐인 갈림길이었다.
        // 대신 **왜 넘어갔는지 알린다**(noEngine 사건 → 화면의 안내 줄)와 **엔진 토글이 눈에
        // 보이게 API 로 바뀐다** — 조용히 바꾸는 것과는 다르다.
        deps.emit({ t: 'noEngine' })
        if (deps.api) return this.open({ ...o, engine: 'api' })
        return { ok: false, noEngine: true }
      }

      // MCP 를 못 물려도 대화는 시작한다 — Claude Code 기본 기능은 그대로 산다(§3.2).
      handoff = await prepareAraMcp(deps.server, deps.vault)
      // 말투(#138) — 못 써도 대화는 시작한다(말투가 없을 뿐이다).
      try {
        persona = writePersona(buildPersona(deps.callName?.() ?? ''))
      } catch {
        persona = null
      }

      // ARA_AI_FAKE=1 이면 캔드 엔진(F16 관행). 주입(makeEngine)이 있으면 그게 먼저다.
      const make = deps.makeEngine ?? (isFakeAi() ? () => createFakeEngine() : (x: ClaudeEngineArgs) => createClaudeEngine(x))
      engine = make({
        cwd,
        ...(handoff ? { mcpConfigPath: handoff.configPath } : {}),
        ...(o.resumeId ? { resumeId: o.resumeId } : {}),
        ...(planMode ? { permissionMode: PLAN } : {}),
        ...(model ? { model } : {}),
        ...(persona ? { personaFile: persona.path } : {})
      })
      wire(engine)
      deps.emit({
        t: 'opened',
        cwd,
        withMcp: handoff !== null,
        engine: 'cli',
        ...(cwd === deps.araCwd() ? { home: true as const } : {})
      })
      return { ok: true }
    },

    send: (text) => engine?.send(text),

    setPlanMode(on) {
      if (planMode === on) return
      planMode = on
      // 열려 있으면 갈아 끼우고, 아직 안 열렸으면 다음에 열 때 인자로 나간다.
      engine?.setMode(on ? PLAN : RUN)
      deps.emit({ t: 'planMode', on })
    },

    setModel(next) {
      if (next === model) return
      model = next
      // 빈 값으로 되돌리는 것은 도는 중에 표현할 방법이 없다 — 다음에 열 때 반영된다.
      if (next) engine?.setModel(next)
      deps.emit({ t: 'model', model: next })
    },

    approvePlan() {
      if (!engine) return
      // 목표는 `default` 가 아니라 **acceptEdits** 다 — default 로는 "권한을 아직 허용하지
      // 않았다"로 또 막힌다(실측). 헤드리스에는 그 승인을 줄 창이 없다.
      planMode = false
      engine.setMode(RUN)
      deps.emit({ t: 'planMode', on: false })
      engine.send(APPROVE_TEXT)
    },

    respond: (requestId, allow) => {
      if (!waiting.delete(requestId)) return
      engine?.respondPermission(requestId, allow)
    },

    interrupt: () => engine?.interrupt(),

    close: () => {
      planMode = false
      model = ''
      if (!engine) return
      teardown()
      deps.emit({ t: 'closed' })
    },

    pending: () => [...waiting.values()],
    isOpen: () => engine !== null,
    resumeId: () => sessionId
  }
}
