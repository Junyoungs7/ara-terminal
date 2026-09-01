// 🔴 **훅 한 방이 줄 하나가 되기까지** — 이 라운드의 핵심 한 줄을 끝에서 끝까지 본다.
//
// 준영님 요청: *"터미널에서 ai cli 를 쓰면 자연스럽게 ai 세션에 켜진다."* F1a 는 훅 서버까지
// 깔았지만 목록이 `aiRuns`(= **우리가 띄운 것**)만 훑어서, 훅이 그 세션의 상태를 받고 있는
// 동안에도 화면에는 없었다. 순수 함수 검사만으로는 그 구멍이 다시 열려도 못 잡는다 —
// 구멍은 함수 하나가 아니라 **경로**에 있었기 때문이다.
//
// 그래서 여기서는 진짜 HTTP 를 쓴다: 훅 서버를 띄우고 → `PreToolUse` 를 POST 하고 →
// main 의 원장(`statuses()`)을 렌더러가 받는 그대로 `viewsOf` 에 넣고 → 사이드바 [AI] 가
// 그리는 줄(`hookRows`)까지 간다. **`registerAiRun` 은 한 번도 부르지 않는다.**
import { describe, it, expect, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createAgentHookServer, type AgentHookServerHandle } from '../src/main/agent/AgentHookServer'
import { HOOK_PANE_HEADER, HOOK_TOKEN_HEADER } from '../src/main/agent/claudeHooks'
import { aiRuns, forgetAiRun, forgetAiSession, registerAiRun, viewsOf } from '../src/renderer/store/aiSessions'
import { benchRows, groupRows, hookRows } from '../src/renderer/store/aiWorkbench'
import type { AiSessionState } from '../src/shared/aiSession'
import type { Session } from '../src/shared/types'

// 헤더 값이라 라틴만 쓴다(HTTP 헤더는 한글을 담지 못한다 — 실제 토큰도 hex 다).
const TOKEN = 'a1b2c3d4e5f6'
const servers: AgentHookServerHandle[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
})

async function serve(): Promise<{ port: number; server: AgentHookServerHandle; exited: string[] }> {
  const exited: string[] = []
  const server = createAgentHookServer({ token: TOKEN, onStatus: () => {}, onExit: (id) => void exited.push(id) })
  servers.push(server)
  const port = await server.start()
  expect(port).toBeGreaterThan(0)
  return { port, server, exited }
}

/** 훅이 셸에서 보내는 것과 같은 모양의 POST 하나(claudeHooks.ts 가 심는 명령이 이 요청을 만든다). */
function postHook(port: number, pane: string, event: string, body = '{}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/hook/claude/${event}`,
        headers: { [HOOK_TOKEN_HEADER]: TOKEN, [HOOK_PANE_HEADER]: pane }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** 그 탭이 살아 있다는 사실만 준다 — 우리가 띄운 것이 아니라 사용자가 셸에서 친 것이다. */
const shell = (id: string): Session => ({ id, type: 'local', title: 'app', serverKey: 'localhost', cwd: 'D:/work/app' })

/** 훅이 `SessionEnd` 에 싣고 오는 본문 — **누가 끝냈나는 여기에만 있다**(URL 이 아니라). */
const body = (reason: string): string => JSON.stringify({ hook_event_name: 'SessionEnd', reason })

describe('훅만 말해 준 세션이 사이드바 [AI] 에 뜬다', () => {
  it('★ POST 한 방 → 줄 하나. 실행 기록(registerAiRun)은 없다', async () => {
    const { port, server } = await serve()
    expect(await postHook(port, 'pane-1', 'PreToolUse')).toBe(204)

    // 렌더러가 `agent:state` 로 받아 가는 것과 같은 값.
    const statuses = server.statuses()
    expect(statuses.map((s) => s.sessionId)).toEqual(['pane-1'])

    const views = viewsOf([], [shell('pane-1')], statuses)
    const rows = hookRows(views, new Set(), '로컬')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionId).toBe('pane-1')
    expect(rows[0]!.state).toBe('working')
    // 그리고 그 줄은 `작업 중` 묶음에 선다.
    expect(groupRows(rows).map((g) => g.id)).toEqual(['working'])
  })

  it('★ 그 세션이 사람을 부르면 `대기 중` 으로 올라온다', async () => {
    const { port, server } = await serve()
    await postHook(port, 'pane-1', 'PreToolUse')
    await postHook(port, 'pane-1', 'Notification')

    const rows = hookRows(viewsOf([], [shell('pane-1')], server.statuses()), new Set(), '로컬')
    expect(groupRows(rows).map((g) => g.id)).toEqual(['waiting'])
  })

  it('아라 대화가 띄운 헤드리스 claude 는 줄을 만들지 않는다 — 붙일 탭이 없다', async () => {
    const { port, server } = await serve()
    // 우리 터미널에서 뜬 것이 아니면 훅에 `ARA_PANE` 이 없다 → 서버가 상태를 안 만든다.
    const noPane = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/hook/claude/Stop', headers: { [HOOK_TOKEN_HEADER]: TOKEN } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        }
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(noPane).toBe(204)
    expect(server.statuses()).toEqual([])
    expect(hookRows(viewsOf([], [shell('pane-1')], server.statuses()), new Set(), '로컬')).toEqual([])
  })
})

// 🔴 **`/exit` 한 방이 줄 하나를 지우기까지** — 위와 같은 경로를 반대로 본다.
//
// 준영님(2026-09-01): *"내가 직접 종료했으면 확인 불가가 아닌 종료 또는 목록에서 제거되어야 해.
// 지금은 해당 세션창이 꺼져야 사라져."* 탭은 그대로 두고 claude 만 나가는 경우다.
describe('사용자가 끝낸 세션은 목록에서 사라진다', () => {
  afterEach(() => {
    // 실행 기록은 모듈 스코프라 검사 사이에 샌다. `forgetAiSession` 은 이제 **표시만** 하므로
    // (그래야 작업대 ↔ 탭 링크가 산다) 여기서는 진짜로 지우는 쪽을 쓴다.
    for (const r of aiRuns()) forgetAiRun(r.sessionId)
  })

  it('★ 훅만 말해 준 세션 — `/exit` 하면 줄이 없다', async () => {
    const { port, server, exited } = await serve()
    await postHook(port, 'pane-1', 'PreToolUse')
    expect(hookRows(viewsOf([], [shell('pane-1')], server.statuses()), new Set(), '로컬')).toHaveLength(1)

    expect(await postHook(port, 'pane-1', 'SessionEnd', body('prompt_input_exit'))).toBe(204)
    expect(exited).toEqual(['pane-1'])
    // 탭은 아직 살아 있다(사람이 그 자리에서 다른 걸 할 참이다). 그래도 AI 줄은 없다.
    expect(hookRows(viewsOf([], [shell('pane-1')], server.statuses()), new Set(), '로컬')).toEqual([])
  })

  it('★ 우리가 띄운 세션 — **실행 기록까지** 지워야 줄이 사라진다', async () => {
    const { port, server, exited } = await serve()
    // [AI CLI 시작] 이 남기는 기록. 목록의 자격은 `runs ∪ statuses` 라 이것만으로도 줄이 선다.
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: Date.now() })
    await postHook(port, 'pane-1', 'PreToolUse')

    await postHook(port, 'pane-1', 'SessionEnd', body('prompt_input_exit'))
    expect(exited).toEqual(['pane-1'])

    // 🔴 여기가 준영님이 보신 화면이다: main 이 상태를 지워도 실행 기록이 남아 줄은 그대로 서 있고,
    //    상태가 없으니 `확인 불가` 로 그려진다. "종료해도 확인 불가로 안 내려간다"의 반대편.
    const stillThere = viewsOf(aiRuns(), [shell('pane-1')], server.statuses())
    expect(stillThere[0]!.state).toBe('unverifiable')

    // 제거 신호를 렌더러가 받으면(`agent.onExit` → 이 함수) 줄이 사라진다.
    for (const id of exited) forgetAiSession(id)
    expect(viewsOf(aiRuns(), [shell('pane-1')], server.statuses())).toEqual([])
    // 🔴 **기록 자체는 안 지운다** — 작업대가 이 탭을 찾는 끈이 이것뿐이다(아래 묶음이 그 자리다).
    expect(aiRuns()[0]).toMatchObject({ sessionId: 'pane-1' })
  })

  it('모르는 `reason` 은 줄을 안 지운다 — `확인 불가` 로 남는다', async () => {
    const { port, server, exited } = await serve()
    await postHook(port, 'pane-1', 'PreToolUse')
    await postHook(port, 'pane-1', 'SessionEnd', body('some_future_reason'))
    expect(exited).toEqual([])
    const rows = hookRows(viewsOf([], [shell('pane-1')], server.statuses()), new Set(), '로컬')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('unverifiable')
  })
})

// 🔴 **저장된 작업대는 다른 물건이다** — 준영님 2026-09-01 저녁 제보 ①.
//
// *"AI 세션에 잘 들어와서 컨트롤 D 로 종료했는데 **쉬는 중**으로 뜨고, 다시 클릭하면 계속
// 새 세션에 떠."* 위 묶음은 **훅만 세운 줄**만 봤다. 저장된 작업대(#129)는 목록에 따로 서 있고
// 그 줄이 어느 탭에 사는지는 **실행 기록으로만** 안다(Shell.tsx 의 `sessionOf`). 제거가 그
// 기록까지 지우면 탭이 멀쩡한데 줄이 `sessionId` 를 잃고, `groupOf` 는 `sessionId` 가 없으면
// 상태를 아예 안 보므로 `쉬는 중` 으로 떨어진다 — 그리고 `쉬는 중` 줄을 누르면 새로 띄운다.
// **두 증상이 한 줄에서 나왔다.**
describe('저장된 작업대 — Ctrl+D 뒤에도 그 탭을 잃지 않는다', () => {
  const bench: AiSessionState = {
    id: 'bench-1',
    kind: 'local',
    cwd: 'D:/work/app',
    engine: 'claude',
    skipPerms: false,
    title: 'app',
    lastUsedAt: 1_700_000_000_000
  }

  /** Shell.tsx 가 하는 그대로: 살아 있는 탭 중 폴더·CLI 가 맞는 실행 기록을 찾는다. */
  const rowsOf = (alive: readonly Session[], statuses: Parameters<typeof viewsOf>[2]) => {
    const live = new Set(alive.map((s) => s.id))
    const seen = new Map(viewsOf(aiRuns(), alive, statuses).map((v) => [v.run.sessionId, v]))
    return benchRows([bench], {
      sessionOf: (b) =>
        aiRuns().find((r) => live.has(r.sessionId) && r.path === b.cwd && r.cli === b.engine)?.sessionId ?? null,
      seen: (sid) => seen.get(sid) ?? null,
      serverOf: () => '로컬',
      pathExists: () => true,
      profileExists: () => false
    })
  }

  afterEach(() => {
    for (const r of aiRuns()) forgetAiRun(r.sessionId)
  })

  it('★ 탭이 살아 있으면 `확인 불가` 다 — `쉬는 중` 이 아니다', async () => {
    const { port, server, exited } = await serve()
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: Date.now() })
    await postHook(port, 'pane-1', 'PreToolUse')
    expect(groupRows(rowsOf([shell('pane-1')], server.statuses())).map((g) => g.id)).toEqual(['working'])

    // Ctrl+D → `other` → 제거 신호가 온다(②).
    await postHook(port, 'pane-1', 'SessionEnd', body('other'))
    expect(exited).toEqual(['pane-1'])
    for (const id of exited) forgetAiSession(id)

    const rows = rowsOf([shell('pane-1')], server.statuses())
    // ① 묶음이 고정된다: 탭이 살아 있는 한 `확인 불가` 다.
    expect(groupRows(rows).map((g) => g.id)).toEqual(['unverifiable'])
    // ② 그리고 누르면 **그 탭으로 간다** — 새로 띄우지 않는다(`onOpen` 이 sessionId 를 받는다).
    expect(rows[0]!.sessionId).toBe('pane-1')
  })

  it('탭까지 닫히면 그때는 `쉬는 중` 이다 — 저장된 작업대의 제자리', async () => {
    const { port, server, exited } = await serve()
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: Date.now() })
    await postHook(port, 'pane-1', 'SessionEnd', body('other'))
    for (const id of exited) forgetAiSession(id)

    const rows = rowsOf([], server.statuses())
    expect(groupRows(rows).map((g) => g.id)).toEqual(['idle'])
    expect(rows[0]!.sessionId).toBeNull()
  })

  it('같은 탭에서 다시 띄우면 줄이 되살아난다 — 표시가 굳지 않는다', async () => {
    const { port, server, exited } = await serve()
    registerAiRun({ sessionId: 'pane-1', cli: 'claude', path: 'D:/work/app', startedAt: Date.now() })
    await postHook(port, 'pane-1', 'SessionEnd', body('other'))
    for (const id of exited) forgetAiSession(id)

    // 사람이 그 탭에 `claude` 를 다시 친다. 토큰이 살아 있어 훅이 통하고(0bebcf0 의 검사),
    // 상태가 다시 생기므로 `exitedAt` 표시는 더 이상 줄을 가리지 못한다.
    expect(await postHook(port, 'pane-1', 'SessionStart')).toBe(204)
    expect(groupRows(rowsOf([shell('pane-1')], server.statuses())).map((g) => g.id)).toEqual(['working'])
  })
})
