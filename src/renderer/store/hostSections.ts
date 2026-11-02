// M15 R2 WS-22 여러 서버 묶어 보기(herdr H8 "저장된 SSH 머신 묶음" · Orca 사이드바 host sections, orcaRef ec112c6b01
// src/shared/sidebar-list/host-section-rows.ts·host-section-order.ts 의 핵심만).
// AI 작업 공간의 작업 단위를 호스트(이 PC · 관리형 서버)별로 묶는다. 서버의 순서·그룹은 **터미널 연결 사이드바와 같은 구현**
// (store/groups.ts groupServers)에서 온다 — 사용자가 터미널 쪽에서 그룹을 만들고 끌어 놓은 그대로 AI 쪽에서도 그 순서로 보인다.
// 뺀 것: Orca 의 런타임(원격 Orca 서버) 호스트·호스트 끌어 순서 바꾸기·호스트 필터·호환성 배지. 상태 점은 다음(연결 상태가 렌더러에 아직 없다).
import { hostKeyOf } from '@shared/managedServers'
import type { ConnectionProfile } from '@shared/types'
import { flatGroups, groupServers, groupsOf, noneGroup, type GroupLayout } from './groups'

export const LOCAL_HOST = 'local'

export type HostSection = {
  /** 'local' 또는 관리형 서버 hostKey(`user@host:port`). */
  key: string
  /** 비면 부르는 쪽이 "이 PC" 같은 글로 채운다(i18n 은 화면이). */
  label: string
  /** 터미널 사이드바의 그룹(기타면 없음). */
  group?: string
}

/**
 * keys = 지금 작업 단위가 있는 호스트들. 로컬이 맨 위, 서버는 터미널 사이드바에 그려지는 순서(그룹 순서 → 그룹 안 순서),
 * 프로필이 없는 hostKey(지운 서버)는 맨 끝에 hostKey 그대로.
 */
export function hostSections(
  keys: Iterable<string>,
  profiles: readonly ConnectionProfile[],
  storedGroups: readonly string[] = [],
  layout: GroupLayout = {}
): HostSection[] {
  const want = new Set(keys)
  const out: HostSection[] = []
  if (want.delete(LOCAL_HOST)) out.push({ key: LOCAL_HOST, label: '' })
  const ssh = profiles.filter((p) => p.type === 'ssh')
  const { byGroup, nodes } = groupServers(ssh, groupsOf([...ssh], storedGroups), layout)
  const none = noneGroup()
  for (const g of flatGroups(nodes)) {
    for (const p of byGroup.get(g) ?? []) {
      const key = hostKeyOf(p)
      if (!want.delete(key)) continue
      out.push({ key, label: p.name, ...(g !== none ? { group: g } : {}) })
    }
  }
  for (const key of [...want].sort()) out.push({ key, label: key })
  return out
}
