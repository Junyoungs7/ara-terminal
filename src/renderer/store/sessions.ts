import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSpec } from '../../main/sessions/ISessionManager'
import type { SessionType } from '@shared/types'
import { forgetSessionState } from './sessionState'

// 렌더러 세션 레지스트리 — 트리·탭·패널이 공유하는 단일 소스(이중 상태 금지, F4b).
// 세션의 홈은 탭이다: 탭 닫기 = 세션 종료, 패널 닫기 = detach(세션 유지, 탭에 남음).
export type Session = {
  id: string
  title: string
  serverKey: string
  type: SessionType
  /** 어느 연결 프로필로 붙었는지. rdp 는 RdpView 가 릴레이를 열 때, ssh 는 파일 탐색기가
   *  "이 서버 탭이 쓸 세션"을 찾을 때 본다. 로컬 세션에는 없다. */
  profileId?: string
  /** F32: 이 세션을 가진 창(없으면 본창). 소유의 단일 출처는 main 이고 여기는 사본이다. */
  winId?: string
}
// 하위호환 별칭(기존 import 유지).
export type Tab = Session

// 탭바 서버 그룹(목업 .tg): 같은 serverKey 세션을 묶는다. 로컬은 단독 그룹.
export type SessionGroup = { serverKey: string; local: boolean; color: string; sessions: Session[] }

// serverKey → 그룹색(결정론적 선택). 로컬은 accent, 원격은 해시로 분산.
// **토큰을 쓴다**(2026-08-16). 예전에는 여기 HEX 배열이 박혀 있었고 그중 둘이 `--err`·`--ok` 와
// 글자 그대로 같아서, 서버 2번 dot 이 "오류" 빨강으로 3번이 "정상" 초록으로 보였다.
// 색은 tokens.css 의 --srv-1~6 이 소유한다 — 라이트 테마·색약 모드가 오면 그 파일 하나만 고친다.
const GROUP_COLORS = ['var(--srv-1)', 'var(--srv-2)', 'var(--srv-3)', 'var(--srv-4)', 'var(--srv-5)', 'var(--srv-6)']
export function groupColor(serverKey: string, local: boolean): string {
  if (local) return 'var(--accent)'
  let h = 0
  for (let i = 0; i < serverKey.length; i++) h = (h * 31 + serverKey.charCodeAt(i)) >>> 0
  return GROUP_COLORS[h % GROUP_COLORS.length]
}

/**
 * 세션 하나를 글자로 소개한다 — `제목 · 서버`(툴팁 전용, 순수).
 *
 * #166 에서 점이 서버색을 잃었다(점은 이제 상태만 말한다 — sessionState.ts). 그 단서를 **글자로**
 * 옮긴 자리가 여기다. 제목이 곧 서버 이름인 경우가 많지만 늘 그렇지는 않다: 사용자가 바꿀 수
 * 있고(R2.1) 셸의 OSC 제목이 덮어쓴다(R3.6) — 그때 탭에서 서버를 알 방법이 하나도 없어진다.
 * 같으면 두 번 적지 않는다.
 */
export function sessionTip(s: Session): string {
  return s.title === s.serverKey ? s.title : `${s.title} · ${s.serverKey}`
}

// 세션 목록 → 삽입 순서를 보존한 서버 그룹 배열(순수 — 단위 테스트 대상).
export function groupSessions(sessions: Session[]): SessionGroup[] {
  const groups: SessionGroup[] = []
  const byKey = new Map<string, SessionGroup>()
  for (const s of sessions) {
    const local = s.type === 'local'
    let g = byKey.get(s.serverKey)
    if (!g) {
      g = { serverKey: s.serverKey, local, color: groupColor(s.serverKey, local), sessions: [] }
      byKey.set(s.serverKey, g)
      groups.push(g)
    }
    g.sessions.push(s)
  }
  return groups
}

// 탭 드래그 재정렬(R2.3) — dragId 를 overId 자리로 옮긴다.
// FB-tabs: 그룹 래퍼를 없애 탭이 평평한 개별 탭이 된 뒤로는 서버가 달라도 자유롭게 순서를 바꿀 수 있다
// (서버 소속은 여전히 세션 속성 serverKey 그대로 — 위치를 옮겨도 바뀌지 않는다).
//
// id 만 보므로 세션 전용이 아니다 — 파일 탐색기 탭(explorerTabs)도 같은 함수를 탄다.
// 바뀔 것이 없으면 **같은 배열을 그대로** 돌려준다(호출측이 참조 비교로 재렌더를 아낀다).
export function reorderById<T extends { id: string }>(list: T[], dragId: string, overId: string): T[] {
  if (dragId === overId) return list
  const from = list.findIndex((s) => s.id === dragId)
  const to = list.findIndex((s) => s.id === overId)
  if (from < 0 || to < 0) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export const reorderSessions = reorderById<Session>

/**
 * main 의 스냅샷으로 이 창의 목록을 맞추되 **main 이 모르는 세션은 남긴다.**
 *
 * 2026-09-01 준영님 제보: *"분리된 창을 다시 탭에 붙이면 rdp 창이 꺼지거나 사라져."* 되돌리기는
 * `session:moved` → refreshFromMain 을 태우는데, 그게 목록을 main 스냅샷으로 **통째로 덮었다.**
 * RDP 세션은 pty 가 없어 main 에 없다(openRdp 는 렌더러 목록에만 넣는다) → 목록에서 빠지고 →
 * RdpView 가 언마운트되며 그 cleanup 이 릴레이까지 끊었다. **터미널이 멀쩡했던 이유가 그 차이다**
 * (터미널은 main 에 살아 있어 스냅샷에 그대로 들어 있다).
 *
 * `type === 'rdp'` 만 남긴다 — "main 이 모르는 것 전부"로 넓히면 main 에서 죽은 세션의 껍데기
 * 탭까지 영영 남는다(그 정리가 이 덮어쓰기의 본래 일이다).
 *
 * 순서는 **이 창의 탭 순서**를 따른다 — 스냅샷 순서는 생성 순이라 드래그 재정렬(R2.3)을 모른다.
 */
export function mergeMainSnapshot(cur: Session[], mine: Session[]): Session[] {
  const byId = new Map(mine.map((m) => [m.id, m]))
  const known = new Set(cur.map((s) => s.id))
  const kept = cur.filter((s) => byId.has(s.id) || s.type === 'rdp').map((s) => byId.get(s.id) ?? s)
  return [...kept, ...mine.filter((m) => !known.has(m.id))]
}

/**
 * 탭 하나가 목록에서 빠졌다 — **그 자리를 누가 채우는가.**
 *
 * **직전에 보던 탭(MRU)** 이다 — 2026-09-02 준영님 결정. 그 앞의 규칙(오른쪽 → 왼쪽 → 첫 탭)은
 * 이제 **MRU 가 비었을 때의 폴백**이다: 이 창에서 아직 아무 탭도 본 적이 없는 경우(첫 세션을
 * 떼어냈다)가 그것이다. 활성 탭이 아니었으면 아무것도 안 바뀐다.
 *
 * MRU 목록에는 **이미 없어진 세션이 남아 있을 수 있다**(다른 창으로 떠났거나 닫혔다) — 그래서
 * 살아 있는 것(`rest`) 중 가장 최근을 고른다. 목록 자체는 useSessions 의 `mru` 를 그대로 쓴다.
 * 새 기록을 만들지 않는다: 그 기록은 분할이 배경 세션을 고를 때(pickBackgroundSession) 이미 쓰고
 * 있고, 활성 탭이 바뀌는 모든 길이 `touch` 한 곳으로 모여 있다.
 *
 * 이 규칙이 함수인 이유: 탭이 빠지는 길이 **둘**이다 — ✕ 로 닫기(close)와 창으로 떼어내기
 * (`session:moved`). 2026-09-02 준영님 제보 *"창 분리하면 아라 기본 창에서는 바로 이전 세션 창이
 * 켜져야 하는데 안 켜지고 있어"* 가 그 둘이 갈라져 있어서 나왔다: 닫기에만 규칙이 있었고
 * 떼어내기는 탭만 지우고 activeId 를 떠난 세션에 둔 채로 뒀다(그 세션의 칸은 아무것도 안 그린다 →
 * 빈 창). 두 길이 다르게 굴면 그게 다음 제보라서, 규칙을 한 곳에 둔다.
 *
 * ⚠️ **✕ 로 닫을 때도 같은 규칙이다.** 준영님은 분리를 말씀하셨지만 갈라 두지 않는다 — 위 문단이
 * 곧 그 이유다(둘이 다르게 굴어서 나온 제보를 고치는 중에 다시 가르는 셈이다). 관례로도 어긋나지
 * 않는다: VS Code 는 닫은 뒤 **최근에 쓰던 편집기**로 간다(focusRecentEditorAfterClose 가 기본값
 * true)이고, 이 앱의 팔레트·F1 이 이미 그쪽 관례를 따른다. 브라우저(오른쪽 탭)와는 갈리지만
 * 여기 탭은 브라우저 탭보다 편집기 탭에 가깝다 — 서버 작업은 두 탭을 오가며 한다.
 */
export function nextActiveAfter(
  before: Session[],
  removedId: string,
  cur: string | null,
  mru: readonly string[] = []
): string | null {
  if (cur !== removedId) return cur
  const idx = before.findIndex((x) => x.id === removedId)
  if (idx < 0) return cur
  const rest = before.filter((x) => x.id !== removedId)
  const recent = mru.find((id) => id !== removedId && rest.some((x) => x.id === id))
  return recent ?? rest[idx]?.id ?? rest[idx - 1]?.id ?? rest[0]?.id ?? null
}

// 분할이 새 패널에 올릴 배경 세션(패널 미배치) 고르기 — 최근 사용 순, 그다음 탭 순서(R2.0).
// 없으면 null(호출부가 새 로컬 셸을 만든다).
export function pickBackgroundSession(
  sessions: Session[],
  placed: ReadonlySet<string>,
  mru: readonly string[]
): string | null {
  const free = sessions.filter((s) => !placed.has(s.id))
  if (free.length === 0) return null
  return mru.find((id) => free.some((s) => s.id === id)) ?? free[0].id
}

let seq = 0

/**
 * @param winId 이 창의 id. undefined 면 **본창** — winId 가 없는 세션만 본다.
 *
 * 왜 창마다 목록이 다른가: 세션은 한 창에만 있다(두 창에서 같은 세션을 그리면 xterm 인스턴스가
 * 둘이라 스크롤백이 갈라진다 — 같은 터미널인데 위로 올려 본 내용이 창마다 다르면 하자다).
 * **소유는 main 이 정한다**(Session.winId) — 이 훅은 `session:moved` 를 받아 사본을 맞출 뿐이다.
 */
export function useSessions(winId?: string) {
  const [sessions, setSessions] = useState<Session[]>([])
  // 지금 목록의 최신 사본. refreshFromMain 이 비동기라 클로저 값으로는 낡은 목록을 합치게 된다.
  const listRef = useRef<Session[]>(sessions)
  listRef.current = sessions
  const [activeId, setActiveId] = useState<string | null>(null)
  // 최근 사용 순(앞이 최신). 분할이 배경 세션을 고를 때(R2.0), 그리고 탭이 빠진 자리를 채울 때
  // (nextActiveAfter) 쓴다. setState 업데이터 안에서 읽어야 해서 listRef 와 같은 사본을 둔다 —
  // 클로저의 mru 는 알림이 도착한 시점의 낡은 값이다.
  const [mru, setMru] = useState<string[]>([])
  const mruRef = useRef<string[]>(mru)
  mruRef.current = mru

  // 활성 세션 변경 = MRU 갱신. 활성화 경로가 여러 개(탭·트리·복원)라 한 곳으로 모은다.
  const touch = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) setMru((m) => [id, ...m.filter((x) => x !== id)])
  }, [])

  /**
   * 이미 main 에 있는 세션을 이 창의 목록에 넣는다. serverKey·type 은 부르는 쪽이 안다.
   *
   * **모든 편입이 이 문을 지난다** — 내가 연 것도, 아라가 연 것도. 같은 id 를 두 번 넣지 않으므로
   * `session:create` 의 응답과 `session:opened` 알림이 어느 순서로 도착해도 탭은 하나다.
   */
  const adopt = useCallback(
    (id: string, title: string, serverKey: string, type: SessionType, profileId?: string) => {
      setSessions((t) => (t.some((x) => x.id === id) ? t : [...t, { id, title, serverKey, type, profileId }]))
      touch(id)
    },
    [touch]
  )

  const open = useCallback(async () => {
    seq += 1
    const spec: SessionSpec = {
      type: 'local',
      title: `셸 ${seq}`,
      serverKey: 'localhost',
      cwd: undefined,
      profileId: null,
      shell: undefined,
      // 이 창이 주인이다 — 안 주면 main 이 본창 것으로 잡아 출력이 저쪽으로 간다.
      ...(winId ? { winId } : {})
    }
    const { id } = await window.ev.session.create(spec)
    adopt(id, spec.title, spec.serverKey, 'local')
    return id
  }, [adopt, winId])

  // F25: RDP 세션은 pty 가 없다 — 렌더러 레지스트리에만 넣고 화면은 RdpView 가 그린다.
  // id 에 접두를 둬서 close·persist 가 main 세션과 구분할 수 있게 한다.
  const openRdp = useCallback(
    (profileId: string, title: string, serverKey: string): string => {
      seq += 1
      const id = `rdp:${profileId}:${seq}`
      setSessions((t) => [...t, { id, title, serverKey, type: 'rdp', profileId }])
      touch(id)
      return id
    },
    [touch]
  )

  // F6 복원: 저장된 로컬 세션을 명시 spec(cwd 등)으로 재스폰하고 레지스트리에 편입. 새 id 반환.
  // ssh 세션은 여기서 만들지 않는다(connectProfile 경로가 만든 뒤 adopt).
  const restoreLocal = useCallback(
    async (spec: SessionSpec): Promise<string> => {
      const { id } = await window.ev.session.create(spec)
      adopt(id, spec.title, spec.serverKey, 'local')
      return id
    },
    [adopt]
  )

  // 탭 닫기 = 세션 종료(pty/ssh 정리 + 레지스트리에서 제거).
  const close = useCallback((id: string) => {
    // rdp 는 main 에 세션이 없다(릴레이는 RdpView 가 정리한다).
    if (!id.startsWith('rdp:')) void window.ev.session.destroy(id)
    // 점의 상태도 함께 버린다(#166). 탭이 빠지는 길은 여럿이지만(✕·칸 닫기·오류 카드 [닫기]·
    // 재접속) **전부 이 함수를 지난다** — 흩어 놓으면 한 길만 안 지운다.
    forgetSessionState(id)
    // 지우기 **전에** 읽는다 — 이 세션이 활성이었다면 기록의 맨 앞이 자기 자신이고, 그 다음이
    // "직전에 보던 탭"이다(nextActiveAfter 가 자기 자신은 건너뛴다).
    const recent = mruRef.current
    setMru((m) => m.filter((x) => x !== id))
    setSessions((t) => {
      setActiveId((cur) => nextActiveAfter(t, id, cur, recent))
      return t.filter((x) => x.id !== id)
    })
  }, [])

  const select = useCallback((id: string) => touch(id), [touch])

  // 탭 이름 변경(R2.1). main 의 meta 가 스냅샷 저장의 진실이므로 IPC 를 함께 호출한다.
  const rename = useCallback((id: string, title: string) => {
    const next = title.trim()
    if (!next) return
    void window.ev.session.rename(id, next)
    setSessions((t) => t.map((s) => (s.id === id ? { ...s, title: next } : s)))
  }, [])

  // R3.6: main 이 이미 받아들인 제목(셸 OSC 0/2)을 탭 라벨에만 반영한다.
  // rename 과 달리 IPC 를 되쏘지 않는다 — 되쏘면 자동 제목이 "사용자가 정한 이름"으로 굳어 버린다.
  const applyTitle = useCallback((id: string, title: string) => {
    setSessions((t) => t.map((s) => (s.id === id ? { ...s, title } : s)))
  }, [])

  // 탭 드래그 재정렬(R2.3). 탭 순서 = sessions 배열 순서 = 스냅샷 저장 순서.
  const reorder = useCallback((dragId: string, overId: string) => {
    setSessions((t) => reorderSessions(t, dragId, overId))
  }, [])

  // 매 렌더 새 배열을 만들면 이걸 deps 로 쓰는 이펙트가 매 렌더 돈다(persist 가 그랬다 — 백로그 M-1).
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  /**
   * F32: 이 창이 가진 세션을 main 에서 다시 읽는다.
   *
   * 떼어낸 창은 세션을 **자기가 만들지 않았다**(본창에서 떼어져 왔다) — 그래서 여느 창처럼
   * "내가 연 것을 기억"하는 방식으로는 목록이 영영 비어 있다. main 의 스냅샷이 유일한 출처다.
   *
   * 단 스냅샷은 **main 이 아는 것만** 담는다 — 합치는 규칙은 mergeMainSnapshot 이 갖는다(제보 ②).
   */
  const refreshFromMain = useCallback(async () => {
    const all = await window.ev?.session.list().catch(() => null)
    if (!all) return
    const mine = all
      .filter((m) => (m.winId ?? undefined) === winId)
      .map<Session>((m) => ({
        id: m.id,
        title: m.title,
        serverKey: m.serverKey,
        type: m.type,
        ...(m.profileId ? { profileId: m.profileId } : {}),
        ...(m.winId ? { winId: m.winId } : {})
      }))
    // 비동기라 클로저의 sessions 는 낡았을 수 있다 — 지금 목록을 ref 에서 읽는다.
    const next = mergeMainSnapshot(listRef.current, mine)
    setSessions(next)
    setActiveId((cur) => (cur && next.some((x) => x.id === cur) ? cur : (next[0]?.id ?? null)))
  }, [winId])

  // 떼어낸 창은 뜨자마자 자기 세션을 받아 온다(본창은 F6 복원이 그 일을 한다 — 두 번 하지 않는다).
  useEffect(() => {
    if (winId) void refreshFromMain()
  }, [winId, refreshFromMain])

  /**
   * main 에서 세션이 생겼다 — **내가 열지 않은 세션이 화면에 나타나는 유일한 길.**
   *
   * 아라가 MCP `ssh_connect` 로 서버에 붙으면 세션은 진짜로 살아 있는데 화면엔 아무것도 없었다
   * (2026-08-26 준영님 제보). 렌더러 목록이 "내가 연 것"만 기억하는 구조였기 때문이고, 그래서
   * 사람이 그 연결을 볼 수도 닫을 수도 없었다.
   *
   * `winId` 로 거른다 — 세션은 한 창에만 있다(같은 세션을 두 창이 그리면 스크롤백이 갈라진다).
   */
  useEffect(() => {
    const off = window.ev?.session.onOpened?.((m) => {
      if ((m.winId ?? undefined) !== winId) return
      adopt(m.id, m.title, m.serverKey, m.type, m.profileId ?? undefined)
    })
    return () => off?.()
  }, [winId, adopt])

  // 소유 창이 바뀌면(떼어내기·되돌리기·그 창이 닫힘) 사본을 맞춘다. 본창은 "돌아온 세션"을
  // 여기서 처음 알고, 떼어낸 창은 "내 세션이 아니게 됐다"를 안다.
  useEffect(() => {
    const off = window.ev?.window.onSessionMoved?.(({ sessionId, winId: to }) => {
      if ((to ?? undefined) === winId) {
        void refreshFromMain() // 내 창으로 왔다 — 메타를 main 에서 받아 온다
        return
      }
      // 떠났다(세션은 살아 있다 — 다른 창이 그린다). 활성 탭이었으면 **✕ 로 닫을 때와 같은 규칙**으로
      // 그 자리를 채운다 — 안 그러면 없는 세션이 활성인 채 남아 이 창이 빈다(2026-09-02 제보 ②).
      // close 와 같은 순서다: 기록을 읽고 → 자리를 정하고 → 기록에서 뺀다.
      const recent = mruRef.current
      setSessions((cur) => {
        setActiveId((a) => nextActiveAfter(cur, sessionId, a, recent))
        return cur.filter((x) => x.id !== sessionId)
      })
      setMru((m) => m.filter((x) => x !== sessionId))
    })
    return () => off?.()
  }, [winId, refreshFromMain])

  return {
    sessions,
    activeId,
    mru,
    open,
    openRdp,
    restoreLocal,
    close,
    select,
    adopt,
    rename,
    applyTitle,
    reorder,
    groups
  }
}
