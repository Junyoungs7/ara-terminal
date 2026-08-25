import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiCliId } from '@shared/aiCli'
import { aiSessionsOf, childrenOf, restoreVerdict, sortAiSessions, defaultTitle, type AiSessionState } from '@shared/aiSession'

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
    /** 그 세션이 조용한가(F30 판정). */
    isQuiet: (sessionId: string) => boolean
    /** 폴더가 있나. 아직 못 봤으면 undefined — 그때는 있다고 친다(모른다고 끊김 표시를 하지 않는다). */
    pathExists: (s: AiSessionState) => boolean | undefined
    profileExists: (profileId: string) => boolean
  }
): WorkbenchRow[] {
  const rowOf = (s: AiSessionState, depth: 0 | 1): WorkbenchRow => {
    const sessionId = facts.sessionOf(s)
    if (sessionId) return { s, status: facts.isQuiet(sessionId) ? 'quiet' : 'live', sessionId, depth }
    const seen = facts.pathExists(s)
    const verdict = restoreVerdict(s, {
      pathExists: seen !== false,
      profileExists: s.profileId ? facts.profileExists(s.profileId) : false
    })
    return { s, status: verdict, sessionId: null, depth }
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
