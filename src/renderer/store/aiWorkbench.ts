import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentState } from '@shared/agentStatus'
import type { AiCliId } from '@shared/aiCli'
import { aiSessionsOf, childrenOf, restoreVerdict, sortAiSessions, defaultTitle, type AiSessionState } from '@shared/aiSession'
import type { AiSessionView } from './aiSessions'

/**
 * 작업대 목록(#129) — **"내가 만들어 둔 AI 세션들"**.
 *
 * 관제실(우측 [아라])과 다른 물건이다. 관제실은 하나고 대화를 하지만, 작업대는 여럿이고 각자
 * 폴더·서버를 갖는다. 그리고 **작업대는 이미 터미널 탭이다**(설계 §10.6): AI CLI 시작이 하던
 * 일이 곧 작업대를 만드는 일이라, 여기서 새로 만드는 것은 화면이 아니라 **기억**이다.
 * 그래서 #130(메인 탭으로·분할·떼어내기)이 저절로 성립한다 — 터미널 탭이 이미 그걸 다 한다.
 *
 * 이 파일이 하는 일 셋:
 *  ① 껐다 켜도 목록이 남는다(workspace.json 의 aiSessions[], 자기 채널로 flush)
 *  ② 지금 그게 **살아 있나**를 터미널 세션 쪽과 맞춰 본다
 *  ③ 폴더·서버가 사라진 것은 **'끊김'으로 둔다** — 조용히 다른 데서 열지 않는다(§10.5 규칙 3)
 */

/** 화면이 점 하나로 말하는 처지. */
export type WorkbenchStatus =
  /** 그 탭이 살아 있고 AI 가 돌고 있다. */
  | 'live'
  /** 살아 있는데 출력이 멎었다 — 승인을 기다리는 중일 수 있다(F30 이 쓰던 판정 그대로). */
  | 'quiet'
  /** 저장돼 있지만 지금 떠 있지 않다. 누르면 그 자리에서 다시 띄운다. */
  | 'idle'
  /** 폴더가 없어졌다. */
  | 'noPath'
  /** 그 서버 프로필이 없어졌다. */
  | 'noProfile'

export type WorkbenchRow = {
  s: AiSessionState
  status: WorkbenchStatus
  /** 지금 붙어 있는 터미널 세션(있으면 누를 때 그 탭으로 간다). */
  sessionId: string | null
  /** 분리 세션(worktree)이면 부모 밑으로 한 칸 들어간다. */
  depth: 0 | 1
  /**
   * 훅이 말해 준 상태(F1a). 안 떠 있거나 한 마디도 못 들었으면 `unverifiable` —
   * **조용하다고 해석하지 않는다**(그 판정이 이 기능을 못 믿게 만들었다).
   */
  state: AgentState
  /** 지금 상태가 시작된 시각. 오른쪽 경과 열과 `작업 중` 안의 정렬이 이 값 하나를 쓴다. */
  since: number
  /** 2번째 줄에 글자로 적을 서버. 서버는 **행 안의 글자**지 트리 노드가 아니다. */
  serverName: string
  /**
   * 저장해 둔 작업대인가. `false` = **훅만 보고 세운 줄**(준영님이 터미널에 직접 친 AI) —
   * 목록에서 지울 것도 분리할 것도 없다. 그 세션이 끝나면 줄도 사라진다.
   */
  saved: boolean
}

/** 같은 작업대인가 — 서버·폴더·엔진이 같으면 같은 것으로 본다(id 는 우리가 만든다). */
export function sameBench(a: Pick<AiSessionState, 'kind' | 'profileId' | 'cwd' | 'engine'>, b: AiSessionState): boolean {
  return a.kind === b.kind && (a.profileId ?? null) === (b.profileId ?? null) && a.cwd === b.cwd && a.engine === b.engine
}

/** 새로 띄운 것을 목록에 얹는다. 같은 조합이 있으면 **덮지 않고 시각만 갱신**한다(제목·분리 관계 보존). */
export function upsertBench(
  list: readonly AiSessionState[],
  entry: { kind: 'local' | 'remote'; profileId?: string; cwd: string; engine: AiCliId; skipPerms: boolean },
  now: number,
  newId: () => string
): AiSessionState[] {
  const found = list.find((x) => sameBench(entry, x))
  if (found) return list.map((x) => (x.id === found.id ? { ...x, lastUsedAt: now, skipPerms: entry.skipPerms } : x))
  return [
    ...list,
    {
      id: newId(),
      kind: entry.kind,
      ...(entry.profileId ? { profileId: entry.profileId } : {}),
      cwd: entry.cwd,
      engine: entry.engine,
      skipPerms: entry.skipPerms,
      title: defaultTitle(entry.cwd),
      lastUsedAt: now
    }
  ]
}

/**
 * 목록 → 화면에 그릴 줄들. 분리 세션은 **부모 바로 밑**에 붙는다(설계 §10.3 규칙 4 —
 * 부모·자식 관계가 보여야 지울 때 무엇이 함께 사라지는지 안다).
 */
export function benchRows(
  list: readonly AiSessionState[],
  facts: {
    /** 그 작업대에 붙어 있는 터미널 세션 id(없으면 null). */
    sessionOf: (s: AiSessionState) => string | null
    /**
     * 그 세션의 처지(못 들었으면 null). 단일 출처는 `aiSessions.ts` 의 뷰다 — 같은 사실을
     * 사이드바와 알림이 각자 계산하면 두 벌로 갈린다.
     *
     * 예전에는 `isQuiet(sessionId): boolean` — "출력이 60초 멎었나"였다. 그 한 줄이 3분짜리
     * 빌드를 "기다립니다"로 만들었고 F1a 가 근거를 통째로 갈았다(shared/agentStatus.ts).
     */
    seen: (sessionId: string) => AiSessionView | null
    /** 2번째 줄에 적을 서버 이름. 프로필 이름이 곧 사람이 부르는 이름이다. */
    serverOf: (s: AiSessionState) => string
    /** 폴더가 있나. 아직 못 봤으면 undefined — 그때는 있다고 친다(모른다고 끊김 표시를 하지 않는다). */
    pathExists: (s: AiSessionState) => boolean | undefined
    profileExists: (profileId: string) => boolean
  }
): WorkbenchRow[] {
  const rowOf = (s: AiSessionState, depth: 0 | 1): WorkbenchRow => {
    const serverName = facts.serverOf(s)
    const sessionId = facts.sessionOf(s)
    if (sessionId) {
      const v = facts.seen(sessionId)
      // `gone`(탭이 사라졌다)은 여기 올 수 없다 — 세션이 있어서 sessionId 를 받았다.
      const state = v && v.state !== 'gone' ? v.state : 'unverifiable'
      return {
        s,
        // `quiet` 는 이제 **훅이 기다린다고 말한 것**이다 — 옛 이름을 그대로 두는 이유는
        // 점 색·툴팁·e2e 가 이 값으로 쓰여 있어서고, 뜻이 바뀐 자리는 여기 한 줄뿐이다.
        status: state === 'waiting' ? 'quiet' : 'live',
        sessionId,
        depth,
        state,
        since: v?.stateStartedAt ?? s.lastUsedAt,
        serverName,
        saved: true
      }
    }
    const seen = facts.pathExists(s)
    const verdict = restoreVerdict(s, {
      pathExists: seen !== false,
      profileExists: s.profileId ? facts.profileExists(s.profileId) : false
    })
    // 안 떠 있는 작업대에는 물어볼 CLI 가 없다 — 나이는 **마지막으로 쓴 때**로 잰다.
    return {
      s,
      status: verdict,
      sessionId: null,
      depth,
      state: 'unverifiable',
      since: s.lastUsedAt,
      serverName,
      saved: true
    }
  }

  const out: WorkbenchRow[] = []
  const parents = sortAiSessions(list.filter((s) => !s.worktree))
  for (const p of parents) {
    out.push(rowOf(p, 0))
    for (const c of sortAiSessions(childrenOf(list, p.id))) out.push(rowOf(c, 1))
  }
  // 부모를 잃은 분리 세션도 보여 준다 — 안 보이면 지울 방법이 없다(유령 폴더가 디스크에 남는다).
  const shown = new Set(out.map((r) => r.s.id))
  for (const s of sortAiSessions(list)) if (!shown.has(s.id)) out.push(rowOf(s, 0))
  return out
}

/** 훅만 보고 세운 줄의 id 앞머리. 저장된 작업대 id(UUID)와 절대 겹치지 않게. */
export const HOOK_ROW_ID = 'hook:'

/**
 * 🔴 **훅이 말했는데 작업대에 없는 세션** → 줄.
 *
 * 준영님 요청은 *"터미널에서 ai cli 를 쓰면 자연스럽게 ai 세션에 켜진다"* 였다. 우리 문
 * (`AI CLI 시작`)으로 띄운 것만 적립하면 그 문을 안 지난 것은 훅이 상태를 보내오는 동안에도
 * 화면에 없다 — **훅이 말을 걸어 온 이상 그 세션은 목록에 있다.**
 *
 * 저장은 하지 않는다. 우리가 안 띄웠으니 무엇을 어떤 플래그로 띄웠는지 모르고, 모르는 것을
 * 적립하면 다음에 그 줄을 눌렀을 때 **엉뚱한 명령**이 나간다(설계 §10.5 규칙 3 과 같은 이유).
 */
export function hookRows(
  views: readonly AiSessionView[],
  /** 이미 작업대 줄이 있는 세션 — 같은 세션을 두 줄로 그리지 않는다. */
  saved: ReadonlySet<string>,
  /** 로컬 세션의 서버 칸에 적을 말. `serverKey`('localhost')를 그대로 쓰면 화면 어휘가 갈린다. */
  localLabel: string
): WorkbenchRow[] {
  const out: WorkbenchRow[] = []
  for (const v of views) {
    // 탭이 사라진 것은 그리지 않는다 — 갈 곳이 없는 줄이고, 그 자리는 작업대 목록의 몫이다.
    if (v.state === 'gone' || saved.has(v.run.sessionId)) continue
    out.push({
      s: {
        id: HOOK_ROW_ID + v.run.sessionId,
        kind: v.session?.type === 'ssh' ? 'remote' : 'local',
        cwd: v.run.path,
        engine: v.run.cli,
        // 무엇으로 띄웠는지 모른다. **켜졌다고 주장하지 않는다** — 이 표시는 켜져 있을 때만 뜬다.
        skipPerms: false,
        title: v.session?.title || defaultTitle(v.run.path),
        lastUsedAt: v.stateStartedAt
      },
      status: v.state === 'waiting' ? 'quiet' : 'live',
      sessionId: v.run.sessionId,
      depth: 0,
      state: v.state,
      since: v.stateStartedAt,
      serverName: v.session?.type === 'ssh' ? v.serverName : localLabel,
      saved: false
    })
  }
  return out
}

/**
 * 묶음 축은 **상태**다. Orca 는 `고정/진행 중`으로 묶는데 그대로 옮기면 `대기 중` 한 줄이
 * 진행 중 열두 번째에 파묻힌다 — 저쪽이 안 아쉬운 이유는 **그 제품에 대기 상태가 없기**
 * 때문이다(에이전트가 묻지 않는다). 우리는 묻는다.
 */
export type BenchGroupId = AgentState | 'idle'

/** 볼 이유가 있는 것이 위로. 맨 아래 `idle` 은 지금 아무 일도 안 하는 **기억**이다. */
const GROUP_ORDER: readonly BenchGroupId[] = ['waiting', 'working', 'done', 'unverifiable', 'idle']

/** 기본으로 접는 묶음 — 끝난 것은 쌓이기만 하고 급하지 않다. */
export const GROUP_FOLDED: readonly BenchGroupId[] = ['done']

/**
 * ⚠️ **안 떠 있는 작업대는 `unverifiable` 이 아니다.** 훅이 없어서 모르는 것과, 애초에 도는
 * 프로세스가 없어서 물어볼 데가 없는 것은 다르다 — 껐다 켠 직후 저장된 작업대 전부가
 * `확인 불가` 로 뜨면 그 라벨이 고장 신호처럼 읽힌다.
 */
export function groupOf(r: WorkbenchRow): BenchGroupId {
  return r.sessionId ? r.state : 'idle'
}

export type BenchGroup = { id: BenchGroupId; rows: WorkbenchRow[] }

/**
 * 줄들 → 묶음들. 빈 묶음은 만들지 않는다(머리 하나가 두 줄 값이라, 264px 에서 라벨이 내용보다
 * 많아 보이는 것이 목업 라운드가 d3 에서 잡은 실패다).
 */
export function groupRows(rows: readonly WorkbenchRow[]): BenchGroup[] {
  const by = new Map<BenchGroupId, WorkbenchRow[]>()
  for (const r of rows) {
    const g = groupOf(r)
    const cur = by.get(g)
    if (cur) cur.push(r)
    else by.set(g, [r])
  }
  // **`작업 중` 안에서는 오래 멈춘 순.** 큰 묶음 하나는 결국 평평한 목록이라, 위 두세 줄이
  // "뭐가 막혔나"에 답해야 한다. 다른 묶음은 들어온 차례(최근 쓴 것이 위)를 그대로 둔다.
  by.get('working')?.sort((a, b) => a.since - b.since)
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => {
    const rows = by.get(g)!
    // 부모가 다른 묶음에 갔으면 들여쓰기를 푼다 — 딸려 갈 부모가 화면에 없는데 한 칸 들어가
    // 있으면 세로선이 허공에서 시작한다. 상태가 묶음을 이기고, 계보는 그때 표시를 접는다.
    const here = new Set(rows.map((r) => r.s.id))
    return {
      id: g,
      rows: rows.map((r) =>
        r.depth === 1 && !here.has(r.s.worktree?.parentId ?? '') ? { ...r, depth: 0 as const } : r
      )
    }
  })
}

/**
 * 오른쪽 경과 열 — **라틴/숫자만.** `3분`으로 쓰면 한글 하한(11px) 때문에 `--fs-nano`(10.5px)를
 * 못 쓰고, 그러면 `--text-dim` 이 명도의 바닥이라 제목/2줄/시각이 3단으로 눌린다.
 * 라틴이면 크기 한 단이 공짜로 생겨 4단이 된다(tokens.css §글자 척도).
 */
export function agoText(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  return `${Math.floor(hour / 24)}d`
}

/** 목록의 주인. 하이드레이트 → 바뀔 때마다 자기 채널로 flush. */
export function useAiWorkbench() {
  const [list, setList] = useState<AiSessionState[]>([])
  // 폴더가 실제로 있는지 — 한 번 본 것만 담는다(모르는 것을 끊김으로 표시하지 않기 위해).
  const [paths, setPaths] = useState<Record<string, boolean>>({})
  const hydrated = useRef(false)

  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => {
        const got = aiSessionsOf((snap as { aiSessions?: unknown }).aiSessions)
        hydrated.current = true
        setList(got)
        // 로컬 폴더만 확인한다. 원격은 그 서버에 붙기 전에는 알 수 없고, 붙는 순간 터미널이 말해 준다.
        for (const s of got) {
          if (s.kind !== 'local') continue
          void window.ev?.fs
            .list(s.cwd)
            .then((r) => setPaths((p) => ({ ...p, [s.cwd]: r.ok })))
            .catch(() => setPaths((p) => ({ ...p, [s.cwd]: false })))
        }
      })
      .catch(() => {
        hydrated.current = true
      })
  }, [])

  // 하이드레이트 전에는 저장하지 않는다 — 빈 목록으로 사용자 것을 덮으면 안 된다(F6 에서 배운 것).
  useEffect(() => {
    if (!hydrated.current) return
    void window.ev?.ara.saveSessions(list)
  }, [list])

  const record = useCallback(
    (entry: { kind: 'local' | 'remote'; profileId?: string; cwd: string; engine: AiCliId; skipPerms: boolean }) =>
      setList((cur) => upsertBench(cur, entry, Date.now(), () => crypto.randomUUID())),
    []
  )
  const remove = useCallback(
    (id: string) => setList((cur) => cur.filter((s) => s.id !== id && s.worktree?.parentId !== id)),
    []
  )
  /** #133 분리 세션을 목록에 넣는다 — 부모를 기억한다(§10.3 규칙 4). */
  const addChild = useCallback(
    (parent: AiSessionState, cwd: string, branch: string) =>
      setList((cur) => [
        ...cur,
        {
          id: crypto.randomUUID(),
          kind: parent.kind,
          ...(parent.profileId ? { profileId: parent.profileId } : {}),
          cwd,
          engine: parent.engine,
          skipPerms: parent.skipPerms,
          title: defaultTitle(cwd),
          lastUsedAt: Date.now(),
          worktree: { parentId: parent.id, branch }
        }
      ]),
    []
  )

  const rename = useCallback(
    (id: string, title: string) => setList((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s))),
    []
  )

  return { list, paths, record, remove, rename, addChild }
}
