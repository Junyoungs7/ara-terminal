// #88 R2: [파일] 목록의 **보기 규칙** — 숨김·정렬·필터. 전부 순수 함수(tests/fileView.test.ts).
// 렌더러에서만 판단한다: 목록은 이미 다 읽어 왔고, 무엇을 보여 줄지는 화면의 문제다
// (숨김 하나 토글할 때마다 서버에 다시 물으면 원격에서 그대로 지연이 된다).
import type { FileEntry } from '@shared/ipc'
import type { GitStatusEntry } from '@shared/gitDiff'

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
    else if (opts.sort.key === 'ext') d = extOf(a.name).localeCompare(extOf(b.name), 'ko', NATURAL)
    // 이름 정렬은 이 동률 처리가 그대로 맡는다. 다른 기준도 값이 같으면 이름으로 갈라야
    // 새로고침할 때마다 줄 순서가 흔들리지 않는다(크기 0인 파일이 수십 개인 폴더에서 티가 난다).
    if (d === 0) d = a.name.localeCompare(b.name, 'ko', NATURAL)
    return d * dir
  })
  return out
}

/** M12 CV-01 Orca 이름 순서 — 숫자를 수로(9·99·100, 사전순 100·99 가 아니라). */
const NATURAL: Intl.CollatorOptions = { numeric: true }

/** 트리 한 줄 — name = 지금 폴더 기준 상대 경로(조작이 joinPath(path, name) 으로 그대로 돈다), label = 보이는 이름. */
export type TreeRow = FileEntry & { label: string; depth: number }

/**
 * M12 CV-01 펼친 폴더를 줄로 편다(Orca file-explorer-row-projection). open = 상대 경로 → 그 폴더 목록.
 * 같은 정렬·숨김을 층마다 쓰고, 이름 검색은 맨 위 층만(지금 폴더 안 — 터미널 [파일] 탭의 원래 뜻 그대로).
 */
export function treeRows(
  entries: readonly FileEntry[],
  open: Readonly<Record<string, readonly FileEntry[]>>,
  opts: { showHidden: boolean; sort: SortSpec; filter: string },
  sep: string
): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (list: readonly FileEntry[], prefix: string, depth: number): void => {
    for (const e of viewEntries(list, depth === 0 ? opts : { ...opts, filter: '' })) {
      const name = prefix ? prefix + sep + e.name : e.name
      out.push({ ...e, name, label: e.name, depth })
      const kids = e.type === 'dir' ? open[name] : undefined
      if (kids) walk(kids, name, depth + 1)
    }
  }
  walk(entries, '', 0)
  return out
}

/** 접을 때 그 아래 펼침도 함께 지운다. */
export function closeOpen<T>(open: Readonly<Record<string, T>>, key: string, sep: string): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(open)) if (k !== key && !k.startsWith(key + sep)) out[k] = v
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

/** M12 CV-01 git 상태 → 파일 줄 색 표·폴더(아래에 바뀐 것이 있음) 집합. 키 = 작업 단위 기준 '/' 경로. 순수 — 단위 시험 대상. */
export function gitDecorations(entries: readonly GitStatusEntry[]): { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  for (const e of entries) {
    // 스테이징·작업 트리 양쪽에 있으면 작업 트리 쪽(지금 디스크 상태)이 이긴다.
    if (!files.has(e.path) || e.area !== 'staged') files.set(e.path, e.status)
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return { files, dirs }
}
