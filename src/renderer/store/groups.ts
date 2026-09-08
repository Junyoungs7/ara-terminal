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

/**
 * 형제끼리의 정렬. 사람이 **끌어다 정한 순서**(order)가 먼저, 그 목록에 없는 이름은 가나다순,
 * "기타"는 언제나 마지막이다 — order 에 무엇이 적혀 있든 "기타"를 위로 올리지 않는다
 * (그건 그룹이 아니라 그룹 미지정 프로필이 모이는 표시용 자리다).
 */
export function sortSiblings(names: readonly string[], order?: readonly string[]): string[] {
  const none = noneGroup()
  const rank = (n: string): number => {
    const i = order ? order.indexOf(n) : -1
    return i < 0 ? Number.POSITIVE_INFINITY : i
  }
  return [...names].sort((a, b) => {
    if (a === b) return 0
    if (a === none) return 1
    if (b === none) return -1
    const ra = rank(a)
    const rb = rank(b)
    // 둘 다 순서에 없으면(Infinity === Infinity) 가나다순으로 떨어진다.
    if (ra !== rb) return ra - rb
    return a.localeCompare(b, 'ko')
  })
}

export function sortGroups(names: string[]): string[] {
  return sortSiblings(names)
}

// R6 검색(트리 + 연결 관리자 프로필 리스트 공용): 이름·호스트·그룹 중 하나라도 걸리면 남긴다.
// 대소문자 무시(한글은 영향 없음). 빈 질의는 전부 통과 — 필터가 없는 것과 같다.
//
// 2026-09-08(#193): parent 를 받는다 — **부모 그룹 이름으로도 걸린다.** 자식 그룹에 들어간 서버는
// 사용자 머릿속에서 여전히 "운영 안"이라, 부모 이름을 쳤는데 안 나오면 검색이 거짓말을 한다.
// 안 주면 지금까지와 똑같다(연결 관리자는 중첩을 모른다 — 그쪽은 이 인자를 주지 않는다).
export function matchProfile(p: ConnectionProfile, query: string, parent?: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    p.name.toLowerCase().includes(q) ||
    p.host.toLowerCase().includes(q) ||
    (p.group ?? '').toLowerCase().includes(q) ||
    (parent ?? '').toLowerCase().includes(q)
  )
}

export function groupsOf(profiles: ConnectionProfile[], stored: readonly string[]): string[] {
  const set = new Set(stored)
  for (const p of profiles) if (p.group) set.add(p.group)
  return sortGroups([...set])
}

// ── #193 1라운드(2026-09-08): 사용자가 정한 순서 + 2단 중첩 ────────────────────
//
// 저장 자리는 **선택 필드 둘**이다(UiPrefs.groupOrder · groupParents) — 그룹 이름 자체는 건드리지
// 않는다. 이름에 `부모/자식` 처럼 구분자를 넣는 방법은 쓰지 않았다: 그룹 이름에는 검증이 없어서
// 이미 `A/B` 라고 지어 둔 사람이 있으면 그 이름이 **조용히 중첩으로 재해석된다** — 남의 데이터를
// 다시 읽는 변경은 하지 않는다.
//
// **상한은 2단이다**(준영님 확정). 재귀 트리로 만들지 않은 것은 화면 때문만이 아니다: 상한이 있으면
// 순환·깊이·삭제 규칙이 전부 한 줄짜리 비교가 된다(canNest 를 보라 — 순환 검사가 따로 없다).
//
// ⚠️ 저장된 값은 **믿지 않는다.** 옛 앱이 이 두 키를 모른 채 그룹을 지우거나 이름을 바꿀 수 있고
// (선택 필드라 옛 버전도 같은 파일을 쓴다), 그러면 여기에 죽은 이름이 남는다. 읽는 쪽에서
// 목록에 없는 이름·자기 자신·3단을 전부 걸러 낸다 — 그래야 어긋난 파일이 화면을 깨지 않는다.

export type GroupLayout = {
  /** 사람이 끌어다 정한 표시 순서(형제끼리 비교할 때만 쓴다). 여기 없는 이름은 가나다순. */
  order?: string[]
  /** 자식 → 부모. 상한이 2단이라 **부모는 자기 부모를 가질 수 없다.** */
  parents?: Record<string, string>
}

export type GroupNode = { name: string; children: string[] }

/** 실제로 인정되는 부모. 걸러 내는 넷: 없는 그룹 · 자기 자신 · "기타" · 3단(부모의 부모). */
function honoredParent(child: string, known: ReadonlySet<string>, parents?: Record<string, string>): string | undefined {
  const none = noneGroup()
  if (child === none) return undefined
  const p = parents?.[child]
  if (!p || p === child || p === none || !known.has(p)) return undefined
  // 부모가 또 남의 자식이면 3단이다 — **자식 쪽 매핑을 버린다**(자식이 최상위로 올라온다).
  // 부모 쪽을 버리면 손자가 조부모 밑으로 붙어 계층이 조용히 바뀐다. 버릴 것은 더 깊은 쪽이다.
  const gp = parents?.[p]
  if (gp && gp !== p && gp !== none && known.has(gp)) return undefined
  return p
}

/** 이 그룹의 부모(없으면 최상위). 화면·검사 양쪽이 같은 판정을 쓴다. */
export function parentGroupOf(child: string, names: readonly string[], parents?: Record<string, string>): string | undefined {
  return honoredParent(child, new Set(names), parents)
}

/** 그릴 모양 — 최상위 그룹들과 각자의 자식(상한 2단이라 손자는 없다). */
export function groupTree(names: readonly string[], layout: GroupLayout = {}): GroupNode[] {
  const known = new Set(names)
  const tops: string[] = []
  const kids = new Map<string, string[]>()
  for (const g of names) {
    const p = honoredParent(g, known, layout.parents)
    if (!p) {
      tops.push(g)
      continue
    }
    const list = kids.get(p)
    if (list) list.push(g)
    else kids.set(p, [g])
  }
  return sortSiblings(tops, layout.order).map((name) => ({
    name,
    children: sortSiblings(kids.get(name) ?? [], layout.order)
  }))
}

/** 화면에 그려지는 순서 그대로 편 이름 목록(부모 바로 뒤에 그 자식들). */
export function flatGroups(nodes: readonly GroupNode[]): string[] {
  return nodes.flatMap((n) => [n.name, ...n.children])
}

export type NestVerdict = { ok: true } | { ok: false; reason: 'self' | 'depth' | 'none' }

/**
 * child 를 parent 안에 넣어도 되나.
 *
 * **순환 검사가 따로 없다** — 상한 2단이 이미 막는다. A 를 B 밑에 넣은 뒤 B 를 A 밑에 넣으려 하면
 * "A 가 이미 부모다"에 걸려 depth 로 거부된다(검사에 그 경우가 있다). 상한을 늘리려는 사람은
 * 여기에 순환 검사를 **직접 넣어야 한다**.
 */
export function canNest(child: string, parent: string, names: readonly string[], layout: GroupLayout = {}): NestVerdict {
  const none = noneGroup()
  if (child === parent) return { ok: false, reason: 'self' }
  // "기타"는 실제 그룹이 아니다(그룹 미지정 프로필의 자리) — 부모도 자식도 될 수 없다.
  if (child === none || parent === none) return { ok: false, reason: 'none' }
  const known = new Set(names)
  if (honoredParent(parent, known, layout.parents)) return { ok: false, reason: 'depth' }
  for (const g of names) if (honoredParent(g, known, layout.parents) === child) return { ok: false, reason: 'depth' }
  return { ok: true }
}

/** 놓을 자리. 머리글 위/아래 가장자리는 **순서 바꾸기**, 가운데는 **그 안에 넣기**. */
export type DropPlace = 'before' | 'into' | 'after'

// 가장자리 띠의 비율. 머리글이 낮아(20px대) 1/4 로 잡으면 5px짜리 과녁이 된다 — 조금 넓게 준다.
const DROP_EDGE = 0.3

export function dropZone(offsetY: number, height: number): DropPlace {
  if (height <= 0) return 'into'
  const r = offsetY / height
  if (r < DROP_EDGE) return 'before'
  if (r > 1 - DROP_EDGE) return 'after'
  return 'into'
}

/**
 * 그룹을 그 자리에 놓아도 되나. 앞/뒤로 놓는 것은 **target 의 형제가 되는 일**이라 target 의 부모
 * 안으로 들어가는 것과 같다 — 그래서 중첩과 같은 상한 검사를 받는다.
 * 최상위로 나가는 것은 언제나 된다(자식이 딸려 있어도 단이 깊어지지 않는다).
 */
export function groupDropVerdict(
  moved: string,
  target: string,
  place: DropPlace,
  names: readonly string[],
  layout: GroupLayout = {}
): NestVerdict {
  if (moved === target) return { ok: false, reason: 'self' }
  if (moved === noneGroup()) return { ok: false, reason: 'none' }
  const parent = place === 'into' ? target : parentGroupOf(target, names, layout.parents)
  if (!parent) return { ok: true }
  return canNest(moved, parent, names, layout)
}

/**
 * 놓은 결과의 새 배치. **부르기 전에 groupDropVerdict 로 물어봐야 한다** — 여기서는 다시 막지 않는다.
 *
 * 순서는 "지금 보이는 순서"를 그대로 다시 적고 끌어 온 이름만 빼서 target 앞/뒤에 꽂는다.
 * 그 김에 옛 order 에 남아 있던 **지금 없는 이름이 걷힌다**(옛 앱이 지우거나 이름을 바꾼 흔적).
 */
export function applyGroupDrop(
  moved: string,
  target: string,
  place: DropPlace,
  names: readonly string[],
  layout: GroupLayout = {}
): GroupLayout {
  const parent = place === 'into' ? target : parentGroupOf(target, names, layout.parents)
  const parents = { ...(layout.parents ?? {}) }
  if (parent) parents[moved] = parent
  else delete parents[moved]

  const known = new Set(names)
  const flat = flatGroups(groupTree(names, { ...layout, parents })).filter((n) => n !== moved)
  const at = flat.indexOf(target)
  if (at < 0) flat.push(moved)
  else if (place === 'before') flat.splice(at, 0, moved)
  else if (place === 'after') flat.splice(at + 1, 0, moved)
  else {
    // 안에 넣을 때는 그 그룹의 자식들 **끝**에 붙인다 — 방금 놓은 것이 목록 중간에 끼어들면
    // 어디로 갔는지 눈으로 못 쫓는다.
    let i = at + 1
    while (i < flat.length && honoredParent(flat[i], known, parents) === target) i++
    flat.splice(i, 0, moved)
  }
  // "기타"는 저장하지 않는다 — 그룹이 아니라 번역된 표시용 이름이고, 자리는 늘 마지막으로 정해져 있다.
  return { order: flat.filter((n) => n !== noneGroup()), parents }
}

/** 그룹 이름이 바뀌면 순서·부모 관계도 따라가야 한다. 안 그러면 그 그룹이 조용히 최상위로 튄다. */
export function renameInLayout(layout: GroupLayout, from: string, to: string): GroupLayout {
  const parents: Record<string, string> = {}
  for (const [child, parent] of Object.entries(layout.parents ?? {})) {
    parents[child === from ? to : child] = parent === from ? to : parent
  }
  return { order: layout.order?.map((n) => (n === from ? to : n)), parents }
}

/**
 * 그룹이 사라지면(삭제·이름 변경 후 옛 이름) 그 흔적을 걷는다.
 * **자식 그룹은 최상위로 올린다** — 함께 지우지 않는다. 그룹 삭제는 이미 "프로필은 살리고 기타로
 * 내려보낸다"인데 자식 그룹만 통째로 지우면 같은 메뉴가 두 가지 무게를 갖는다.
 */
export function removeFromLayout(layout: GroupLayout, name: string): GroupLayout {
  const parents: Record<string, string> = {}
  for (const [child, parent] of Object.entries(layout.parents ?? {})) {
    if (child === name || parent === name) continue
    parents[child] = parent
  }
  return { order: layout.order?.filter((n) => n !== name), parents }
}

// 저장된 그룹 목록(빈 그룹 포함) + 배치. useFont·useSidebar 와 같은 하이드레이트 → 갱신 → 영속 형태.
export function useGroupList() {
  const [stored, setStored] = useState<string[]>([])
  const [layout, setLayout] = useState<GroupLayout>({})

  useEffect(() => {
    window.ev?.workspace
      .load()
      .then((snap) => {
        setStored(snap.ui.groups ?? [])
        setLayout({ order: snap.ui.groupOrder, parents: snap.ui.groupParents })
      })
      .catch(() => {})
  }, [])

  // 배치를 안 주면 **건드리지 않는다**(main 도 undefined 는 그대로 둔다) — 그룹 하나 만들자고
  // 사용자가 끌어 놓은 순서를 지우면 안 된다.
  const save = useCallback((next: string[], nextLayout?: GroupLayout) => {
    const uniq = [...new Set(next)]
    setStored(uniq)
    if (nextLayout) setLayout(nextLayout)
    // 하네스(ui:setGroups 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
    window.ev?.ui.setGroups(uniq, nextLayout?.order, nextLayout?.parents).catch(() => {})
  }, [])

  return { stored, layout, save }
}
