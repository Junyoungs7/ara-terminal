// 작업 프로필 — "이 서버의 이 폴더"를 이름 붙여 저장한 목록(연결 프로필과 별개).
// 한 서버에 작업 위치가 여럿일 수 있고 로컬 폴더도 같은 목록에 들어간다. 그래서 사이드바 트리에
// 새 행을 만들지 않고 **팝업 목록**으로만 보여 준다(트리 계층을 더 깊게 만들지 않는다).
import { useCallback, useEffect, useState } from 'react'
import type { WorkProfile } from '@shared/types'

/** 표시용 검색 — 이름·경로·서버명 아무 데나 걸리면 남긴다(순수 · 단위 테스트 대상). */
export function matchWorkProfile(w: WorkProfile, serverName: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    w.name.toLowerCase().includes(q) ||
    w.path.toLowerCase().includes(q) ||
    serverName.toLowerCase().includes(q)
  )
}

/** 같은 이름이 이미 있으면 뒤에 번호를 붙인다 — 목록에서 구분이 안 되면 저장이 의미가 없다. */
export function uniqueWorkName(list: readonly WorkProfile[], name: string): string {
  const base = name.trim() || '작업 위치'
  if (!list.some((w) => w.name === base)) return base
  for (let i = 2; i < 1000; i++) {
    const next = `${base} ${i}`
    if (!list.some((w) => w.name === next)) return next
  }
  return base
}

export function useWorkProfiles() {
  const [list, setList] = useState<WorkProfile[]>([])

  // 스냅샷에서 1회 하이드레이트(그룹 목록과 같은 경로 — 별도 저장소를 만들지 않는다).
  useEffect(() => {
    void window.ev?.workspace
      .load()
      .then((snap) => setList(snap.ui.workProfiles ?? []))
      .catch(() => {})
  }, [])

  const persist = useCallback((next: WorkProfile[]) => {
    setList(next)
    void window.ev?.ui.setWorkProfiles(next).catch(() => {})
  }, [])

  const add = useCallback(
    (name: string, profileId: string | null, path: string): void => {
      setList((cur) => {
        const next = [
          ...cur,
          { id: `w${Date.now().toString(36)}${cur.length}`, name: uniqueWorkName(cur, name), profileId, path }
        ]
        void window.ev?.ui.setWorkProfiles(next).catch(() => {})
        return next
      })
    },
    []
  )

  const remove = useCallback((id: string) => persist(list.filter((w) => w.id !== id)), [list, persist])
  const rename = useCallback(
    (id: string, name: string) =>
      persist(list.map((w) => (w.id === id ? { ...w, name: uniqueWorkName(list.filter((x) => x.id !== id), name) } : w))),
    [list, persist]
  )

  return { list, add, remove, rename }
}
