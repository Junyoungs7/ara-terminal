// M2 작업 단위 서비스 — 프로젝트 등록 + 워크트리 목록·생성·지우기 + 생성 진행 + 재시작 정리 + 분기 지점.
// Electron 을 모른다(시험이 임시 git 저장소로 바로 돈다). IPC 는 feature.ts 가 건다.
// Orca 원본(orcaRef 7a7f46f8a3): src/main/ipc/worktree-remote.ts(createLocalWorktree 의 이름 고르기·경로 확인),
// src/main/ipc/created-worktree-reconciliation.ts(생성 확인), src/main/runtime/runtime-local-worktree-materialization.ts(.worktreeinclude 복사).
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ProjectStore } from './ProjectStore'
import { computeWorkspaceRoot, computeWorktreePath, ensurePathWithinWorkspace, getDefaultWorkspaceDir } from './paths'
import {
  addWorktree,
  branchExists,
  copyIncludePaths,
  git,
  gitTopLevel,
  listBaseRefs,
  listWorktrees,
  removeWorktree,
  resolveWorktreeIncludePaths
} from './git'
import {
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS,
  areWorktreePathsEqual,
  branchNameFor,
  composeWorktreeId,
  findCreatedWorktree,
  reconcilePendingCreation,
  sanitizeWorktreeName,
  worktreeCreateCandidate,
  type BaseRef,
  type CreateWorktreeArgs,
  type CreateWorktreeProgressEvent,
  type CreateWorktreeResult,
  type GitWorktreeInfo,
  type PendingCreation,
  type Project,
  type RemoveWorktreeResult,
  type Worktree
} from '@shared/worktrees'

export type AddProjectResult = { ok: true; project: Project } | { ok: false; reason: 'notFound'; message: string }
export type ListWorktreesResult = { ok: true; worktrees: Worktree[] } | { ok: false; message: string }

export type WorktreeServiceDeps = {
  store: ProjectStore
  emit: (e: CreateWorktreeProgressEvent) => void
  platform?: string
  /** 워크트리를 둘 뿌리. 기본 `~/ara/workspaces`(Orca `~/orca/workspaces`). */
  workspaceDir?: string
  nestWorkspaces?: boolean
  warn?: (msg: string) => void
}

function toWorktree(repoId: string, w: GitWorktreeInfo): Worktree {
  const short = w.branch.replace(/^refs\/heads\//, '')
  const base = w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? w.path
  return { ...w, id: composeWorktreeId(repoId, w.path), repoId, displayName: short || base }
}

export function createWorktreeService(deps: WorktreeServiceDeps) {
  const platform = deps.platform ?? process.platform
  const workspaceDir = deps.workspaceDir ?? getDefaultWorkspaceDir(homedir())
  const nestWorkspaces = deps.nestWorkspaces ?? true
  const warn = deps.warn ?? (() => {})
  const same = (a: string, b: string): boolean => areWorktreePathsEqual(a, b, platform)
  const inflight = new Map<string, AbortController>()

  /** 반쯤 만든 것 치우기 — 우리가 비어 있던 자리에 만든 폴더와 그 등록, 그리고 -b 로 막 만든 브랜치. */
  async function cleanupFailedCreation(p: PendingCreation): Promise<void> {
    if (p.pathWasFree && existsSync(p.path)) await rm(p.path, { recursive: true, force: true }).catch(() => {})
    await git(['worktree', 'prune'], p.repoPath)
    await git(['branch', '-D', p.branch], p.repoPath)
  }

  async function listFor(project: Project): Promise<ListWorktreesResult> {
    // 폴더 프로젝트 = 작업 단위 하나(그 폴더 자체). Orca folder workspace.
    if (project.kind === 'folder') {
      return { ok: true, worktrees: [toWorktree(project.id, { path: project.path, head: '', branch: '', isBare: false, isMainWorktree: true })] }
    }
    const listed = await listWorktrees(project.path)
    if (listed === null) return { ok: false, message: project.path }
    // 외부(터미널·다른 도구)에서 만든 워크트리도 git 목록에 있으니 그대로 보인다. bare 줄은 작업 폴더가 아니다.
    return { ok: true, worktrees: listed.filter((w) => !w.isBare).map((w) => toWorktree(project.id, w)) }
  }

  return {
    listProjects: (): Project[] => deps.store.list(),

    async addProject(rawPath: string): Promise<AddProjectResult> {
      if (typeof rawPath !== 'string' || rawPath === '' || !existsSync(rawPath) || !statSync(rawPath).isDirectory()) {
        return { ok: false, reason: 'notFound', message: String(rawPath) }
      }
      // 저장소 하위 폴더를 골랐으면 뿌리로 올린다. git 이 아니면 폴더 프로젝트.
      const top = await gitTopLevel(rawPath)
      return { ok: true, project: deps.store.add(top ?? rawPath, top ? 'git' : 'folder', same) }
    },

    removeProject: (id: string): { ok: boolean } => ({ ok: deps.store.remove(id) }),

    async listWorktrees(repoId: string): Promise<ListWorktreesResult> {
      const project = deps.store.get(repoId)
      return project ? listFor(project) : { ok: false, message: repoId }
    },

    async createWorktree(args: CreateWorktreeArgs): Promise<CreateWorktreeResult> {
      const { creationId, repoId } = args
      const project = deps.store.get(repoId)
      const fail = (r: CreateWorktreeResult & { ok: false }): CreateWorktreeResult => {
        deps.emit({ creationId, repoId, phase: 'failed', reason: r.reason, message: r.message })
        return r
      }
      if (!project) return fail({ ok: false, reason: 'notFound', message: repoId })
      if (project.kind !== 'git') return fail({ ok: false, reason: 'notRepo', message: project.path })
      if (inflight.has(creationId)) return fail({ ok: false, reason: 'collision', message: creationId })
      let sanitized: string
      try {
        sanitized = sanitizeWorktreeName(String(args.name ?? ''))
      } catch {
        return fail({ ok: false, reason: 'invalidName', message: String(args.name) })
      }

      // 이름 고르기 — name, name-2, name-3 … 브랜치도 폴더도 비어 있는 첫 후보(Orca createLocalWorktree 의 resolve_name).
      const settings = { workspaceDir, nestWorkspaces }
      const root = computeWorkspaceRoot(project.path, workspaceDir)
      let picked: { path: string; branch: string } | null = null
      for (let suffix = 1; suffix <= WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS && !picked; suffix += 1) {
        const candidate = worktreeCreateCandidate(sanitized, suffix)
        const branch = branchNameFor(candidate)
        if (await branchExists(project.path, branch)) continue
        const path = ensurePathWithinWorkspace(computeWorktreePath(candidate, project.path, settings), root)
        if (existsSync(path)) continue
        picked = { path, branch }
      }
      if (!picked) return fail({ ok: false, reason: 'collision', message: sanitized })

      const pending: PendingCreation = { creationId, repoId, repoPath: project.path, ...picked, startedAt: Date.now(), pathWasFree: true }
      deps.store.beginPending(pending)
      const controller = new AbortController()
      inflight.set(creationId, controller)
      deps.emit({ creationId, repoId, phase: 'start', path: picked.path, branch: picked.branch })
      try {
        deps.emit({ creationId, repoId, phase: 'creating' })
        const r = await addWorktree(project.path, picked.path, picked.branch, args.baseBranch || undefined, {
          signal: controller.signal,
          onCheckoutProgress: (checkout) => deps.emit({ creationId, repoId, phase: 'creating', checkout }),
          onOutput: (text) => deps.emit({ creationId, repoId, phase: 'output', text })
        })
        if (r.code !== 0) {
          await cleanupFailedCreation(pending)
          if (controller.signal.aborted) return fail({ ok: false, reason: 'canceled', message: picked.path })
          return fail({ ok: false, reason: 'git', message: `${r.stderr}${r.stdout}`.trim() || String(r.error) })
        }
        // 만든 것을 git 목록에서 다시 찾는다(Orca resolveCreatedWorktree — 경로 별칭이면 브랜치로).
        const listed = (await listWorktrees(project.path)) ?? []
        const created = findCreatedWorktree(listed, picked.path, picked.branch, platform)
        if (!created) return fail({ ok: false, reason: 'git', message: `Worktree created but not found in listing: ${picked.path} (branch ${picked.branch})` })
        // .worktreeinclude(Orca 기본값 — 파일이 있을 때만, gitignore 된 것만). 실패해도 생성은 성공이다.
        let includeCopyWarning: string | undefined
        const include = await resolveWorktreeIncludePaths(project.path, warn)
        if (include.length > 0) {
          deps.emit({ creationId, repoId, phase: 'copying' })
          const skipped = await copyIncludePaths(project.path, created.path, include)
          if (skipped.length > 0) includeCopyWarning = skipped.join(', ')
        }
        const worktree = toWorktree(repoId, created)
        deps.emit({ creationId, repoId, phase: 'done', worktree })
        return { ok: true, worktree, ...(includeCopyWarning ? { includeCopyWarning } : {}) }
      } finally {
        inflight.delete(creationId)
        deps.store.endPending(creationId)
      }
    },

    cancelCreate(creationId: string): { ok: boolean } {
      const c = inflight.get(creationId)
      c?.abort()
      return { ok: c !== undefined }
    },

    async removeWorktree(repoId: string, worktreePath: string, force = false): Promise<RemoveWorktreeResult> {
      const project = deps.store.get(repoId)
      if (!project || project.kind !== 'git') return { ok: false, message: repoId }
      // 렌더러가 보낸 경로는 신뢰하지 않는다 — git 목록에 있는 연결 워크트리만 지운다(본 폴더는 안 된다).
      const listed = (await listWorktrees(project.path)) ?? []
      const target = listed.find((w) => !w.isMainWorktree && same(w.path, worktreePath))
      if (!target) return { ok: false, message: worktreePath }
      const r = await removeWorktree(project.path, target.path, force === true)
      return r.code === 0 ? { ok: true } : { ok: false, message: `${r.stderr}${r.stdout}`.trim() || String(r.error) }
    },

    async searchBaseRefs(repoId: string, query: string): Promise<BaseRef[]> {
      const project = deps.store.get(repoId)
      return project?.kind === 'git' ? listBaseRefs(project.path, typeof query === 'string' ? query : '') : []
    },

    /** 기동 때 한 번 — 앱이 죽어 남은 생성 기록을 git 목록과 맞춰 정리한다(WS-03). */
    async reconcilePending(): Promise<{ creationId: string; verdict: string }[]> {
      const out: { creationId: string; verdict: string }[] = []
      for (const p of [...deps.store.pending()]) {
        const verdict = reconcilePendingCreation(p, await listWorktrees(p.repoPath), existsSync(p.path), platform)
        if (verdict === 'removeLeftover') await cleanupFailedCreation(p)
        deps.store.endPending(p.creationId)
        out.push({ creationId: p.creationId, verdict })
      }
      return out
    }
  }
}

export type WorktreeService = ReturnType<typeof createWorktreeService>
