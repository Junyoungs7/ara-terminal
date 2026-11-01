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
  deleteBranchAfterRemoval,
  forceDeleteBranch,
  git,
  linkSharedPaths,
  localGitRun,
  unlinkSharedPaths,
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
  type Worktree,
  type WorktreeStats,
  type ProjectGroup,
  type SleepTab,
  type WorktreeMeta,
  WORKTREE_ID_SEPARATOR,
  WORKTREE_COMMENT_MAX,
  EXTERNAL_SOURCES,
  classifyExternal,
  isSafeIncludePath,
  isWorkspaceStatus,
  parseWorktreeIncludeFile,
  parseShortstat
} from '@shared/worktrees'
import { creatureNameTier, normalizeSuggestedName, suggestionPathBasename } from '@shared/worktreeNames'
import { isAgentId } from '@shared/agents'
import { remoteAddWorktree, remoteBaseRefs, remoteGitRun, remoteListWorktrees, remoteRemoveWorktree, remoteTopLevel, type RemoteRun } from '../managed/remoteWorktrees'
import { sameRemotePath } from '@shared/runOn'

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
  /** M8 DM-04: 원격 저장소(project.host)의 git 을 돌릴 길. 없으면 원격 프로젝트는 목록·생성이 실패로 답한다. */
  remote?: (hostKey: string) => RemoteRun
}

const shortBranchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '')

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
  /** M10 WS-16 메타(보관·잠든 탭·R2 체크포인트)를 얹고, R2 WS-19 아라 밖 워크트리면 출처·숨김을 단다. linkedPaths 는 main 만 쓴다. */
  const withMeta = (project: Project, w: Worktree): Worktree => {
    const meta = deps.store.meta(w.id)
    const { linkedPaths: _l, ...shown } = meta ?? {}
    return { ...w, ...shown, ...classifyExternal(project, w, meta, project.host ? sameRemotePath : same) }
  }
  /** M10 WS-14 지운 작업 단위가 자동 이름이었으면 그 이름을 은퇴시키고, 메타도 지운다(Orca addRetiredWorktreeName — 자동 이름만). */
  const afterRemove = (repoId: string, path: string): void => {
    deps.store.forgetMeta(composeWorktreeId(repoId, path))
    const name = normalizeSuggestedName(suggestionPathBasename(path))
    if (creatureNameTier(name) !== null) deps.store.retireName(repoId, name)
  }

  /** 반쯤 만든 것 치우기 — 우리가 비어 있던 자리에 만든 폴더와 그 등록, 그리고 -b 로 막 만든 브랜치. */
  async function cleanupFailedCreation(p: PendingCreation): Promise<void> {
    if (p.pathWasFree && existsSync(p.path)) await rm(p.path, { recursive: true, force: true }).catch(() => {})
    await git(['worktree', 'prune'], p.repoPath)
    await git(['branch', '-D', p.branch], p.repoPath)
  }

  const runOn = (host: string): RemoteRun => {
    if (!deps.remote) throw new Error('원격 저장소를 쓸 수 없습니다.')
    return deps.remote(host)
  }
  /** 원격은 연결 실패(throw)도 실패 답으로 — 사이드바·생성 카드가 예외 없이 사유를 보인다. */
  const remoteTry = async <T,>(job: () => Promise<T>, fail: (message: string) => T): Promise<T> => {
    try {
      return await job()
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

  async function listFor(project: Project): Promise<ListWorktreesResult> {
    if (project.host) {
      const host = project.host
      return remoteTry(
        async () => {
          const listed = await remoteListWorktrees(runOn(host), project.path)
          return listed === null ? { ok: false, message: project.path } : { ok: true, worktrees: listed.filter((w) => !w.isBare).map((w) => withMeta(project, toWorktree(project.id, w))) }
        },
        (message) => ({ ok: false, message })
      )
    }
    // 폴더 프로젝트 = 작업 단위 하나(그 폴더 자체). Orca folder workspace.
    if (project.kind === 'folder') {
      return { ok: true, worktrees: [withMeta(project, toWorktree(project.id, { path: project.path, head: '', branch: '', isBare: false, isMainWorktree: true }))] }
    }
    const listed = await listWorktrees(project.path)
    if (listed === null) return { ok: false, message: project.path }
    // 외부(터미널·Claude Code 등)에서 만든 워크트리도 싣는다 — 숨길지는 hidden 표시로(렌더러가 "숨은 워크트리" 카드에 센다). bare 줄은 작업 폴더가 아니다.
    return { ok: true, worktrees: listed.filter((w) => !w.isBare).map((w) => withMeta(project, toWorktree(project.id, w))) }
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

    /** M8 DM-04: 관리형 서버의 원격 저장소 등록. 하위 폴더면 뿌리로. git 저장소만(원격 폴더 프로젝트는 뺐다). */
    async addRemoteProject(hostKey: string, rawPath: string): Promise<AddProjectResult> {
      if (typeof hostKey !== 'string' || !hostKey || typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false, reason: 'notFound', message: String(rawPath) }
      return remoteTry<AddProjectResult>(
        async () => {
          const top = await remoteTopLevel(runOn(hostKey), rawPath.trim())
          return top ? { ok: true, project: deps.store.add(top, 'git', sameRemotePath, hostKey) } : { ok: false, reason: 'notFound', message: rawPath }
        },
        (message) => ({ ok: false, reason: 'notFound', message })
      )
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
      // 같은 id 가 이미 돌고 있다 — 그쪽 진행을 'failed' 로 덮지 않게 이벤트 없이 거절한다.
      if (inflight.has(creationId)) return { ok: false, reason: 'collision', message: creationId }
      let sanitized: string
      try {
        sanitized = sanitizeWorktreeName(String(args.name ?? ''))
      } catch {
        return fail({ ok: false, reason: 'invalidName', message: String(args.name) })
      }
      if (project.host) {
        const host = project.host
        inflight.set(creationId, new AbortController()) // 원격은 취소를 못 한다 — 같은 id 겹침만 막는다
        try {
          deps.emit({ creationId, repoId, phase: 'creating' })
          const r = await remoteTry(
            () => remoteAddWorktree(runOn(host), project.path, sanitized, args.baseBranch || undefined),
            (message) => ({ ok: false as const, reason: 'git' as const, message })
          )
          if (!r.ok) return fail(r)
          // WS-19 아라가 만든 것 — 아라 밖 워크트리로 숨기지 않게.
          deps.store.updateMeta(composeWorktreeId(repoId, r.worktree.path), { createdAt: Date.now() })
          const worktree = withMeta(project, toWorktree(repoId, r.worktree))
          deps.emit({ creationId, repoId, phase: 'done', worktree })
          return { ok: true, worktree }
        } finally {
          inflight.delete(creationId)
        }
      }

      // 이름 고르기 — name, name-2, name-3 … 브랜치도 폴더도 비어 있는 첫 후보(Orca createLocalWorktree 의 resolve_name).
      const settings = { workspaceDir, nestWorkspaces }
      const root = computeWorkspaceRoot(project.path, workspaceDir)
      // M10 WS-14 자동 이름이면 지운 이름을 건너뛴다(시도 횟수엔 안 친다 — Orca resolve_name).
      const retired = args.nameWasGenerated === true && creatureNameTier(sanitized) !== null ? new Set(project.retiredNames ?? []) : null
      let picked: { path: string; branch: string } | null = null
      for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS && !picked; suffix += 1) {
        const candidate = worktreeCreateCandidate(sanitized, suffix)
        if (retired?.has(normalizeSuggestedName(candidate))) continue
        attempts += 1
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
        // WS-19 아라가 만든 것. WS-20 공유 경로(링크)를 먼저, 그다음 .worktreeinclude 복사(Orca 순서 — 링크된 자리는 복사 안 함).
        // 만든 링크는 메타에 남긴다 — 나중에 설정이 바뀌어도 지울 때 그 링크를 먼저 끊는다.
        const shared = (project.sharedPaths ?? []).filter(isSafeIncludePath)
        const links = shared.length > 0 ? await linkSharedPaths(project.path, created.path, shared, platform) : { linked: [], failed: [] }
        deps.store.updateMeta(composeWorktreeId(repoId, created.path), { createdAt: Date.now(), ...(links.linked.length > 0 ? { linkedPaths: links.linked } : {}) })
        // .worktreeinclude(Orca 기본값 — 파일이 있을 때만, gitignore 된 것만). 실패해도 생성은 성공이다.
        const skipped = links.failed.map((p) => `${p} (link)`)
        const include = await resolveWorktreeIncludePaths(project.path, warn)
        if (include.length > 0) {
          deps.emit({ creationId, repoId, phase: 'copying' })
          skipped.push(...(await copyIncludePaths(project.path, created.path, include)))
        }
        const includeCopyWarning = skipped.length > 0 ? skipped.join(', ') : undefined
        const worktree = withMeta(project, toWorktree(repoId, created))
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
      if (project.host) {
        const host = project.host
        return remoteTry(
          async (): Promise<RemoveWorktreeResult> => {
            const run = runOn(host)
            const r = await remoteRemoveWorktree(run, project.path, worktreePath, force === true)
            if (!r.ok) return r
            afterRemove(repoId, r.target.path)
            // WS-21 브랜치도 지운다(-d). 병합 안 된 커밋이 있으면 남기고 알린다.
            const preserved = await deleteBranchAfterRemoval(remoteGitRun(run, project.path), shortBranchOf(r.target.branch), r.target.head)
            return preserved ? { ok: true, preservedBranch: preserved } : { ok: true }
          },
          (message): RemoveWorktreeResult => ({ ok: false, message })
        )
      }
      // 렌더러가 보낸 경로는 신뢰하지 않는다 — git 목록에 있는 연결 워크트리만 지운다(본 폴더는 안 된다).
      const listed = (await listWorktrees(project.path)) ?? []
      const target = listed.find((w) => !w.isMainWorktree && same(w.path, worktreePath))
      if (!target) return { ok: false, message: worktreePath }
      // WS-20 링크부터 끊는다 — 만들 때 남긴 것 + 지금 설정(손으로 만든 링크도). 진짜 폴더·파일은 안 건드린다.
      const linked = deps.store.meta(composeWorktreeId(repoId, target.path))?.linkedPaths ?? []
      await unlinkSharedPaths(target.path, [...new Set([...linked, ...(project.sharedPaths ?? [])])])
      const r = await removeWorktree(project.path, target.path, force === true)
      if (r.code !== 0) return { ok: false, message: `${r.stderr}${r.stdout}`.trim() || String(r.error) }
      afterRemove(repoId, target.path)
      // WS-21 브랜치도 지운다(Orca 와 같다 — -d 라 병합 안 된 커밋이 있으면 git 이 거절 → 남기고 검토로).
      const preserved = await deleteBranchAfterRemoval(localGitRun(project.path), shortBranchOf(target.branch), target.head)
      return preserved ? { ok: true, preservedBranch: preserved } : { ok: true }
    },

    /** WS-21 남긴 브랜치를 강제로 지운다(Orca worktrees:forceDeletePreservedBranch). 그사이 움직였거나 체크아웃돼 있으면 거절. */
    async forceDeletePreservedBranch(repoId: unknown, branchName: unknown, head: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
      const project = typeof repoId === 'string' ? deps.store.get(repoId) : undefined
      if (!project || project.kind !== 'git' || typeof branchName !== 'string' || typeof head !== 'string') return { ok: false, message: String(repoId) }
      if (project.host) {
        const host = project.host
        return remoteTry(() => forceDeleteBranch(remoteGitRun(runOn(host), project.path), branchName, head), (message) => ({ ok: false as const, message }))
      }
      return forceDeleteBranch(localGitRun(project.path), branchName, head)
    },

    /** WS-19·20 프로젝트 설정 — 아라 밖 워크트리 보이기(출처별·하나씩)와 공유 경로. 모양을 걸러 받는다. 원격 프로젝트는 공유 경로를 안 받는다. */
    updateProject(repoId: unknown, updates: unknown): Project | null {
      const project = typeof repoId === 'string' ? deps.store.get(repoId) : undefined
      if (!project || !updates || typeof updates !== 'object') return null
      const u = updates as { externalVisibility?: unknown; shownExternalPaths?: unknown; sharedPaths?: unknown }
      const next: Pick<Project, 'externalVisibility' | 'shownExternalPaths' | 'sharedPaths'> = {}
      if ('externalVisibility' in u) {
        const raw = u.externalVisibility && typeof u.externalVisibility === 'object' ? (u.externalVisibility as Record<string, unknown>) : {}
        const v = Object.fromEntries(EXTERNAL_SOURCES.flatMap((k) => (raw[k] === 'show' || raw[k] === 'hide' ? [[k, raw[k]]] : [])))
        next.externalVisibility = Object.keys(v).length > 0 ? v : undefined
      }
      if ('shownExternalPaths' in u) {
        next.shownExternalPaths = Array.isArray(u.shownExternalPaths)
          ? u.shownExternalPaths.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 1000)
          : undefined
      }
      if ('sharedPaths' in u && !project.host) {
        const lines = Array.isArray(u.sharedPaths) ? u.sharedPaths.filter((x): x is string => typeof x === 'string').join('\n') : ''
        next.sharedPaths = parseWorktreeIncludeFile(lines).filter(isSafeIncludePath).slice(0, 100)
      }
      return deps.store.updateProject(project.id, next)
    },

    /** 사이드바 +/− · 상태바 "main 에서 n 커밋 앞". 목록에 있는 경로만(렌더러 값 불신). git 3번 — 행마다 부르므로 짧은 상한. */
    async worktreeStats(repoId: string, worktreePath: string): Promise<WorktreeStats> {
      const project = deps.store.get(repoId)
      // 원격은 +/− 를 안 잰다(행마다 SSH 3번 — 1차는 뺐다).
      if (!project || project.kind !== 'git' || project.host) return { ok: false }
      const listed = (await listWorktrees(project.path)) ?? []
      const target = listed.find((w) => same(w.path, worktreePath))
      const main = listed.find((w) => w.isMainWorktree)
      if (!target || !main?.branch) return { ok: false }
      const base = main.branch.replace(/^refs\/heads\//, '')
      const mb = await git(['merge-base', main.head, 'HEAD'], target.path)
      if (mb.code !== 0) return { ok: false }
      const fork = mb.stdout.trim()
      const [count, diff] = await Promise.all([git(['rev-list', '--count', `${fork}..HEAD`], target.path), git(['diff', '--shortstat', fork], target.path)])
      if (count.code !== 0 || diff.code !== 0) return { ok: false }
      return { ok: true, base, ahead: Number(count.stdout.trim()) || 0, ...parseShortstat(diff.stdout) }
    },

    async searchBaseRefs(repoId: string, query: string): Promise<BaseRef[]> {
      const project = deps.store.get(repoId)
      if (project?.host) {
        const host = project.host
        return remoteTry(() => remoteBaseRefs(runOn(host), project.path, typeof query === 'string' ? query : ''), () => [])
      }
      return project?.kind === 'git' ? listBaseRefs(project.path, typeof query === 'string' ? query : '') : []
    },

    // ── M10 WS-15 프로젝트 그룹(Orca projectGroups:*) — 렌더러 값은 모양을 보고 받는다 ──
    listGroups: (): ProjectGroup[] => deps.store.groups(),
    createGroup: (name: unknown): ProjectGroup | null => (typeof name === 'string' && name.trim() ? deps.store.createGroup(name.trim()) : null),
    updateGroup: (groupId: unknown, updates: unknown): ProjectGroup | null => {
      if (typeof groupId !== 'string' || !updates || typeof updates !== 'object') return null
      const u = updates as { name?: unknown; isCollapsed?: unknown }
      return deps.store.updateGroup(groupId, {
        ...(typeof u.name === 'string' ? { name: u.name } : {}),
        ...(typeof u.isCollapsed === 'boolean' ? { isCollapsed: u.isCollapsed } : {})
      })
    },
    deleteGroup: (groupId: unknown): boolean => typeof groupId === 'string' && deps.store.deleteGroup(groupId),
    moveProject: (projectId: unknown, groupId: unknown): Project | null =>
      typeof projectId === 'string' && (groupId === null || typeof groupId === 'string') ? deps.store.moveProject(projectId, groupId) : null,

    /** M10 WS-16 보관·잠든 탭. 아는 프로젝트의 작업 단위 id 만(렌더러 값 불신). 잠든 탭은 모양을 걸러 받는다. */
    updateMeta(worktreeId: unknown, updates: unknown): WorktreeMeta | null {
      if (typeof worktreeId !== 'string' || !updates || typeof updates !== 'object') return null
      if (!deps.store.get(worktreeId.split(WORKTREE_ID_SEPARATOR)[0])) return null
      const u = updates as { isArchived?: unknown; sleep?: unknown; comment?: unknown; workspaceStatus?: unknown }
      const next: WorktreeMeta = {}
      if ('isArchived' in u) next.isArchived = u.isArchived === true || undefined
      // R2 WS-18 체크포인트 — 빈 메모·null 상태는 지움.
      if ('comment' in u) next.comment = typeof u.comment === 'string' && u.comment.trim() ? u.comment.slice(0, WORKTREE_COMMENT_MAX) : undefined
      if ('workspaceStatus' in u) next.workspaceStatus = isWorkspaceStatus(u.workspaceStatus) ? u.workspaceStatus : undefined
      if ('sleep' in u) {
        next.sleep = Array.isArray(u.sleep)
          ? u.sleep.flatMap((x): SleepTab[] => {
              const r = x as { agent?: unknown; resume?: unknown } | null
              if (!r || !isAgentId(r.agent)) return []
              return [{ agent: r.agent, resume: typeof r.resume === 'string' && r.resume ? r.resume : null }]
            })
          : undefined
      }
      const { linkedPaths: _l, ...meta } = deps.store.updateMeta(worktreeId, next)
      return meta
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
