// #88 R2: [파일] 목록의 **보기 규칙** — 숨김·정렬·필터. 전부 순수 함수(tests/fileView.test.ts).
// 렌더러에서만 판단한다: 목록은 이미 다 읽어 왔고, 무엇을 보여 줄지는 화면의 문제다
// (숨김 하나 토글할 때마다 서버에 다시 물으면 원격에서 그대로 지연이 된다).
import type { FileEntry } from '@shared/ipc'

export type SortKey = 'name' | 'ext' | 'size' | 'mtime'
export type SortSpec = { key: SortKey; asc: boolean }
export const DEFAULT_SORT: SortSpec = { key: 'name', asc: true }

/**
 * 숨김 판정 — 점으로 시작하는 이름.
 * 윈도우의 '숨김 특성'(FILE_ATTRIBUTE_HIDDEN)은 fs.Stats 에 없어서 다루지 않는다. 이 토글의 목적은
 * `.git`·`.env` 를 보이고 감추는 것이고, 그건 두 OS 모두 점 규칙이다. 윈도우 시스템 숨김 파일까지
 * 정확히 맞추려면 네이티브 특성 조회가 필요한데, 그 값을 얻자고 의존성을 붙일 이유가 없다.
 */
export function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** 마지막 점 뒤(소문자). LocalFs.nthName 과 같은 해석 — 확장자 규칙을 앱 안에서 하나로 유지한다. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 같은 기준을 다시 고르면 방향이 뒤집힌다(탐색기 열 머리글과 같은 규칙). */
export function nextSort(cur: SortSpec, key: SortKey): SortSpec {
  return cur.key === key ? { key, asc: !cur.asc } : { key, asc: true }
}

/**
 * 화면에 낼 목록. 순서: 필터 → 숨김 → 정렬.
 * **폴더 우선은 방향과 무관하다** — 내림차순이라고 폴더가 밑으로 내려가면 탐색기와 다르고,
 * 위로 올라가는 폴더 목록을 매번 스크롤해서 찾게 된다.
 */
export function viewEntries(
  entries: readonly FileEntry[],
  opts: { showHidden: boolean; sort: SortSpec; filter: string }
): FileEntry[] {
  const q = opts.filter.trim().toLowerCase()
  const out = entries.filter((e) => (opts.showHidden || !isHidden(e.name)) && (!q || e.name.toLowerCase().includes(q)))
  const dir = opts.sort.asc ? 1 : -1
  out.sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
    let d = 0
    if (opts.sort.key === 'size') d = a.size - b.size
    else if (opts.sort.key === 'mtime') d = a.mtime - b.mtime
    else if (opts.sort.key === 'ext') d = extOf(a.name).localeCompare(extOf(b.name), 'ko')
    // 이름 정렬은 이 동률 처리가 그대로 맡는다. 다른 기준도 값이 같으면 이름으로 갈라야
    // 새로고침할 때마다 줄 순서가 흔들리지 않는다(크기 0인 파일이 수십 개인 폴더에서 티가 난다).
    if (d === 0) d = a.name.localeCompare(b.name, 'ko')
    return d * dir
  })
  return out
}

/** 방문 이력(뒤로/앞으로). 순수 — 트리는 이 결과를 그대로 쓴다. */
export type History = { stack: string[]; idx: number }
export const EMPTY_HISTORY: History = { stack: [], idx: -1 }

/** 새 위치 방문. 앞으로 갈 길이 남아 있었다면 거기서 잘린다(브라우저와 같은 규칙). */
export function pushHistory(h: History, path: string): History {
  if (h.stack[h.idx] === path) return h
  const stack = [...h.stack.slice(0, h.idx + 1), path]
  return { stack, idx: stack.length - 1 }
}
