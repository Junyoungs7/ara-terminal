// M2 프로젝트 저장 — userData/projects.json(workspace.json 과 따로). 쓰기는 atomicJson(.bak 롤백) — 아라 저장 방식.
// 프로젝트 목록과 **생성 중 기록**(재시작 정리용 — shared/worktrees.ts PendingCreation)을 함께 둔다.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import type { PendingCreation, Project, ProjectGroup, ProjectKind, WorktreeMeta } from '@shared/worktrees'

// M10: groups(WS-15 프로젝트 그룹) · meta(WS-16 보관·잠듦 — 작업 단위 id 별). 옛 파일엔 없다 → 빈 값.
type ProjectsFile = { schemaVersion: 1; projects: Project[]; pending: PendingCreation[]; groups: ProjectGroup[]; meta: Record<string, WorktreeMeta> }

export class ProjectStore {
  private data: ProjectsFile

  constructor(private readonly path: string) {
    cleanupTemp(path)
    const raw = readJsonWithBackup<Partial<ProjectsFile> | null>(path, null)
    this.data = {
      schemaVersion: 1,
      projects: Array.isArray(raw?.projects) ? raw.projects : [],
      pending: Array.isArray(raw?.pending) ? raw.pending : [],
      groups: Array.isArray(raw?.groups) ? raw.groups : [],
      meta: raw?.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}
    }
  }

  private flush(): void {
    writeJsonAtomic(this.path, this.data)
  }

  list(): Project[] {
    return this.data.projects
  }

  get(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id)
  }

  /** 같은 경로를 두 번 넣으면 있던 것을 돌려준다(Orca repos:add 와 같다). */
  add(path: string, kind: ProjectKind, samePath: (a: string, b: string) => boolean, host?: string): Project {
    // M8 DM-04: 원격 저장소는 (서버, 경로) 짝이 같아야 같은 것. 이름에 서버를 붙여 사이드바에서 로컬과 가른다.
    const existing = this.data.projects.find((p) => p.host === host && samePath(p.path, path))
    if (existing) return existing
    const name = host ? `${path.replace(/\/+$/, '').split('/').pop() || path} @ ${host.replace(/:22$/, '')}` : basename(path) || path
    const project: Project = { id: randomUUID(), path, displayName: name, kind, addedAt: Date.now(), ...(host ? { host } : {}) }
    this.data.projects.push(project)
    this.flush()
    return project
  }

  /** 목록에서만 뺀다 — 디스크의 저장소·워크트리는 건드리지 않는다(Orca repos:remove 와 같다). */
  remove(id: string): boolean {
    const before = this.data.projects.length
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.projects.length === before) return false
    // 그 프로젝트 작업 단위들의 메타도 같이(id = `${repoId}::${path}`).
    for (const k of Object.keys(this.data.meta)) if (k.startsWith(id + '::')) delete this.data.meta[k]
    this.flush()
    return true
  }

  pending(): PendingCreation[] {
    return this.data.pending
  }

  beginPending(p: PendingCreation): void {
    this.data.pending.push(p)
    this.flush()
  }

  endPending(creationId: string): void {
    this.data.pending = this.data.pending.filter((p) => p.creationId !== creationId)
    this.flush()
  }

  // ── M10 WS-14 지운 자동 이름 ──
  retireName(projectId: string, name: string): void {
    const p = this.get(projectId)
    if (!p || p.retiredNames?.includes(name)) return
    p.retiredNames = [...(p.retiredNames ?? []), name]
    this.flush()
  }

  // ── M10 WS-15 프로젝트 그룹(Orca projectGroups:*) ──
  groups(): ProjectGroup[] {
    return this.data.groups
  }

  createGroup(name: string): ProjectGroup {
    const group: ProjectGroup = { id: randomUUID(), name, isCollapsed: false, createdAt: Date.now() }
    this.data.groups.push(group)
    this.flush()
    return group
  }

  updateGroup(id: string, updates: { name?: string; isCollapsed?: boolean }): ProjectGroup | null {
    const g = this.data.groups.find((x) => x.id === id)
    if (!g) return null
    if (typeof updates.name === 'string' && updates.name.trim()) g.name = updates.name.trim()
    if (typeof updates.isCollapsed === 'boolean') g.isCollapsed = updates.isCollapsed
    this.flush()
    return g
  }

  /** 그룹만 지운다 — 안의 프로젝트는 그룹 밖으로(Orca 기본: 담긴 프로젝트는 지우지 않음). */
  deleteGroup(id: string): boolean {
    const before = this.data.groups.length
    this.data.groups = this.data.groups.filter((g) => g.id !== id)
    if (this.data.groups.length === before) return false
    for (const p of this.data.projects) if (p.groupId === id) delete p.groupId
    this.flush()
    return true
  }

  /** groupId = null 이면 그룹에서 뺀다. 없는 그룹이면 null. */
  moveProject(projectId: string, groupId: string | null): Project | null {
    const p = this.get(projectId)
    if (!p || (groupId !== null && !this.data.groups.some((g) => g.id === groupId))) return null
    if (groupId === null) delete p.groupId
    else p.groupId = groupId
    this.flush()
    return p
  }

  // ── M10 WS-16 작업 단위 메타(보관·잠듦) ──
  meta(worktreeId: string): WorktreeMeta | undefined {
    return this.data.meta[worktreeId]
  }

  /** undefined 인 칸은 지운다. 남은 게 없으면 항목째. */
  updateMeta(worktreeId: string, updates: WorktreeMeta): WorktreeMeta {
    const next: WorktreeMeta = { ...this.data.meta[worktreeId], ...updates }
    if (!next.isArchived) delete next.isArchived
    if (!next.sleep) delete next.sleep
    if (Object.keys(next).length === 0) delete this.data.meta[worktreeId]
    else this.data.meta[worktreeId] = next
    this.flush()
    return next
  }

  forgetMeta(worktreeId: string): void {
    if (!(worktreeId in this.data.meta)) return
    delete this.data.meta[worktreeId]
    this.flush()
  }
}
