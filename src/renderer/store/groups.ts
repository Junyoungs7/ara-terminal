import { useCallback, useEffect, useState } from 'react'
import type { ConnectionProfile } from '@shared/types'
import { t } from '../i18n'

// R6 연결 그룹. R5 까지 그룹은 연결 폼에 박힌 배열(['개발','운영']) 하나였다 — 사용자가 만든 그룹은
// 폼 선택지에 나타나지 않았고, 트리 정렬도 그 두 이름을 하드코딩해 비교하고 있었다.
// 이제 목록은 두 곳에서 온다:
//   ① 프로필들의 group 값(파생)  ② ui.groups — 프로필이 아직 없는 빈 그룹(파생으로는 안 나온다)
// 정렬은 이름순 + "기타"(그룹 미지정 프로필의 자리) 마지막.

// 그룹 미지정 프로필이 모이는 자리. 실제 그룹이 아니라 표시용 이름이라 t() 로 그때그때 읽는다.
export const noneGroup = (): string => t('conn.group.none')

export function sortGroups(names: string[]): string[] {
  const none = noneGroup()
  return [...names].sort((a, b) => {
    if (a === b) return 0
    if (a === none) return 1
    if (b === none) return -1
    return a.localeCompare(b, 'ko')
  })
}

// R6 검색(트리 + 연결 관리자 프로필 리스트 공용): 이름·호스트·그룹 중 하나라도 걸리면 남긴다.
// 대소문자 무시(한글은 영향 없음). 빈 질의는 전부 통과 — 필터가 없는 것과 같다.
export function matchProfile(p: ConnectionProfile, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    p.name.toLowerCase().includes(q) ||
    p.host.toLowerCase().includes(q) ||
    (p.group ?? '').toLowerCase().includes(q)
  )
}

export function groupsOf(profiles: ConnectionProfile[], stored: readonly string[]): string[] {
  const set = new Set(stored)
  for (const p of profiles) if (p.group) set.add(p.group)
  return sortGroups([...set])
}

// 저장된 그룹 목록(빈 그룹 포함). useFont·useSidebar 와 같은 하이드레이트 → 갱신 → 영속 형태.
export function useGroupList() {
  const [stored, setStored] = useState<string[]>([])

  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => setStored(snap.ui.groups ?? []))
      .catch(() => {})
  }, [])

  const save = useCallback((next: string[]) => {
    const uniq = [...new Set(next)]
    setStored(uniq)
    // 하네스(ui:setGroups 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
    window.ev?.ui.setGroups(uniq).catch(() => {})
  }, [])

  return { stored, save }
}
