// M2 워크트리 git 호출 — 전부 runProcess(셸 없음·인자 배열·시간 상한)로. Orca src/main/git/ 의 1차 핵심만 다시 썼다
// (orcaRef 7a7f46f8a3). 각 함수 옆에 원본 경로. 빠진 것: 스캔 캐시·능력 캐시(git <2.36 -z 폴백)·WSL·sparse·ref 정비 일시정지.
import { cp, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess, type RunResult } from '../util/runProcess'
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
  type GitWorktreeInfo,
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
  opts: { signal?: AbortSignal; onCheckoutProgress?: (p: WorktreeCheckoutProgress | null) => void; onOutput?: (s: string) => void }
): Promise<RunResult> {
  const args = ['worktree', 'add', '--no-track', '-b', branch, worktreePath]
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
 * 복사 — Orca createWorktreeCopiedPaths 의 1차 판(fs.cp, 심볼릭 링크는 따라가지 않고 그대로). 실패한 경로를 돌려준다.
 * ponytail: Orca 의 복사 예산(2GB·5만 개)은 뺐다 — node_modules 같은 큰 폴더를 적으면 오래 걸린다. 걸리면 예산을 옮긴다.
 */
export async function copyIncludePaths(repoPath: string, worktreePath: string, relativePaths: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const p of relativePaths) {
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
