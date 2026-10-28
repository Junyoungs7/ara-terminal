import { KEYMAP, keyText, type KeymapAction } from '../../shared/keymap'
import { MENUBAR, type MenuCommandId } from '../interactions/actions'
import type { ConnectionProfile, WorkProfile } from '@shared/types'
import { t } from '../i18n'
import { featureOf, type FeatureId, type FeatureShown } from '@shared/features'

// F31 통합 검색(커맨드 팔레트) — 준영님 요청(2026-08-13):
// "vscode처럼 상단에 통합 검색 버튼 제공하여 거기서 바로 킬 수 있도록, 프로필도 거기서 켜거나,
//  저장하거나 할 수 있게 전반적인 기능을 검색으로 제공."
//
// 이 파일은 **목록을 만들지 않는다 — 이미 있는 표에서 끌어온다.** 새 레지스트리를 만들면
// 기능이 늘 때마다 두 곳을 고쳐야 하고, 그 순간부터 "팔레트에만 없는 기능"이 생긴다:
//   · 단축키 있는 기능 → KEYMAP(implemented 인 것만)
//   · 단축키 없는 앱 명령 → MENUBAR 의 { command }
//   · 서버 · 즐겨찾기 → 지금 저장돼 있는 프로필 목록
// 실행도 각자 원래 길로 보낸다(dispatchAction / onCommand / connect) — 팔레트 전용 배선은 없다.
//
// 화면(CommandPalette.tsx)은 여기서 나온 목록을 그리기만 한다. 아래는 전부 순수 함수다.

export type PaletteKind = 'session' | 'action' | 'command' | 'profile' | 'work'

export type PaletteItem = {
  /** 목록 key + e2e 선택자. 종류별로 접두어가 달라 서로 부딪히지 않는다. */
  id: string
  kind: PaletteKind
  label: string
  /** 이름 옆에 흐리게 붙는 설명(기능 설명 · 호스트 · 경로 · 메뉴 이름). */
  hint?: string
  /** 오른쪽 단축키 칩(`.kbd`) 글자 — keyText 표기(`Ctrl Shift T`). */
  key?: string
  /** 검색에 걸리지만 화면에는 안 보이는 낱말(영문 이름 등). */
  alias?: string
  /** 2.0: 설정 › 기능에서 꺼진 기능. 검색에는 남고 배지가 붙는다(byDefault = 기본 숨김인 것). */
  off?: { id: FeatureId; byDefault: boolean }
  run: PaletteRun
}

/** 실행 지시. 팔레트는 **무엇을 할지만 정하고**, 어떻게 하는지는 부르는 쪽이 안다. */
export type PaletteRun =
  | { do: 'action'; action: KeymapAction }
  | { do: 'command'; command: MenuCommandId }
  | { do: 'connect'; profileId: string }
  | { do: 'work'; workId: string }
  | { do: 'session'; sessionId: string }

/**
 * KEYMAP 에 **같은 기능이 이미 있는** 메뉴 명령. 팔레트에 두 줄로 뜨지 않게 건너뛴다
 * (치트시트가 "치트시트"와 "단축키 치트시트"로 두 번 나왔다 — 라벨이 달라 문자열 비교로는 못 잡는다).
 *
 * MENUBAR 에서 `{ command }` 를 `{ action }` 으로 옮기는 쪽이 뿌리를 고치는 길처럼 보이지만,
 * 치트시트에는 안 통한다: `?` 는 **입력 중에는 일부러 안 먹는 키**라(KEY-2) 메뉴 항목을
 * dispatchAction 으로 돌리면 터미널에 포커스가 있을 때 눌러도 아무 일이 없다(2026-08-13 스모크가 잡음).
 */
const COMMAND_DUPES: Partial<Record<MenuCommandId, KeymapAction>> = { 'help.cheatsheet': 'cheatsheet' }

/** 종류별 머리말. 섞여 나오면 무엇을 고르는 중인지 흐려진다. */
export const PALETTE_GROUPS: readonly { kind: PaletteKind; key: string }[] = [
  { kind: 'session', key: 'palette.group.open' },
  { kind: 'action', key: 'palette.group.action' },
  { kind: 'command', key: 'palette.group.command' },
  { kind: 'profile', key: 'palette.group.profile' },
  { kind: 'work', key: 'palette.group.work' }
]

export function paletteItems(
  profiles: readonly ConnectionProfile[],
  workProfiles: readonly WorkProfile[],
  isMac: boolean,
  shown?: FeatureShown
): PaletteItem[] {
  const out: PaletteItem[] = []
  // 꺼진 기능도 **빼지 않는다** — 숨긴 기능을 찾는 길이 여기다(0단계 결정). 표시만 붙인다.
  const offOf = (id: string): PaletteItem['off'] => {
    const f = featureOf(id)
    return f && shown && !shown[f.id] ? { id: f.id, byDefault: !!f.hidden } : undefined
  }

  // ① 단축키 있는 기능. **implemented 인 것만** — 눌러도 아무 일 없는 항목을 검색 결과에 올리지 않는다
  //    (치트시트가 이미 같은 규칙을 쓴다).
  for (const k of KEYMAP) {
    if (!k.implemented) continue
    const f = featureOf(k.action)
    out.push({
      id: 'action:' + k.action,
      kind: 'action',
      label: k.labelKo,
      // 설명은 설정 › 기능과 같은 문구(그 표에 있는 기능만). 단축키는 칩으로 따로 간다.
      ...(f ? { hint: t('feature.' + f.id + '.desc') } : {}),
      key: keyText(isMac ? k.mac : k.win),
      alias: k.action,
      off: offOf(k.action),
      run: { do: 'action', action: k.action }
    })
  }

  // ② 단축키 없는 앱 명령(메뉴에만 있던 것들). 메뉴를 열어 찾지 않아도 되게 한다.
  //
  // ① 과 겹치는 것은 넣지 않는다 — 같은 기능이 두 줄로 뜨면 어느 쪽을 눌러야 하는지 헷갈린다.
  // 남기는 쪽은 ① 이다(단축키 힌트가 함께 붙어 더 쓸모 있다). 이름으로 지목한 것(COMMAND_DUPES)과
  // 라벨이 똑같은 것 둘 다 거른다.
  for (const menu of MENUBAR) {
    for (const e of menu.items) {
      if (!('command' in e)) continue
      const dupe = COMMAND_DUPES[e.command]
      if (dupe && out.some((i) => i.id === 'action:' + dupe)) continue
      const label = t('menu.' + e.command)
      if (out.some((i) => i.kind === 'action' && i.label === label)) continue
      const f = featureOf(e.command)
      out.push({
        id: 'command:' + e.command,
        kind: 'command',
        label,
        hint: f ? t('feature.' + f.id + '.desc') : menu.title,
        alias: e.command,
        off: offOf(e.command),
        run: { do: 'command', command: e.command }
      })
    }
  }

  // ③ 저장해 둔 서버 — Enter 하나로 접속한다.
  for (const p of profiles) {
    out.push({
      id: 'profile:' + p.id,
      kind: 'profile',
      label: p.name,
      hint: p.type === 'ssh' ? `${p.username}@${p.host}:${p.port}` : p.type,
      alias: p.type === 'ssh' ? `${p.username} ${p.host}` : p.type,
      run: { do: 'connect', profileId: p.id }
    })
  }

  // ④ 즐겨찾기(서버 + 폴더).
  for (const w of workProfiles) {
    out.push({
      id: 'work:' + w.id,
      kind: 'work',
      label: w.name,
      hint: w.path,
      alias: w.path,
      run: { do: 'work', workId: w.id }
    })
  }

  return out
}

/**
 * 검색 — 라벨·보조·별칭에 **모든 낱말이 다 들어 있으면** 통과(공백으로 끊는다).
 * "새 세션"처럼 순서가 뒤바뀌어도(`세션 새`) 찾히게 하려는 것이고, 퍼지 매칭까지 가지 않는 이유는
 * 항목이 수십 개 규모라 낱말 포함만으로 충분하기 때문이다(틀리게 걸리는 쪽이 더 나쁘다).
 *
 * 순위: 라벨 맨 앞 일치 → 라벨 어딘가 일치 → 그 밖. 같은 순위면 원래 순서를 지킨다.
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  const scored: { item: PaletteItem; rank: number; i: number }[] = []
  items.forEach((item, i) => {
    const label = item.label.toLowerCase()
    const hay = `${label} ${(item.hint ?? '').toLowerCase()} ${(item.alias ?? '').toLowerCase()} ${(item.key ?? '').toLowerCase()}`
    if (!words.every((w) => hay.includes(w))) return
    const rank = label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2
    scored.push({ item, rank, i })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.item)
}

/** 종류 순서대로 묶는다. 빈 묶음은 만들지 않는다. */
export function groupPalette(items: readonly PaletteItem[]): { kind: PaletteKind; items: PaletteItem[] }[] {
  return PALETTE_GROUPS.map(({ kind }) => ({ kind, items: items.filter((x) => x.kind === kind) })).filter(
    (g) => g.items.length > 0
  )
}

/**
 * 열린 창 — 세션 탭과 탐색기 창(2.0 다듬기 R1, 빈 쿼리 묶음 겸 창 목록). 고르면 그 탭으로 가거나
 * 탐색기를 앞으로 가져온다(explorer.toggle 은 토글이 아니라 "열기/앞으로" — Shell 주석).
 * ponytail: 브라우저·포트 창은 본창 렌더러가 열림 여부를 모른다(main 만 안다) — 상태 중계가 생기면 여기 더한다.
 */
export function openItems(
  sessions: readonly { id: string; title: string; server?: string }[],
  explorerOpen: boolean
): PaletteItem[] {
  const out: PaletteItem[] = sessions.map((s) => ({
    id: 'session:' + s.id,
    kind: 'session',
    label: s.title,
    ...(s.server && s.server !== s.title ? { hint: s.server } : {}),
    run: { do: 'session', sessionId: s.id }
  }))
  if (explorerOpen)
    out.push({
      id: 'window:explorer',
      kind: 'session',
      label: t('feature.explorer'),
      hint: t('palette.window'),
      run: { do: 'action', action: 'explorer.toggle' }
    })
  return out
}

/**
 * **빈 검색어**일 때 보이는 것 — 긴 단축키 목록 대신 세 묶음(시안 Z-palette · 리뷰 B 추가 제안):
 * 열린 창 / 최근 서버 / 숨긴 기능. 셋 다 비면(첫 실행 직후 같은 때) 빈 배열 — 부르는 쪽이 전체 목록을 보인다.
 */
export function paletteHome(
  items: readonly PaletteItem[],
  open: readonly PaletteItem[],
  recentProfileIds: readonly string[]
): { key: string; items: PaletteItem[] }[] {
  const recent = recentProfileIds
    .map((id) => items.find((i) => i.id === 'profile:' + id))
    .filter((i): i is PaletteItem => !!i)
  return [
    { key: 'palette.group.open', items: [...open] },
    { key: 'palette.group.recent', items: recent },
    { key: 'palette.group.hidden', items: items.filter((i) => i.off) }
  ].filter((g) => g.items.length > 0)
}

/** 최근 접속한 서버(프로필 id, 최근 것 먼저). 설정이 아니라 잠깐의 기억이라 localStorage(BootSplash 와 같은 이유). */
const RECENT_KEY = 'ara.palette.recentServers'
const RECENT_MAX = 5
export function recentServers(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function noteRecentServer(profileId: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([profileId, ...recentServers().filter((x) => x !== profileId)].slice(0, RECENT_MAX)))
  } catch {
    /* 저장 못 하면 최근 목록만 빈다 */
  }
}

/** ↑↓ 이동 — 끝에서 반대편으로 돈다(목록이 짧아 감아 도는 편이 빠르다). 빈 목록은 0. */
export function moveCursor(cur: number, delta: number, len: number): number {
  if (len <= 0) return 0
  return (((cur + delta) % len) + len) % len
}
