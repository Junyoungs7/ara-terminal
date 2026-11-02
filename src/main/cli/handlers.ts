// M14 R2 `ara` CLI — 요청별 일(Orca src/main/runtime/rpc 의 worktree·terminal·agent·status 몫, orcaRef ec112c6b01).
// 앱 기능을 새로 만들지 않는다 — 사이드바·탭이 쓰는 그 함수(워크트리 서비스·세션 관리자·에이전트 띄우기)를 그대로 부른다.
// electron 을 import 하지 않는다(시험이 가짜 의존으로 부른다).
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { isAgentId, type AgentId } from '@shared/agents'
import { areWorktreePathsEqual, isWorkspaceStatus, WORKTREE_ID_SEPARATOR, type Project, type Worktree, type WorktreeMetaUpdate } from '@shared/worktrees'
import type { Session } from '@shared/types'
import type { AgentLaunchResult } from '@shared/ipc'
import type { WorktreeService } from '../worktrees/service'
import { CliFail, type CliHandler } from './server'

export type CliDeps = {
  appVersion: string
  worktrees: Pick<WorktreeService, 'listProjects' | 'listWorktrees' | 'createWorktree' | 'updateMeta' | 'removeWorktree'>
  sessions: {
    snapshot(): Session[]
    has(id: string): boolean
    write(id: string, data: string): void
    peek(id: string): Uint8Array
    nextTitle(base: string): string
    create(spec: { type: 'local'; profileId: null; cwd: string; serverKey: string; title: string; manualTitle?: boolean }): Promise<string>
  }
  renderScreen(bytes: Uint8Array, cols: number, rows: number): Promise<string>
  /** 본창 렌더러에게 에이전트 탭을 띄워 달라고 한다(창이 없으면 실패 답). */
  launchAgent(req: { agent: AgentId; worktreeId: string; cwd: string; prompt?: string }): Promise<AgentLaunchResult>
  /** CLI 가 메타·목록을 바꿨다 — 렌더러 사이드바가 그 프로젝트를 다시 읽는다. */
  worktreesChanged(repoId: string): void
  platform?: NodeJS.Platform
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** 화면 글 상한(뒤쪽만 남긴다) — MCP session_read 와 같은 생각. */
const READ_MAX_CHARS = 64 * 1024

export function createCliHandlers(deps: CliDeps): Record<string, CliHandler> {
  const platform = deps.platform ?? process.platform
  const same = (a: string, b: string): boolean => areWorktreePathsEqual(a, b, platform)
  const inside = (dir: string, root: string): boolean => {
    const r = platform === 'win32' ? relative(root.toLowerCase(), dir.toLowerCase()) : relative(root, dir)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
  }

  async function allWorktrees(projects: Project[] = deps.worktrees.listProjects()): Promise<Worktree[]> {
    const out: Worktree[] = []
    for (const p of projects) {
      const r = await deps.worktrees.listWorktrees(p.id)
      if (r.ok) out.push(...r.worktrees)
    }
    return out
  }

  /** cwd 를 품은 가장 깊은 워크트리(Orca active/current). 원격 것은 이 PC 경로가 아니라 뺀다. */
  async function worktreeAt(cwd: string | undefined): Promise<Worktree | null> {
    if (!cwd) return null
    const local = deps.worktrees.listProjects().filter((p) => !p.host)
    const hits = (await allWorktrees(local)).filter((w) => inside(resolve(cwd), resolve(w.path)))
    return hits.sort((a, b) => b.path.length - a.path.length)[0] ?? null
  }

  /** Orca 선택자: id:<repoId>::<path> · path:<경로> · name:<이름> · branch:<브랜치> · active/current(cwd). 접두사 없으면 id → 경로 → 이름. */
  async function resolveWorktree(selector: unknown, cwd: unknown): Promise<Worktree> {
    const sel = str(selector) ?? 'active'
    if (sel === 'active' || sel === 'current') {
      const w = await worktreeAt(str(cwd))
      if (!w) throw new CliFail('selector_not_found', '지금 폴더는 아라가 아는 작업 단위 안이 아닙니다.', ['ara worktree list --json 으로 고른 뒤 --worktree id:<...> 를 주세요.'])
      return w
    }
    const all = await allWorktrees()
    const [kind, rest] = /^(id|path|name|branch):/.test(sel) ? [sel.slice(0, sel.indexOf(':')), sel.slice(sel.indexOf(':') + 1)] : ['', sel]
    const byId = (v: string) => all.filter((w) => w.id === v)
    const byPath = (v: string) => all.filter((w) => same(w.path, v))
    const byName = (v: string) => all.filter((w) => w.displayName === v)
    const byBranch = (v: string) => all.filter((w) => w.branch === v || w.branch === `refs/heads/${v}`)
    const hits =
      kind === 'id' ? byId(rest)
      : kind === 'path' ? byPath(rest)
      : kind === 'name' ? byName(rest)
      : kind === 'branch' ? byBranch(rest)
      : rest.includes(WORKTREE_ID_SEPARATOR) ? byId(rest)
      : isAbsolute(rest) ? byPath(rest)
      : byName(rest)
    if (hits.length === 1) return hits[0]
    if (hits.length === 0) throw new CliFail('selector_not_found', `작업 단위를 못 찾았습니다: ${sel}`, ['ara worktree list --json'])
    throw new CliFail('selector_ambiguous', `여러 작업 단위가 맞습니다: ${sel}`, hits.map((w) => `--worktree "id:${w.id}"`))
  }

  /** 프로젝트 선택자: id:/path:/name: 또는 접두사 없는 값. 없으면 cwd 를 품은 프로젝트. */
  async function resolveRepo(selector: unknown, cwd: unknown): Promise<Project> {
    const projects = deps.worktrees.listProjects()
    const sel = str(selector)
    if (!sel) {
      const w = await worktreeAt(str(cwd))
      const p = w ? projects.find((x) => x.id === w.repoId) : projects.find((x) => !x.host && str(cwd) && inside(resolve(String(cwd)), resolve(x.path)))
      if (!p) throw new CliFail('selector_not_found', '지금 폴더는 아라 프로젝트 안이 아닙니다.', ['ara repo list --json 으로 고른 뒤 --repo id:<...> 를 주세요.'])
      return p
    }
    const [kind, rest] = /^(id|path|name):/.test(sel) ? [sel.slice(0, sel.indexOf(':')), sel.slice(sel.indexOf(':') + 1)] : ['', sel]
    const hits = projects.filter((p) =>
      kind === 'id' ? p.id === rest : kind === 'path' ? same(p.path, rest) : kind === 'name' ? p.displayName === rest : p.id === rest || p.displayName === rest || same(p.path, rest)
    )
    if (hits.length === 1) return hits[0]
    if (hits.length === 0) throw new CliFail('selector_not_found', `프로젝트를 못 찾았습니다: ${sel}`, ['ara repo list --json'])
    throw new CliFail('selector_ambiguous', `여러 프로젝트가 맞습니다: ${sel}`, hits.map((p) => `--repo "id:${p.id}"`))
  }

  const terminalRow = (s: Session) => ({ id: s.id, title: s.title, space: s.space === 'ai' ? 'ai' : 'terminal', type: s.type, cwd: s.cwd ?? null })

  function resolveTerminal(id: unknown): Session {
    const sid = str(id)
    if (!sid) throw new CliFail('invalid_argument', '--terminal 이 없습니다(아라 에이전트 탭 안에서는 그 탭이 기본입니다).', ['ara terminal list --json'])
    const s = deps.sessions.snapshot().find((x) => x.id === sid)
    if (!s) throw new CliFail('terminal_not_found', `터미널을 못 찾았습니다: ${sid}`, ['ara terminal list --json'])
    return s
  }

  async function launch(agent: unknown, w: Worktree, prompt: unknown) {
    if (!isAgentId(agent)) throw new CliFail('invalid_argument', `--agent 는 claude·codex·gemini 중 하나입니다: ${String(agent)}`)
    const r = await deps.launchAgent({ agent, worktreeId: w.id, cwd: w.path, ...(str(prompt) ? { prompt: String(prompt) } : {}) })
    if (!r.ok) throw new CliFail('agent_launch_failed', r.error)
    return { terminal: r.sessionId, title: r.title }
  }

  return {
    'status.get': () => ({ app: { running: true, pid: process.pid, version: deps.appVersion } }),

    'repo.list': () => ({ repos: deps.worktrees.listProjects().map((p) => ({ id: p.id, displayName: p.displayName, path: p.path, kind: p.kind, ...(p.host ? { host: p.host } : {}) })) }),

    'worktree.list': async (p) => {
      if (str(p['repo'])) {
        const repo = await resolveRepo(p['repo'], p['cwd'])
        return { worktrees: await allWorktrees([repo]) }
      }
      return { worktrees: await allWorktrees() }
    },

    'worktree.show': async (p) => ({ worktree: await resolveWorktree(p['worktree'], p['cwd']) }),

    'worktree.create': async (p) => {
      const repo = await resolveRepo(p['repo'], p['cwd'])
      const name = str(p['name'])
      if (!name) throw new CliFail('invalid_argument', '--name 이 없습니다.')
      if (p['agent'] !== undefined && !isAgentId(p['agent'])) throw new CliFail('invalid_argument', `--agent 는 claude·codex·gemini 중 하나입니다: ${String(p['agent'])}`)
      // 진행·완료는 사이드바가 듣는 그 이벤트로 나간다(createWorktree:progress) — 화면에는 다른 창이 만든 것처럼 뜬다.
      const r = await deps.worktrees.createWorktree({ creationId: randomUUID(), repoId: repo.id, name, ...(str(p['baseBranch']) ? { baseBranch: String(p['baseBranch']) } : {}) })
      if (!r.ok) throw new CliFail(`worktree_${r.reason}`, r.message)
      const launched = p['agent'] !== undefined ? await launch(p['agent'], r.worktree, p['prompt']) : null
      return { worktree: r.worktree, ...(launched ? { launch: launched } : {}) }
    },

    // Orca `worktree set --comment --workspace-status` — M10 R2 WS-18 메모·카드 상태를 에이전트가 직접 쓴다.
    'worktree.set': async (p) => {
      const w = await resolveWorktree(p['worktree'], p['cwd'])
      const u: WorktreeMetaUpdate = {}
      if (p['comment'] !== undefined) u.comment = String(p['comment'])
      if (p['workspaceStatus'] !== undefined) {
        const v = p['workspaceStatus']
        if (v === null || v === 'null' || v === '') u.workspaceStatus = null
        else if (isWorkspaceStatus(v)) u.workspaceStatus = v
        else throw new CliFail('invalid_argument', `--workspace-status 는 todo·in-progress·in-review·completed·null 중 하나입니다: ${String(v)}`)
      }
      if (!Object.keys(u).length) throw new CliFail('invalid_argument', '바꿀 것이 없습니다(--comment 또는 --workspace-status).')
      const meta = deps.worktrees.updateMeta(w.id, u)
      if (!meta) throw new CliFail('selector_not_found', `작업 단위를 못 찾았습니다: ${w.id}`)
      deps.worktreesChanged(w.repoId)
      return { worktree: { ...w, comment: meta.comment, workspaceStatus: meta.workspaceStatus } }
    },

    'worktree.rm': async (p) => {
      // 지우기는 대상을 늘 적게 한다 — 빼먹은 --worktree 가 지금 폴더(active)를 지우지 않게.
      if (!str(p['worktree'])) throw new CliFail('invalid_argument', '지울 작업 단위를 --worktree 로 적어 주세요.', ['ara worktree list --json'])
      const w = await resolveWorktree(p['worktree'], p['cwd'])
      const r = await deps.worktrees.removeWorktree(w.repoId, w.path, p['force'] === true)
      if (!r.ok) throw new CliFail('worktree_remove_failed', r.message, p['force'] === true ? undefined : ['변경이 남아 있으면 --force'])
      deps.worktreesChanged(w.repoId)
      return { removed: w.id, ...(r.preservedBranch ? { preservedBranch: r.preservedBranch.branchName } : {}) }
    },

    'terminal.list': async (p) => {
      const rows = deps.sessions.snapshot()
      if (!str(p['worktree'])) return { terminals: rows.map(terminalRow) }
      const w = await resolveWorktree(p['worktree'], p['cwd'])
      return { terminals: rows.filter((s) => s.cwd && inside(resolve(s.cwd), resolve(w.path))).map(terminalRow) }
    },

    // Orca `terminal create` — 아라는 AI 작업 공간 탭이 에이전트 전용이라 터미널 공간에 그 폴더의 로컬 셸을 연다(탐색기 `아라` 와 같은 길).
    'terminal.create': async (p) => {
      const cwd = str(p['worktree']) ? (await resolveWorktree(p['worktree'], p['cwd'])).path : str(p['cwd'])
      if (!cwd) throw new CliFail('invalid_argument', '열 폴더가 없습니다(--worktree).')
      const title = str(p['title']) ?? deps.sessions.nextTitle('셸')
      const id = await deps.sessions.create({ type: 'local', profileId: null, cwd, serverKey: 'localhost', title, manualTitle: Boolean(str(p['title'])) })
      // ponytail: 명령은 셸이 프롬프트를 띄우기 전에 들어가도 셸이 줄을 받아 둔다(pty 입력 버퍼). 프롬프트를 기다려야 하는 셸이 나오면 그때 대기.
      if (str(p['command'])) deps.sessions.write(id, `${String(p['command'])}\r`)
      return { terminal: { id, title, cwd } }
    },

    'terminal.send': (p) => {
      const s = resolveTerminal(p['terminal'])
      const text = typeof p['text'] === 'string' ? p['text'] : ''
      if (!text && p['enter'] !== true) throw new CliFail('invalid_argument', '--text 또는 --enter 가 필요합니다.')
      deps.sessions.write(s.id, `${text}${p['enter'] === true ? '\r' : ''}`)
      return { sent: true, terminal: s.id }
    },

    'terminal.read': async (p) => {
      const s = resolveTerminal(p['terminal'])
      const text = await deps.renderScreen(deps.sessions.peek(s.id), s.cols ?? 80, s.rows ?? 24)
      return { terminal: s.id, text: text.length > READ_MAX_CHARS ? text.slice(-READ_MAX_CHARS) : text }
    },

    // Orca `agent launch` — 있는 작업 단위에 에이전트 탭(앱의 [+] 와 같은 길 — 렌더러가 띄운다).
    'agent.launch': async (p) => {
      const w = await resolveWorktree(p['worktree'], p['cwd'])
      return { worktree: w.id, launch: await launch(p['agent'], w, p['prompt']) }
    }
  }
}
