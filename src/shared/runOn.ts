// M8 DM-04·05 실행 위치(Run on)·SSH 워크트리 — main·렌더러가 같이 쓰는 순수 규칙: 실행 위치 목록·판정, 원격 워크트리 경로, 원격 git 명령 글.
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/renderer/src/components/host-picker(호스트 고르기), src/main/ipc/worktree-logic.ts computeRemoteWorktreePath
// (SSH 호스트는 데스크톱 절대 경로를 못 쓰니 저장소 **형제** 자리 `<저장소>/../<저장소 이름>-<이름>`), docs/site/content/docs/recipes/remote-worktrees.mdx.
// 뺀 것: VM·서버(orca serve)·WSL 실행 위치, 호스트 목록 검색 상자(관리형 서버는 몇 대뿐 — select 로 충분), 저장소별 워크트리 위치 설정.
// node 모듈을 쓰지 않는다(렌더러도 읽는다) — 원격 경로는 늘 POSIX.
import type { AgentId, AgentSettings } from './agents'
import { hostKeyOf, type ManagedRecord, type ManagedState } from './managedServers'

/** 실행 위치 — 'local' 또는 관리형 서버의 hostKey(`user@host:port`). */
export type RunOnTarget = 'local' | string
export const RUN_ON_LOCAL = 'local'

/** Run on 목록의 서버 한 줄. consented = 관리형 서버 동의 기록이 있다(없으면 고를 때 동의 화면부터). */
export type RunOnHost = { hostKey: string; label: string; consented: boolean; state: ManagedState | null; version: string | null; note?: string }

/** 저장된 SSH 프로필 + 동의 기록 → 고를 수 있는 서버. 같은 hostKey 는 한 줄(먼저 나온 프로필 이름). 프로필이 지워진 동의 기록도 남긴다(제거할 길). */
export function runOnHosts(profiles: readonly { name: string; username: string; host: string; port: number }[], records: readonly ManagedRecord[]): RunOnHost[] {
  const out = new Map<string, RunOnHost>()
  const rec = (k: string): ManagedRecord | undefined => records.find((r) => r.hostKey === k)
  const row = (hostKey: string, label: string): RunOnHost => {
    const r = rec(hostKey)
    return { hostKey, label, consented: !!r, state: r?.state ?? null, version: r?.version ?? null, ...(r?.note ? { note: r.note } : {}) }
  }
  for (const p of profiles) {
    const k = hostKeyOf(p)
    if (!out.has(k)) out.set(k, row(k, p.name))
  }
  for (const r of records) if (!out.has(r.hostKey)) out.set(r.hostKey, row(r.hostKey, r.hostKey))
  return [...out.values()]
}

/** 고른 실행 위치로 무엇을 하나: 로컬 · 동의 화면부터 · 원격 준비(ensureReady) · 목록에 없는 서버. */
export type RunOnStep = 'local' | 'consent' | 'remote' | 'unknown'
export function runOnStep(target: RunOnTarget, hosts: readonly RunOnHost[]): RunOnStep {
  if (target === RUN_ON_LOCAL) return 'local'
  const h = hosts.find((x) => x.hostKey === target)
  if (!h) return 'unknown'
  return h.consented ? 'remote' : 'consent'
}

/** 그 실행 위치의 프로젝트만(로컬 = host 없는 것). */
export function projectsOn<T extends { host?: string }>(repos: readonly T[], target: RunOnTarget): T[] {
  return repos.filter((r) => (target === RUN_ON_LOCAL ? !r.host : r.host === target))
}

/**
 * 원격 에이전트 설정: '명령 바꾸기'가 Windows 경로(`C:\…\claude.cmd`)면 원격에서 못 찾는다 — 그 칸만 비워 기본 이름(PATH)으로.
 * `npx claude` 같은 POSIX 명령은 그대로 둔다.
 */
export function remoteAgentSettings(settings: AgentSettings, agent: AgentId): AgentSettings {
  const p = settings.agents[agent]
  if (!p.command || !/^[A-Za-z]:|\\/.test(p.command)) return settings
  return { ...settings, agents: { ...settings.agents, [agent]: { ...p, command: '' } } }
}

// ── 원격 명령 글 ── 모두 execSh(`sh -c '<글>'`)로 보낸다. 사용자 값(경로·브랜치·이름)은 반드시 shArg 로 감싼다.

/** POSIX 셸 한 인자(작은따옴표). */
export const shArg = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** 사람이 친 원격 경로 — `~` · `~/…` 만 홈으로 편다(따옴표 안에서는 셸이 안 펴 준다). 나머지는 글자 그대로. */
export function remotePathArg(p: string): string {
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"/${shArg(p.slice(2))}`
  return shArg(p)
}

/** 그 폴더에서 git 한 번. */
export function remoteGitScript(cwd: string, args: readonly string[]): string {
  return `cd -- ${remotePathArg(cwd)} && exec git ${args.map(shArg).join(' ')}`
}

/** 원격 경로 끝 슬래시 지우기(`/` 는 그대로). */
const trimSlash = (p: string): string => p.replace(/\/+$/, '') || '/'

/** Orca computeRemoteWorktreePath 의 기본 갈래 — 저장소 형제 자리 `<부모>/<저장소 이름>-<이름>`. */
export function remoteWorktreePath(repoPath: string, sanitizedName: string): string {
  const repo = trimSlash(repoPath)
  const cut = repo.lastIndexOf('/')
  const parent = cut <= 0 ? '' : repo.slice(0, cut)
  const name = repo.slice(cut + 1).replace(/\.git$/, '')
  return `${parent}/${name}-${sanitizedName}`
}

/** 후보 자리 비었나 — 브랜치(로컬·원격)와 폴더. 출력 줄 `branch=1`·`path=1`(없으면 빈 칸). */
export function remoteCandidateScript(repoPath: string, path: string, branch: string): string {
  const refs = ['for-each-ref', '--count=1', '--format=x', `refs/heads/${branch}`, `refs/remotes/*/${branch}`].map(shArg).join(' ')
  return `cd -- ${shArg(repoPath)} || exit 1; [ -n "$(git ${refs})" ] && echo branch=1; [ -e ${shArg(path)} ] && echo path=1; true`
}

/** 원격 경로 비교(끝 슬래시만 무시 — POSIX 는 대소문자를 가른다). */
export const sameRemotePath = (a: string, b: string): boolean => trimSlash(a) === trimSlash(b)

/** 원격 경로의 끝 이름(탭 제목). */
export const remoteBaseName = (p: string): string => trimSlash(p).split('/').pop() || p
