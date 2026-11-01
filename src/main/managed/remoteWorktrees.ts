// M8 DM-04 SSH 워크트리 — 로컬 M2 워크트리 규칙(main/worktrees/service.ts·git.ts)을 원격 git 으로. 명령은 SSH exec(`execSh`) 한 번씩 —
// orcad 를 거치지 않는다(git 은 PTY 가 필요 없고, 동의 없이 워크트리만 쓰는 사람도 같은 길). 원격에 만드는 것은 사용자가 고른 저장소의 워크트리뿐.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/ipc/worktree-logic.ts computeRemoteWorktreePath(형제 자리), src/main/git/worktree-add.ts(--no-track -b).
// 뺀 것: .worktreeinclude 복사(원격 파일 복사는 2차), 생성 취소·진행 막대(원격 stderr 진행은 안 읽는다), 재시작 정리 기록(pending).
// `worktree list -z` 는 git 2.36+ 라 사내 서버(2.3x 이하)를 위해 줄 단위 porcelain 을 읽는다.
import {
  BASE_REF_FORMAT,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS,
  branchNameFor,
  findCreatedWorktree,
  parseBaseRefs,
  parseWorktreeList,
  resolveWorktreeAddBaseRef,
  worktreeCreateCandidate,
  type BaseRef,
  type GitWorktreeInfo
} from '@shared/worktrees'
import { remoteCandidateScript, remoteGitScript, remoteWorktreePath, sameRemotePath, shArg } from '@shared/runOn'
import type { ExecResult } from './host'

/** 그 서버에서 `sh -c` 한 번(시간 상한). 연결은 부르는 쪽이 고른다. */
export type RemoteRun = (script: string, timeoutMs?: number) => Promise<ExecResult>

const LIST_TIMEOUT_MS = 30_000
/** 로컬 WORKTREE_ADD_TIMEOUT_MS 와 같다 — 큰 저장소 체크아웃. */
const ADD_TIMEOUT_MS = 10 * 60_000

const errOf = (r: ExecResult): string => `${r.err}${r.out}`.trim() || `exit ${r.code}`

/** 원격 저장소 뿌리(하위 폴더면 뿌리로). git 이 아니거나 폴더가 없으면 null. `~` 는 홈으로 편다. */
export async function remoteTopLevel(run: RemoteRun, path: string): Promise<string | null> {
  const r = await run(remoteGitScript(path, ['rev-parse', '--show-toplevel']))
  return r.code === 0 ? r.out.trim() || null : null
}

export async function remoteListWorktrees(run: RemoteRun, repoPath: string): Promise<GitWorktreeInfo[] | null> {
  const r = await run(remoteGitScript(repoPath, ['worktree', 'list', '--porcelain']), LIST_TIMEOUT_MS)
  return r.code === 0 ? parseWorktreeList(r.out) : null
}

export async function remoteBaseRefs(run: RemoteRun, repoPath: string, query: string): Promise<BaseRef[]> {
  const r = await run(remoteGitScript(repoPath, ['for-each-ref', BASE_REF_FORMAT, '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags']))
  return r.code === 0 ? parseBaseRefs(r.out, query) : []
}

export type RemoteAddResult = { ok: true; worktree: GitWorktreeInfo; branch: string } | { ok: false; reason: 'collision' | 'git'; message: string }

/**
 * 로컬 createWorktree 와 같은 순서: 이름 고르기(name, name-2 … 브랜치·폴더 둘 다 빈 첫 후보) → `worktree add --no-track -b` → 목록에서 다시 찾기.
 * 실패하면 반쯤 만든 것(우리가 비어 있던 자리에 만든 폴더·등록·막 만든 브랜치)을 치운다.
 */
export async function remoteAddWorktree(run: RemoteRun, repoPath: string, sanitizedName: string, baseBranch?: string): Promise<RemoteAddResult> {
  let picked: { path: string; branch: string } | null = null
  for (let suffix = 1; suffix <= WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS && !picked; suffix += 1) {
    const candidate = worktreeCreateCandidate(sanitizedName, suffix)
    const branch = branchNameFor(candidate)
    const path = remoteWorktreePath(repoPath, candidate)
    const r = await run(remoteCandidateScript(repoPath, path, branch))
    if (r.code !== 0) return { ok: false, reason: 'git', message: errOf(r) }
    if (!/^(branch|path)=1$/m.test(r.out)) picked = { path, branch }
  }
  if (!picked) return { ok: false, reason: 'collision', message: sanitizedName }
  const args = ['worktree', 'add', '--no-track', '-b', picked.branch, picked.path]
  if (baseBranch) args.push(await resolveWorktreeAddBaseRef(baseBranch, async (ref) => (await run(remoteGitScript(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))).code === 0))
  const add = await run(remoteGitScript(repoPath, args), ADD_TIMEOUT_MS)
  if (add.code !== 0) {
    await run(`cd -- ${shArg(repoPath)} && { rm -rf -- ${shArg(picked.path)}; git worktree prune; git branch -D ${shArg(picked.branch)}; } >/dev/null 2>&1; true`)
    return { ok: false, reason: 'git', message: errOf(add) }
  }
  const created = findCreatedWorktree((await remoteListWorktrees(run, repoPath)) ?? [], picked.path, picked.branch, 'linux')
  if (!created) return { ok: false, reason: 'git', message: `Worktree created but not found in listing: ${picked.path} (branch ${picked.branch})` }
  return { ok: true, worktree: created, branch: picked.branch }
}

/** 목록에 있는 연결 워크트리만 지운다(본 폴더·남의 경로 불가 — 렌더러 값 불신). 폴더를 손으로 지운 등록은 prune. */
export async function remoteRemoveWorktree(run: RemoteRun, repoPath: string, worktreePath: string, force: boolean): Promise<{ ok: true } | { ok: false; message: string }> {
  const listed = (await remoteListWorktrees(run, repoPath)) ?? []
  const target = listed.find((w) => !w.isMainWorktree && sameRemotePath(w.path, worktreePath))
  if (!target) return { ok: false, message: worktreePath }
  let r = await run(remoteGitScript(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', target.path]), LIST_TIMEOUT_MS)
  if (r.code !== 0 && /is not a working tree/.test(r.err)) r = await run(remoteGitScript(repoPath, ['worktree', 'prune']))
  return r.code === 0 ? { ok: true } : { ok: false, message: errOf(r) }
}
