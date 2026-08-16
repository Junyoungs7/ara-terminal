import { useCallback, useMemo, useState } from 'react'
import type { SessionSpec } from '../../main/sessions/ISessionManager'
import type { SessionType } from '@shared/types'

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

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // 최근 사용 순(앞이 최신). 분할이 배경 세션을 고를 때 쓴다(R2.0).
  const [mru, setMru] = useState<string[]>([])

  // 활성 세션 변경 = MRU 갱신. 활성화 경로가 여러 개(탭·트리·복원)라 한 곳으로 모은다.
  const touch = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) setMru((m) => [id, ...m.filter((x) => x !== id)])
  }, [])

  const open = useCallback(async () => {
    seq += 1
    const spec: SessionSpec = {
      type: 'local',
      title: `셸 ${seq}`,
      serverKey: 'localhost',
      cwd: undefined,
      profileId: null,
      shell: undefined
    }
    const { id } = await window.ev.session.create(spec)
    const s: Session = { id, title: spec.title, serverKey: spec.serverKey, type: 'local' }
    setSessions((t) => [...t, s])
    touch(id)
    return id
  }, [touch])

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
      setSessions((t) => [...t, { id, title: spec.title, serverKey: spec.serverKey, type: 'local' }])
      touch(id)
      return id
    },
    [touch]
  )

  // 탭 닫기 = 세션 종료(pty/ssh 정리 + 레지스트리에서 제거).
  const close = useCallback((id: string) => {
    // rdp 는 main 에 세션이 없다(릴레이는 RdpView 가 정리한다).
    if (!id.startsWith('rdp:')) void window.ev.session.destroy(id)
    setMru((m) => m.filter((x) => x !== id))
    setSessions((t) => {
      const next = t.filter((x) => x.id !== id)
      setActiveId((cur) => {
        if (cur !== id) return cur
        const idx = t.findIndex((x) => x.id === id)
        return next[idx]?.id ?? next[idx - 1]?.id ?? next[0]?.id ?? null
      })
      return next
    })
  }, [])

  const select = useCallback((id: string) => touch(id), [touch])

  // 이미 main에서 생성된 세션(연결된 SSH 등)을 레지스트리에 편입. serverKey/type은 연결부가 전달.
  const adopt = useCallback(
    (id: string, title: string, serverKey: string, type: SessionType, profileId?: string) => {
      setSessions((t) => (t.some((x) => x.id === id) ? t : [...t, { id, title, serverKey, type, profileId }]))
      touch(id)
    },
    [touch]
  )

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
