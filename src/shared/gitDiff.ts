// M7 R1 WS-10 Diff 조회 — 순수 규칙(main 의 git 조회·렌더러 diff 탭·R2 소스 제어 패널·단위 시험이 같이 읽는다).
// Orca shared/git-status-types·git-diff-compare-types·git-default-base-ref·large-diff-render-limit·git-status-limit
// (orcaRef fdfcfb3551)의 1차 판. 공유 API 는 agent_talk/m7-shared-api.md.

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'
export type GitStagingArea = 'staged' | 'unstaged' | 'untracked'
/** M12 R2 머지 충돌 종류 — Orca shared/git-status-conflict-entries.ts parseConflictKind(porcelain v2 `u` 레코드의 XY). */
export type GitConflictKind = 'both_modified' | 'both_added' | 'both_deleted' | 'added_by_us' | 'added_by_them' | 'deleted_by_us' | 'deleted_by_them'
/** 충돌이 난 git 작업(Orca GitConflictOperation). */
export type GitConflictOperation = 'merge' | 'rebase' | 'cherry-pick' | 'unknown'
/** 한 파일·한 영역. 같은 파일이 staged·unstaged 둘 다면 항목이 둘이다(Orca 와 같다). path = 워크트리 기준 '/' 경로. */
export type GitStatusEntry = { path: string; oldPath?: string; status: GitFileStatus; area: GitStagingArea; conflictKind?: GitConflictKind }
export type GitStatusResult =
  | { ok: true; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; entries: GitStatusEntry[]; truncated: boolean; operation?: GitConflictOperation }
  | { ok: false; message: string }
export type GitBranchChange = { path: string; oldPath?: string; status: GitFileStatus }
export type GitBranchCompareResult =
  | { ok: true; baseRef: string; mergeBase: string; entries: GitBranchChange[]; truncated: boolean }
  | { ok: false; message: string }
/** diff 를 볼 쪽. unstaged = 인덱스↔디스크(untracked 포함), staged = HEAD↔인덱스, branch = 갈림점↔HEAD(Orca getBranchDiff). */
export type DiffMode = 'unstaged' | 'staged' | 'branch'
/** host = 원격 작업 단위의 서버(M8 R5) — 있으면 main 이 SSH 로 읽는다. */
export type GitDiffArgs = { worktreePath: string; filePath: string; oldPath?: string; mode: DiffMode; mergeBase?: string; host?: string }
/** 한 파일의 양쪽 글. 바이너리·너무 큼은 글 없이 kind 로(Orca buildDiffResult). */
export type GitDiffResult =
  | { ok: true; kind: 'text'; original: string; modified: string }
  | { ok: true; kind: 'binary' | 'tooLarge' }
  | { ok: false; message: string }

/** Orca DEFAULT_GIT_STATUS_LIMIT — 큰 저장소에서 목록이 화면·IPC 를 막지 않게 여기서 자른다(truncated). */
export const GIT_STATUS_LIMIT = 1_000
/** Orca git-show-max-bytes — 한쪽이 이보다 크면 읽지 않는다(tooLarge). */
export const DIFF_READ_MAX_BYTES = 10 * 1024 * 1024
/** Orca large-diff-render-limit — 넘으면 Monaco 에 안 넣는다(tooLarge). */
export const MAX_RENDERED_DIFF_LINES_PER_SIDE = 120_000
export const MAX_RENDERED_DIFF_COMBINED_CHARACTERS = 6_000_000

const CONFLICT_KIND: Record<string, GitConflictKind> = { UU: 'both_modified', AA: 'both_added', DD: 'both_deleted', AU: 'added_by_us', UA: 'added_by_them', DU: 'deleted_by_us', UD: 'deleted_by_them' }
const CODE: Record<string, GitFileStatus> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted' }

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all` 의 출력. Orca StatusPorcelainParser 의 -z 판.
 * 레코드: `# branch.*` 머리 · `1 XY …8칸 path` · `2 XY …9칸 path\0orig` · `u XY …10칸 path` · `? path` · `! path`(무시).
 */
export function parseStatusV2(stdout: string, limit = GIT_STATUS_LIMIT): Extract<GitStatusResult, { ok: true }> {
  const out: Extract<GitStatusResult, { ok: true }> = { ok: true, branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [], truncated: false }
  const recs = stdout.split('\0')
  // 공백으로 n 칸을 떼고 나머지 = 경로(경로에 공백이 있을 수 있다).
  const after = (rec: string, n: number): string => {
    let i = 0
    for (let k = 0; k < n; k++) i = rec.indexOf(' ', i) + 1
    return rec.slice(i)
  }
  const push = (e: GitStatusEntry): void => {
    if (out.entries.length >= limit) out.truncated = true
    else out.entries.push(e)
  }
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ')
      const v = rest.join(' ')
      if (key === 'branch.head') out.branch = v === '(detached)' ? null : v
      else if (key === 'branch.oid') out.head = v === '(initial)' ? null : v
      else if (key === 'branch.upstream') out.upstream = v
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(v)
        if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    const kind = rec[0]
    if (kind === '?') push({ path: rec.slice(2), status: 'untracked', area: 'untracked' })
    else if (kind === 'u') {
      // Orca: 서브모듈 충돌(모드 160000)은 다루지 않는다 — 그래도 목록엔 남겨 커밋 버튼이 막히게(종류 없이).
      const k = CONFLICT_KIND[rec.slice(2, 4)]
      const sub = rec.split(' ').slice(3, 6).includes('160000')
      push({ path: after(rec, 10), status: 'conflicted', area: 'unstaged', ...(k && !sub ? { conflictKind: k } : {}) })
    }
    else if (kind === '1' || kind === '2') {
      const [x, y] = [rec[2], rec[3]]
      const path = after(rec, kind === '1' ? 8 : 9)
      const oldPath = kind === '2' ? recs[++i] : undefined
      if (x !== '.') push({ path, ...(oldPath ? { oldPath } : {}), status: CODE[x] ?? 'modified', area: 'staged' })
      if (y !== '.') push({ path, status: CODE[y] ?? 'modified', area: 'unstaged' })
    }
  }
  return out
}

/** `git diff --name-status -z -M` 의 출력. R·C 는 점수 뒤에 옛 경로·새 경로 두 칸. */
export function parseNameStatusZ(stdout: string, limit = GIT_STATUS_LIMIT): { entries: GitBranchChange[]; truncated: boolean } {
  const recs = stdout.split('\0')
  const entries: GitBranchChange[] = []
  let truncated = false
  for (let i = 0; i < recs.length; i++) {
    const code = recs[i]
    if (!code) continue
    const status = CODE[code[0]] ?? 'modified'
    const two = code[0] === 'R' || code[0] === 'C'
    const oldPath = two ? recs[++i] : undefined
    const path = recs[++i]
    if (path === undefined) break
    if (entries.length >= limit) truncated = true
    else entries.push({ path, ...(oldPath ? { oldPath } : {}), status })
  }
  return { entries, truncated }
}

/** Orca DEFAULT_BASE_REF_PROBES — origin/HEAD 가 가리키는 것이 먼저, 없으면 이 순서. */
export const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]
export const DEFAULT_BASE_REF_ARGS: readonly string[] = (() => {
  const refs = ['refs/remotes/origin/HEAD', ...DEFAULT_BASE_REF_PROBES.map((p) => p.ref)]
  // 글자 묶음([n])으로 정확히 그 이름만(main/topic 같은 하위를 안 끌어온다) — Orca 와 같다.
  return ['for-each-ref', '--format=%(refname)%00%(symref)', ...refs.map((r) => `${r.slice(0, -1)}[${r.slice(-1)}]`)]
})()

/** Orca resolveDefaultBaseRefViaExec 의 판정 부분 — DEFAULT_BASE_REF_ARGS 의 출력을 받는다. 못 정하면 null. */
export function pickDefaultBaseRef(stdout: string): string | null {
  const present = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const cut = line.indexOf('\0')
    if (cut < 0) continue
    const [ref, target] = [line.slice(0, cut), line.slice(cut + 1)]
    if (ref === 'refs/remotes/origin/HEAD' && target) return target.replace(/^refs\/remotes\//, '')
    present.add(ref)
  }
  return DEFAULT_BASE_REF_PROBES.find((p) => present.has(p.ref))?.returnAs ?? null
}

/** 렌더러가 넘긴 파일 경로가 워크트리 안의 상대 경로인가(`..`·절대 경로·옵션처럼 보이는 것 거절). */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '' || p.startsWith('-') || /^([a-zA-Z]:)?[\\/]/.test(p) || p.includes('\0')) return false
  return !p.split(/[\\/]/).includes('..')
}

/** 바이너리(앞 8000자에 NUL) — git 이 쓰는 휴리스틱과 같은 자릿수. */
export const looksBinaryText = (s: string): boolean => s.slice(0, 8000).includes('\0')

const countLines = (s: string, cap: number): number => {
  if (!s) return 0
  let n = 1
  for (let i = 0; i < s.length && n <= cap; i++) if (s.charCodeAt(i) === 10) n++
  return n
}

/** 양쪽 글 → 결과. Orca buildDiffResult: 바이너리면 binary, 그리기 상한을 넘으면 tooLarge(글을 안 싣는다). */
export function buildDiffResult(original: string, modified: string): GitDiffResult {
  if (looksBinaryText(original) || looksBinaryText(modified)) return { ok: true, kind: 'binary' }
  if (
    original.length + modified.length > MAX_RENDERED_DIFF_COMBINED_CHARACTERS ||
    countLines(original, MAX_RENDERED_DIFF_LINES_PER_SIDE) > MAX_RENDERED_DIFF_LINES_PER_SIDE ||
    countLines(modified, MAX_RENDERED_DIFF_LINES_PER_SIDE) > MAX_RENDERED_DIFF_LINES_PER_SIDE
  )
    return { ok: true, kind: 'tooLarge' }
  return { ok: true, kind: 'text', original, modified }
}

/** diff 탭 열기 창 이벤트(진입 청크의 RightBar·R2 소스 제어 → AI 공간). detail = { filePath, mode? }. */
export const OPEN_DIFF_EVENT = 'aiws:open-diff'
