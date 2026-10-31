/**
 * M2 작업 단위(WS-01·03·04) — 프로젝트·워크트리의 **모양과 순수 규칙**. main·preload·렌더러가 같이 읽으므로
 * node 모듈을 쓰지 않는다(경로 계산은 main/worktrees/paths.ts).
 *
 * Orca(orcaRef 7a7f46f8a3)의 데이터 모양·이름을 따른다 — 월요일 점검으로 따라가기 쉽게. 각 함수 옆에 원본 경로.
 * 이 파일은 1차 범위의 핵심만 옮겼다(원격·SSH·WSL·PR 연동·이모지 단축코드 등은 뺐다 — 보고서 표 참고).
 */

// ── 모양 ──────────────────────────────────────────────────────────────────────

/** Orca `RepoKind`(src/shared/repo-types.ts). 'folder' = git 이 아닌 폴더 프로젝트(Orca folder workspace). */
export type ProjectKind = 'git' | 'folder'

/** Orca `Repo` 의 1차 부분집합(src/shared/repo-types.ts). 렌더러 이름은 Orca 처럼 repo/repoId 를 쓴다. */
export type Project = {
  id: string
  path: string
  displayName: string
  kind: ProjectKind
  addedAt: number
}

/** Orca `GitWorktreeInfo`(src/shared/worktree/types.ts) 그대로. */
export type GitWorktreeInfo = {
  path: string
  head: string
  /** 전체 ref(`refs/heads/main`). detached 면 ''. */
  branch: string
  isBare: boolean
  isSparse?: boolean
  locked?: boolean
  lockReason?: string
  prunable?: boolean
  prunableReason?: string
  /** git 이 늘 본 작업 폴더를 첫 줄에 낸다. */
  isMainWorktree: boolean
}

/** Orca `Worktree`(src/shared/worktree/types.ts)의 1차 부분집합. id = `${repoId}::${path}`(Orca composeWorktreeId). */
export type Worktree = GitWorktreeInfo & {
  id: string
  repoId: string
  displayName: string
}

/** Orca `CreateWorktreeArgs`(src/shared/worktree/create-types.ts)의 1차 부분집합. */
export type CreateWorktreeArgs = {
  repoId: string
  name: string
  /** 분기 지점. 비우면 지금 HEAD. */
  baseBranch?: string
  /** 렌더러가 만든 id — 진행 이벤트·취소가 이것으로 맞물린다. */
  creationId: string
}

export type CreateWorktreeResult =
  | { ok: true; worktree: Worktree; includeCopyWarning?: string }
  | { ok: false; reason: 'notFound' | 'notRepo' | 'invalidName' | 'collision' | 'canceled' | 'git'; message: string }

/**
 * 생성 진행(WS-03 main 쪽). Orca `CreateWorktreeProgressEvent` 의 phase·checkout 에 더해 아라는 시작·git 출력·끝을
 * 같은 채널로 흘린다(Orca 는 끝을 invoke 응답으로만 안다 — 렌더러가 여럿이면 다른 창이 모른다).
 */
export type WorktreeCheckoutProgress = { percent: number; completed: number; total: number }
export type CreateWorktreeProgressEvent = { creationId: string; repoId: string } & (
  | { phase: 'start'; path: string; branch: string }
  | { phase: 'creating'; checkout?: WorktreeCheckoutProgress | null }
  | { phase: 'output'; text: string }
  | { phase: 'copying' }
  | { phase: 'done'; worktree: Worktree }
  | { phase: 'failed'; reason: Exclude<CreateWorktreeResult, { ok: true }>['reason']; message: string }
)

/** Orca `BaseRefSearchResult`(src/shared/repo-types.ts) + 종류(태그를 아라가 더했다). */
export type BaseRef = { refName: string; kind: 'local' | 'remote' | 'tag' }

export type RemoveWorktreeResult = { ok: true } | { ok: false; message: string }

/**
 * 사이드바 +/− 줄 수 · 상태바 "main 에서 n 커밋 앞"(WS-05). base = 본 작업 폴더가 체크아웃한 브랜치.
 * 줄 수는 base 와의 갈림점부터 지금 작업 폴더까지(커밋 안 한 변경 포함 — Orca 카드의 +/− 와 같은 뜻).
 */
export type WorktreeStats = { ok: true; base: string; ahead: number; added: number; removed: number } | { ok: false }

/** `git diff --shortstat` 한 줄 → 더한·뺀 줄 수. 변경이 없으면 빈 출력 → 0·0. */
export function parseShortstat(out: string): { added: number; removed: number } {
  const added = /(\d+) insertions?\(\+\)/.exec(out)
  const removed = /(\d+) deletions?\(-\)/.exec(out)
  return { added: added ? Number(added[1]) : 0, removed: removed ? Number(removed[1]) : 0 }
}

/** Orca WORKTREE_ID_SEPARATOR(src/shared/pty-session-id-format.ts). */
export const WORKTREE_ID_SEPARATOR = '::'

export function composeWorktreeId(repoId: string, worktreePath: string): string {
  return `${repoId}${WORKTREE_ID_SEPARATOR}${worktreePath}`
}

// ── git worktree list --porcelain 파서 ─────────────────────────────────────────

/** Orca src/shared/git-cquoted-path.ts 그대로. */
export function decodeGitCQuotedPath(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') return value
  const simple: Record<string, string> = { a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }
  let decoded = ''
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      decoded += char
      continue
    }
    index += 1
    const escaped = value[index]
    if (escaped in simple) {
      decoded += simple[escaped]
    } else if (/[0-7]/.test(escaped)) {
      const bytes: number[] = []
      let octalStart = index
      while (octalStart < value.length - 1) {
        let octal = value[octalStart]
        let octalEnd = octalStart
        while (octalEnd + 1 < value.length - 1 && octal.length < 3 && /[0-7]/.test(value[octalEnd + 1])) {
          octalEnd += 1
          octal += value[octalEnd]
        }
        bytes.push(Number.parseInt(octal, 8))
        index = octalEnd
        if (value[index + 1] !== '\\' || !/[0-7]/.test(value[index + 2] ?? '')) break
        octalStart = index + 2
      }
      // git 은 이어진 UTF-8 바이트를 각각 8진수로 쓴다 — 바이트 단위로 글자를 만들면 한글 사유가 깨진다.
      decoded += new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes))
    } else {
      decoded += escaped
    }
  }
  return decoded
}

/** Orca src/shared/git-worktree-porcelain-parser.ts 그대로. */
export function parseWorktreeList(output: string, options: { nulDelimited?: boolean } = {}): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  const blocks = options.nulDelimited ? splitNulWorktreeList(output) : splitLineWorktreeList(output)
  const reason = (raw: string): string => (options.nulDelimited ? raw : decodeGitCQuotedPath(raw))
  for (const lines of blocks) {
    let path = ''
    let head = ''
    let branch = ''
    let isBare = false
    let isSparse = false
    let locked = false
    let lockReason = ''
    let prunable = false
    let prunableReason = ''
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length)
      else if (line === 'bare') isBare = true
      else if (line === 'sparse') isSparse = true
      else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true
        lockReason = reason(line.slice('locked'.length).trim())
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        // git 2.31+ 는 폴더가 사라진 등록을 표시한다 — 무시하면 낡은 워크트리가 살아 있는 것처럼 보인다(Orca #8389).
        prunable = true
        prunableReason = reason(line.slice('prunable'.length).trim())
      }
    }
    if (path) {
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        ...(isSparse ? { isSparse } : {}),
        ...(locked ? { locked: true } : {}),
        ...(lockReason ? { lockReason } : {}),
        ...(prunable ? { prunable: true } : {}),
        ...(prunableReason ? { prunableReason } : {}),
        isMainWorktree: worktrees.length === 0
      })
    }
  }
  return worktrees
}

function splitLineWorktreeList(output: string): string[][] {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim().split(/\r?\n/))
}

function splitNulWorktreeList(output: string): string[][] {
  if (!output.includes('\0')) return splitLineWorktreeList(output)
  const blocks: string[][] = []
  let current: string[] = []
  for (const field of output.split('\0')) {
    if (field) {
      current.push(field)
      continue
    }
    if (current.length > 0) blocks.push(current)
    current = []
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

// ── 이름 규칙 ─────────────────────────────────────────────────────────────────

/**
 * Orca sanitizeWorktreeName(src/main/ipc/worktree-logic.ts). 유니코드 글자·숫자는 남긴다(한글 이름 허용 —
 * 옛 `validWorktreeName` 의 영문 한정보다 넓다). 이모지 단축코드 표(emojibase)는 옮기지 않았다 — 이모지만이면 'workspace'.
 */
export function sanitizeWorktreeName(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    // git 은 경로 구분자를 바꾼 뒤에도 안쪽의 .. 를 거절한다.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
  if (!sanitized && /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u.test(input)) return 'workspace'
  if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('Invalid worktree name')
  return sanitized
}

/**
 * Orca computeValidatedBranchName(src/main/ipc/worktree-branch-name.ts)의 접두어 없는 판. git 은 `.lock` 으로 끝나는
 * ref 조각을 거절한다 — 브랜치만 고치고 폴더 이름은 그대로 둔다. 접두어(git-username·custom)는 설정 화면과 함께 2차.
 */
export function branchNameFor(sanitizedName: string): string {
  return sanitizedName.replace(/-?\.lock$/, '-lock')
}

/** Orca getWorktreeCreateCandidate(src/main/worktree-create-candidates.ts). */
export function worktreeCreateCandidate(value: string, suffix: number): string {
  return suffix === 1 ? value : `${value}-${suffix}`
}

/** Orca WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS. */
export const WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS = 100

// ── 경로 비교·생성 확인 ───────────────────────────────────────────────────────

/**
 * Orca areWorktreePathsEqual(src/main/git/worktree-path-comparison.ts)의 1차 판: 구분자·끝 슬래시를 맞추고,
 * win32 는 대소문자를 무시한다. macOS `/private` 별칭·WSL 경로 번역은 뺐다.
 */
export function areWorktreePathsEqual(a: string, b: string, platform: string): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '')
    if (platform === 'win32') s = s.toLowerCase()
    return s
  }
  return norm(a) === norm(b)
}

/** Orca findCreatedWorktree(src/main/ipc/created-worktree-reconciliation.ts) 그대로 — 경로 먼저, 안 되면 정확한 브랜치. */
export function findCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform: string
): T | undefined {
  return (
    worktrees.find((w) => areWorktreePathsEqual(w.path, requestedPath, platform)) ??
    worktrees.find((w) => w.branch === `refs/heads/${branchName}`)
  )
}

/**
 * 재시작 정리(WS-03). 생성을 시작할 때 main 이 이 기록을 남기고 끝나면 지운다 — 앱이 그 사이 죽으면 남는다.
 * 다음 기동에 git 목록과 맞춰 본다: 등록돼 있으면 **살린다**(git 은 끝냈다 — .worktreeinclude 복사만 빠졌을 수 있다),
 * 아니면 반쯤 만든 폴더를 지운다. `pathWasFree` 가 참일 때만 지운다 — 생성 전에 비어 있던 자리여야 우리 것이다.
 */
export type PendingCreation = {
  creationId: string
  repoId: string
  repoPath: string
  path: string
  branch: string
  startedAt: number
  pathWasFree: boolean
}

export type PendingVerdict = 'keep' | 'removeLeftover' | 'forget'

export function reconcilePendingCreation(
  pending: PendingCreation,
  listed: readonly GitWorktreeInfo[] | null,
  pathExists: boolean,
  platform: string
): PendingVerdict {
  // 목록을 못 읽었다(저장소가 사라짐 등) — 판단할 근거가 없으니 아무것도 지우지 않는다.
  if (listed === null) return 'forget'
  const found = findCreatedWorktree(listed, pending.path, pending.branch, platform)
  if (found && !found.prunable) return 'keep'
  return pathExists && pending.pathWasFree ? 'removeLeftover' : 'forget'
}

// ── git 진행 막대 ─────────────────────────────────────────────────────────────

/** Orca src/shared/git-progress-records.ts 그대로 — `Updating files: 45% (9/20)` 를 stderr 조각에서 읽는다. */
export type GitProgressRecord = { percent: number; completed: number; total: number; done: boolean }

const PROGRESS_COUNTERS = /^\s*(\d+)% \((\d+)\/(\d+)\)(, done\.)?/
const PROGRESS_MAX_PENDING_CHARS = 256

export function createGitProgressRecordReader(title: string, onRecord: (record: GitProgressRecord) => void): (chunk: string) => void {
  const prefix = `${title}:`
  let pending = ''
  // 막대가 COLUMNS(파이프 기본 80)보다 넓으면 제목을 한 번 찍고 숫자만 다시 찍는다.
  let titleOnOwnLine = false
  const readCounters = (text: string): boolean => {
    const match = PROGRESS_COUNTERS.exec(text)
    if (!match) return false
    const total = Number(match[3])
    if (total <= 0) return false
    onRecord({ percent: Math.min(100, Number(match[1])), completed: Number(match[2]), total, done: match[4] !== undefined })
    return true
  }
  const readLine = (line: string): void => {
    if (line === '') return
    if (line.startsWith(prefix)) {
      const counters = line.slice(prefix.length)
      titleOnOwnLine = counters.trim() === ''
      readCounters(counters)
      return
    }
    if (titleOnOwnLine && !readCounters(line)) titleOnOwnLine = false
  }
  return (chunk) => {
    const lines = (pending + chunk).split(/\r\n|\r|\n/)
    pending = (lines.pop() ?? '').slice(-PROGRESS_MAX_PENDING_CHARS)
    for (const line of lines) readLine(line)
  }
}

/** Orca createWorktreeCheckoutProgressReader(src/main/git/worktree-checkout-progress.ts) — null = 파일 쓰기 끝. */
export function createWorktreeCheckoutProgressReader(onProgress: (p: WorktreeCheckoutProgress | null) => void): {
  read: (chunk: string) => void
  close: () => void
} {
  let lastPercent = -1
  let closed = false
  const read = createGitProgressRecordReader('Updating files', (record) => {
    if (closed) return
    if (record.done) {
      closed = true
      onProgress(null)
      return
    }
    // 같은 % 재출력은 버린다.
    if (record.percent <= lastPercent) return
    lastPercent = record.percent
    onProgress({ percent: record.percent, completed: record.completed, total: record.total })
  })
  return { read, close: () => void (closed = true) }
}

// ── .worktreeinclude ──────────────────────────────────────────────────────────

/** Orca WORKTREE_INCLUDE_FILE(src/main/git/worktree-include-file.ts) — 새 워크트리에 복사할 gitignore 대상 목록. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude'
export const WORKTREE_INCLUDE_MAX_FILE_BYTES = 256 * 1024
export const WORKTREE_INCLUDE_MAX_ENTRIES = 1000

/** Orca parseWorktreeIncludeFile — 저장소 뿌리 기준 글자 그대로의 경로. */
export function parseWorktreeIncludeFile(content: string): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    entries.push(normalized)
  }
  return entries
}

export function isUnsupportedIncludePattern(entry: string): boolean {
  return entry.startsWith('!') || entry.includes('*') || entry.includes('?')
}

/** Orca isSafeIncludePath — 절대 경로·`..`·`.git` 은 막는다. */
export function isSafeIncludePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) return false
  const segments = relativePath.split('/')
  return !segments.includes('..') && !segments.includes('') && segments[0] !== '.git'
}

// ── 분기 지점(WS-04) ──────────────────────────────────────────────────────────

/** for-each-ref 의 형식 — 전체 이름 NUL 짧은 이름. */
export const BASE_REF_FORMAT = '--format=%(refname)%00%(refname:short)'

/**
 * Orca parseAndFilterSearchRefDetails(src/main/git/repo-base-ref-search.ts)의 1차 판: 원격 HEAD 를 빼고 짧은 이름으로
 * 겹침을 없앤다. 태그를 더했다(Orca 는 브랜치만 — 계획 WS-04 "로컬·원격 브랜치·태그").
 */
export function parseBaseRefs(stdout: string, query = '', limit = 50): BaseRef[] {
  const q = query.trim().toLowerCase()
  const seen = new Set<string>()
  const out: BaseRef[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    const nul = line.indexOf('\0')
    if (nul === -1) continue
    const full = line.slice(0, nul)
    const short = line.slice(nul + 1)
    const kind = full.startsWith('refs/heads/') ? 'local' : full.startsWith('refs/remotes/') ? 'remote' : full.startsWith('refs/tags/') ? 'tag' : null
    if (!kind || (kind === 'remote' && full.endsWith('/HEAD'))) continue
    if (q && !short.toLowerCase().includes(q)) continue
    if (seen.has(short)) continue
    seen.add(short)
    out.push({ refName: short, kind })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Orca resolveWorktreeAddBaseRef(src/shared/worktree/base-ref.ts) — 고른 이름을 정식 ref 로. 태그가 브랜치를 가리지
 * 않게: `/` 가 있으면 원격 먼저, 없으면 로컬.
 */
export async function resolveWorktreeAddBaseRef(baseRef: string, refExists: (qualifiedRef: string) => Promise<boolean>): Promise<string> {
  if (baseRef.startsWith('refs/')) return baseRef
  const candidates = baseRef.includes('/') ? [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`] : [`refs/heads/${baseRef}`]
  for (const candidate of candidates) if (await refExists(candidate)) return candidate
  return baseRef
}
