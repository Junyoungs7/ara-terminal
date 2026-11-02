// M2 워크트리 git 호출 — 전부 runProcess(셸 없음·인자 배열·시간 상한)로. Orca src/main/git/ 의 1차 핵심만 다시 썼다
// (orcaRef 7a7f46f8a3). 각 함수 옆에 원본 경로. 빠진 것: 스캔 캐시·능력 캐시(git <2.36 -z 폴백)·WSL·sparse·ref 정비 일시정지.
import { cp, lstat, mkdir, readFile, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess, type RunResult } from '../util/runProcess'
import { createWorktreeCopyBudgetTracker, type WorktreeCopyBudget } from './copyBudget'
import {
  BASE_REF_FORMAT,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_INCLUDE_MAX_ENTRIES,
  WORKTREE_INCLUDE_MAX_FILE_BYTES,
  createWorktreeCheckoutProgressReader,
  isSafeIncludePath,
  isUnsupportedIncludePattern,
  parseBaseRefs,
  parseWorktreeIncludeFile,
  parseWorktreeList,
  resolveWorktreeAddBaseRef,
  type BaseRef,
  type CleanupGitInfo,
  type GitWorktreeInfo,
  type PreservedBranch,
  type WorktreeCheckoutProgress
} from '@shared/worktrees'

/** Orca WORKTREE_LIST_TIMEOUT_MS 와 같은 자릿수. */
export const WORKTREE_LIST_TIMEOUT_MS = 30_000
/** Orca WORKTREE_ADD_TIMEOUT_MS — 큰 저장소·서브모듈·LFS 체크아웃은 오래 걸린다. 그 사이엔 취소로 끊는다. */
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000
const GIT_SHORT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
// check-ignore 를 인자로 넘기므로 명령줄 길이(Windows 32k)를 넘지 않게 나눈다(Orca 는 stdin -z — runProcess 에 stdin 이 없다).
const CHECK_IGNORE_CHUNK = 100

export function git(
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; onStderr?: (s: string) => void } = {}
): Promise<RunResult> {
  return runProcess('git', args, { cwd, timeoutMs: opts.timeoutMs ?? GIT_SHORT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal: opts.signal, onStderr: opts.onStderr })
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir)
  return r.code === 0 && r.stdout.trim() === 'true'
}

/** 저장소 뿌리(하위 폴더를 고르면 뿌리로 올린다 — Orca repos:add 와 같다). */
export async function gitTopLevel(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], dir)
  return r.code === 0 ? r.stdout.trim() || null : null
}

/** Orca readWorktreeList(src/main/git/worktree-list-reader.ts)의 -z 경로. 실패하면 null(빈 목록과 다르다). */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[] | null> {
  const r = await git(['worktree', 'list', '--porcelain', '-z'], repoPath, { timeoutMs: WORKTREE_LIST_TIMEOUT_MS })
  return r.code === 0 ? parseWorktreeList(r.stdout, { nulDelimited: true }) : null
}

/** 브랜치가 이미 있나(로컬 또는 원격) — Orca getBranchConflictKind(src/main/git/repo-branch-conflict.ts)의 1차 판. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await git(['for-each-ref', '--count=1', '--format=%(refname)', `refs/heads/${branch}`, `refs/remotes/*/${branch}`], repoPath)
  return r.code === 0 && r.stdout.trim() !== ''
}

/**
 * Orca addWorktree(src/main/git/worktree-add.ts)의 새 브랜치 경로: `--no-track -b <branch> <path> [<base>]`.
 * 분기 지점의 upstream 을 물려받지 않는다(Orca 와 같다). 진행 막대는 git 이 원래 찍는 stderr 를 읽는다.
 */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string | undefined,
  opts: { signal?: AbortSignal; onCheckoutProgress?: (p: WorktreeCheckoutProgress | null) => void; onOutput?: (s: string) => void; noCheckout?: boolean }
): Promise<RunResult> {
  // 3차 WS-27 sparse 는 파일을 안 쓰고 만든 뒤 고른 폴더만 체크아웃한다(Orca addWorktree 의 noCheckout).
  const args = ['worktree', 'add', ...(opts.noCheckout ? ['--no-checkout'] : []), '--no-track', '-b', branch, worktreePath]
  if (baseBranch) {
    args.push(await resolveWorktreeAddBaseRef(baseBranch, async (ref) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)).code === 0))
  }
  const progress = opts.onCheckoutProgress ? createWorktreeCheckoutProgressReader(opts.onCheckoutProgress) : null
  try {
    return await git(args, repoPath, {
      timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
      signal: opts.signal,
      onStderr: (s) => {
        progress?.read(s)
        opts.onOutput?.(s)
      }
    })
  } finally {
    progress?.close()
  }
}

/**
 * Orca removeWorktree(src/main/git/worktree-removal.ts) — `git worktree remove [--force] -- <path>`. **브랜치는 남긴다**
 * (Orca 와 같다 — 지우기는 작업 폴더만). force 가 아니면 커밋 안 된 변경이 있을 때 git 이 거절하고 그 말을 돌려준다.
 */
export async function removeWorktree(repoPath: string, worktreePath: string, force: boolean): Promise<RunResult> {
  const r = await git(['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath], repoPath, { timeoutMs: WORKTREE_LIST_TIMEOUT_MS })
  // 폴더를 손으로 지운 등록은 remove 가 "is not a working tree" 로 거절한다 — prune 이 맞는 길(Orca isOrphanedWorktreeError).
  if (r.code !== 0 && /is not a working tree/.test(r.stderr)) return git(['worktree', 'prune'], repoPath)
  return r
}

/** Orca checkIgnoredPaths(src/main/git/check-ignored-paths.ts) — 종료 1 = 하나도 무시 안 됨. */
export async function checkIgnoredPaths(repoPath: string, relativePaths: string[]): Promise<string[]> {
  const ignored: string[] = []
  for (let i = 0; i < relativePaths.length; i += CHECK_IGNORE_CHUNK) {
    // -z 는 --stdin 과만 된다 — 줄 단위로 받는다(.worktreeinclude 는 줄 단위라 경로에 줄바꿈이 없다).
    const r = await git(['check-ignore', '--', ...relativePaths.slice(i, i + CHECK_IGNORE_CHUNK)], repoPath)
    if (r.code !== 0 && r.code !== 1) throw r.error ?? new Error(r.stderr)
    ignored.push(...r.stdout.split(/\r?\n/).filter(Boolean))
  }
  return ignored
}

/** Orca resolveWorktreeIncludePaths(src/main/git/worktree-include-file.ts) — 있는 것·gitignore 된 것만. 실패하면 [] (생성을 막지 않는다). */
export async function resolveWorktreeIncludePaths(repoPath: string, warn: (msg: string) => void = () => {}): Promise<string[]> {
  try {
    const includePath = join(repoPath, WORKTREE_INCLUDE_FILE)
    const stats = await lstat(includePath).catch(() => null)
    if (!stats || !stats.isFile() || stats.size > WORKTREE_INCLUDE_MAX_FILE_BYTES) return []
    const candidates: string[] = []
    for (const entry of parseWorktreeIncludeFile(await readFile(includePath, 'utf8'))) {
      if (candidates.length >= WORKTREE_INCLUDE_MAX_ENTRIES) {
        warn(`${WORKTREE_INCLUDE_FILE} lists more than ${WORKTREE_INCLUDE_MAX_ENTRIES} entries; ignoring the rest`)
        break
      }
      if (isUnsupportedIncludePattern(entry)) warn(`Skipping unsupported ${WORKTREE_INCLUDE_FILE} pattern "${entry}"`)
      else if (!isSafeIncludePath(entry)) warn(`Skipping unsafe ${WORKTREE_INCLUDE_FILE} path "${entry}"`)
      else candidates.push(entry)
    }
    const existing: string[] = []
    for (const p of candidates) if (await lstat(join(repoPath, p)).then(() => true, () => false)) existing.push(p)
    if (existing.length === 0) return []
    // 무시 안 된(추적되는) 경로를 복사하면 새 워크트리에 가짜 변경이 생긴다.
    const ignored = new Set(await checkIgnoredPaths(repoPath, existing))
    return existing.filter((p) => ignored.has(p)).sort()
  } catch (e) {
    warn(`Failed to resolve ${WORKTREE_INCLUDE_FILE} paths: ${String(e)}`)
    return []
  }
}

/**
 * 복사 — Orca createWorktreeCopiedPaths 의 1차 판(fs.cp, 심볼릭 링크는 따라가지 않고 그대로). 못 옮긴 경로를 돌려준다.
 * Orca 복사 예산(2GB·5만 개, copyBudget.ts)을 먼저 잰다 — 넘는 항목은 복사하지 않고 사유(bytes·entries·sizing)를 붙인다.
 */
export async function copyIncludePaths(
  repoPath: string,
  worktreePath: string,
  relativePaths: string[],
  budget?: WorktreeCopyBudget
): Promise<string[]> {
  const failed: string[] = []
  const tracker = createWorktreeCopyBudgetTracker(budget)
  for (const p of relativePaths) {
    // M10 R2: 공유 경로로 이미 링크된 자리(또는 그 아래)는 다시 복사하지 않는다(Orca: 공유한 경로는 include 복사 안 함) —
    // 링크 안으로 복사하면 본 폴더 원본에 쓴다.
    if (await lstat(join(worktreePath, p)).then(() => true, () => false)) continue
    const verdict = await tracker.admit(join(repoPath, p))
    if (!verdict.withinBudget) {
      failed.push(`${p} (${verdict.reason})`)
      continue
    }
    try {
      await cp(join(repoPath, p), join(worktreePath, p), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true })
    } catch {
      failed.push(p)
    }
  }
  return failed
}

/** 분기 지점 목록(WS-04) — 로컬·원격 브랜치·태그, 최근 커밋 순. 검색어는 짧은 이름 부분 일치. */
export async function listBaseRefs(repoPath: string, query = '', limit = 50): Promise<BaseRef[]> {
  const r = await git(['for-each-ref', BASE_REF_FORMAT, '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags'], repoPath)
  return r.code === 0 ? parseBaseRefs(r.stdout, query, limit) : []
}

// ── M10 R2 WS-20 공유 경로(Orca src/main/ipc/worktree-symlinks.ts — link 갈래) ──

/** Orca worktreeSymlinkTypeCandidates — 폴더는 Windows 접합점(권한 불필요) 먼저, 파일은 file 심링크(Windows 는 개발자 모드가 없으면 실패 → 경고). */
export function linkTypeCandidates(platform: string, isDirectory: boolean): ('junction' | 'dir' | 'file')[] {
  if (!isDirectory) return ['file']
  return platform === 'win32' ? ['junction', 'dir'] : ['dir']
}

/**
 * 본 폴더의 경로를 새 워크트리에 링크로 만든다. 이미 있는 자리는 그대로 둔다(Orca: 있는 대상 보존). 원본이 없으면 건너뛴다.
 * 만든 것과 못 만든 것을 돌려준다 — 만든 것은 지울 때 링크만 먼저 끊으려고 메타에 남긴다.
 */
export async function linkSharedPaths(
  repoPath: string,
  worktreePath: string,
  relativePaths: readonly string[],
  platform: string = process.platform
): Promise<{ linked: string[]; failed: string[] }> {
  const linked: string[] = []
  const failed: string[] = []
  for (const p of relativePaths) {
    const source = join(repoPath, p)
    const target = join(worktreePath, p)
    const st = await stat(source).catch(() => null)
    if (!st) continue
    if (await lstat(target).then(() => true, () => false)) continue
    try {
      await mkdir(dirname(target), { recursive: true })
      let done = false
      let lastError: unknown
      for (const type of linkTypeCandidates(platform, st.isDirectory())) {
        try {
          await symlink(source, target, type)
          done = true
          break
        } catch (e) {
          lastError = e
        }
      }
      if (!done) throw lastError
      linked.push(p)
    } catch {
      failed.push(p)
    }
  }
  return { linked, failed }
}

/**
 * 지우기 전에 **링크만** 끊는다(Orca removeWorktreeLinkedPaths) — 진짜 파일·폴더는 안 건드린다. 링크를 남긴 채 git·rm 이
 * 폴더를 지우면 접합점을 따라 들어가 본 폴더 원본을 지울 수 있다(아라 메모: worktree junction 은 원본을 지운다).
 */
export async function unlinkSharedPaths(worktreePath: string, relativePaths: readonly string[]): Promise<void> {
  for (const p of relativePaths) {
    if (!isSafeIncludePath(p)) continue
    const target = join(worktreePath, p)
    try {
      if ((await lstat(target)).isSymbolicLink()) await unlink(target)
    } catch {
      // 없거나 못 끊음 — 끊지 못한 링크가 남으면 git 이 거절하거나(링크 = 추적 안 된 것) 링크째 지운다
    }
  }
}

// ── M10 R2 WS-21 보존 브랜치(Orca src/main/git/worktree-branch-removal.ts) — 로컬·원격이 같은 규칙을 쓰게 git 실행만 받는다 ──

export type GitRun = (args: string[]) => Promise<{ code: number; out: string; err: string }>
export const localGitRun =
  (repoPath: string): GitRun =>
  async (args) => {
    const r = await git(args, repoPath)
    return { code: r.code, out: r.stdout, err: r.stderr }
  }
const CHECKED_OUT = /checked out at|used by worktree/i

/**
 * Orca deleteBranchAfterWorktreeRemoval — `branch -d`(병합 안 된 커밋 보호). git 이 거절하면 지우지 않고 남긴 브랜치로 알린다.
 * 다른 워크트리에 체크아웃돼 있으면 낡은 등록일 수 있어 prune 후 한 번 더, 그래도면 조용히 둔다(Orca 'checked-out').
 * 뺀 것: 스쿼시 병합 판정(병합된 트리면 -D — Orca deleteAlreadyMergedBranchAfterSafeDeleteFailure). 그런 브랜치는 검토로 온다.
 */
export async function deleteBranchAfterRemoval(run: GitRun, branchName: string, head: string): Promise<PreservedBranch | undefined> {
  if (!branchName) return undefined
  let r = await run(['branch', '-d', '--', branchName])
  if (r.code !== 0 && CHECKED_OUT.test(r.err)) {
    await run(['worktree', 'prune'])
    r = await run(['branch', '-d', '--', branchName])
    if (r.code !== 0 && CHECKED_OUT.test(r.err)) return undefined
  }
  return r.code === 0 ? undefined : { branchName, head }
}

/** Orca forceDeleteLocalBranch — 그사이 브랜치가 움직였으면(head 다름) 안 지운다(update-ref 대조 삭제). 체크아웃된 브랜치도 안 지운다. */
export async function forceDeleteBranch(run: GitRun, branchName: string, head: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!branchName || /[\0\s]/.test(branchName) || branchName.startsWith('-') || !/^[0-9a-f]{40,64}$/i.test(head) || /^0+$/.test(head)) return { ok: false, message: branchName }
  const list = await run(['worktree', 'list', '--porcelain'])
  if (list.code === 0 && parseWorktreeList(list.out).some((w) => w.branch === `refs/heads/${branchName}`)) {
    return { ok: false, message: `Local branch "${branchName}" is checked out in another worktree.` }
  }
  const r = await run(['update-ref', '-d', `refs/heads/${branchName}`, head])
  if (r.code !== 0) return { ok: false, message: `Local branch "${branchName}" changed after the workspace was deleted. Review it before deleting it.` }
  await run(['config', '--remove-section', `branch.${branchName}`])
  return { ok: true }
}

// ── 3차 WS-27 sparse checkout(Orca src/main/git/worktree-sparse-add.ts addSparseWorktree) ──

/** --no-checkout 으로 만든 워크트리에 cone 모드로 고른 폴더만 체크아웃한다. 실패하면 git 의 말(지우기는 부르는 쪽이). */
export async function applySparseCheckout(worktreePath: string, branch: string, directories: readonly string[], signal?: AbortSignal): Promise<RunResult> {
  const steps = [
    ['sparse-checkout', 'init', '--cone'],
    ['sparse-checkout', 'set', '--', ...directories],
    ['checkout', branch]
  ]
  let r: RunResult = { code: 0, stdout: '', stderr: '', error: null }
  for (const args of steps) {
    r = await git(args, worktreePath, { timeoutMs: WORKTREE_ADD_TIMEOUT_MS, signal })
    if (r.code !== 0) return r
  }
  return r
}

// ── 3차 WS-25 정리 화면 git 상태(Orca workspace-cleanup-scan 의 아라판) ──

/**
 * 작업 단위 하나의 상태 — 커밋 안 한 변경 수(status --porcelain 줄 수)·본 폴더 HEAD 에 다 들어갔나(merge-base --is-ancestor)·마지막 커밋 시각.
 * 못 읽은 칸은 보수적으로(변경 있음 1, 병합 안 됨) — 정리 화면이 지워도 되는 것처럼 보이지 않게.
 */
export async function cleanupGitInfo(worktreePath: string, mainHead: string): Promise<CleanupGitInfo> {
  const [status, ancestor, last] = await Promise.all([
    git(['status', '--porcelain', '--untracked-files=normal'], worktreePath),
    mainHead ? git(['merge-base', '--is-ancestor', 'HEAD', mainHead], worktreePath) : Promise.resolve(null),
    git(['log', '-1', '--format=%ct'], worktreePath)
  ])
  const ts = Number(last.stdout.trim())
  return {
    path: worktreePath,
    dirty: status.code === 0 ? status.stdout.split(/\r?\n/).filter(Boolean).length : 1,
    merged: ancestor?.code === 0,
    lastCommitAt: last.code === 0 && ts > 0 ? ts * 1000 : null
  }
}
