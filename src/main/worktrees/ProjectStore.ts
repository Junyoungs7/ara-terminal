// M2 프로젝트 저장 — userData/projects.json(workspace.json 과 따로). 쓰기는 atomicJson(.bak 롤백) — 아라 저장 방식.
// 프로젝트 목록과 **생성 중 기록**(재시작 정리용 — shared/worktrees.ts PendingCreation)을 함께 둔다.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import type { PendingCreation, Project, ProjectKind } from '@shared/worktrees'

type ProjectsFile = { schemaVersion: 1; projects: Project[]; pending: PendingCreation[] }

export class ProjectStore {
  private data: ProjectsFile

  constructor(private readonly path: string) {
    cleanupTemp(path)
    const raw = readJsonWithBackup<Partial<ProjectsFile> | null>(path, null)
    this.data = {
      schemaVersion: 1,
      projects: Array.isArray(raw?.projects) ? raw.projects : [],
      pending: Array.isArray(raw?.pending) ? raw.pending : []
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
  add(path: string, kind: ProjectKind, samePath: (a: string, b: string) => boolean): Project {
    const existing = this.data.projects.find((p) => samePath(p.path, path))
    if (existing) return existing
    const project: Project = { id: randomUUID(), path, displayName: basename(path) || path, kind, addedAt: Date.now() }
    this.data.projects.push(project)
    this.flush()
    return project
  }

  /** 목록에서만 뺀다 — 디스크의 저장소·워크트리는 건드리지 않는다(Orca repos:remove 와 같다). */
  remove(id: string): boolean {
    const before = this.data.projects.length
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.projects.length === before) return false
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
}
