// M7 R2 WS-12·13 소스 제어 — 순수 규칙(main 의 git 쓰기·렌더러 패널·단위 시험이 같이 읽는다).
// Orca shared/source-control-primary-action-decision.ts · shared/git-push-target-validation.ts(orcaRef fdfcfb3551)의 1차 판.
// 보호 브랜치·amend 경고는 Orca 에 없다 — 아라 결정(묶음 5·11: 푸시는 사용자가 누를 때만, 보호 브랜치 막기).

/** 늘 보호하는 브랜치. 저장소마다 `git config --add ara.protectedBranch <이름|접두어/*>` 로 더한다. */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master']
export const PROTECTED_BRANCH_CONFIG = 'ara.protectedBranch'

/** 오른쪽 아이콘 바 [소스 제어] → AI 작업 공간 청크(창 이벤트 — RightBar 는 진입 청크라 그 청크를 모른다). */
export const SCM_TOGGLE_EVENT = 'ara:scm-toggle'
/** 패널이 열렸나 — AI 작업 공간이 알리고 RightBar 가 눌림 표시를 맞춘다. detail = boolean. */
export const SCM_STATE_EVENT = 'ara:scm-state'

export type ScmUpstream = { hasUpstream: boolean; upstreamName?: string; ahead: number; behind: number }

/** 이름 또는 `접두어/*`. 대소문자 그대로(git 브랜치 이름은 대소문자를 가린다). */
export function isProtectedBranch(branch: string, extra: readonly string[] = []): boolean {
  return [...DEFAULT_PROTECTED_BRANCHES, ...extra].some((p) => (p.endsWith('/*') ? branch.startsWith(p.slice(0, -1)) : p === branch))
}

/** Orca isSafeGitRemoteName — 인자 주입(`-`)·경로 꼼수(`..`)를 막는다. */
export function isSafeRemoteName(remote: string): boolean {
  if (remote.length === 0 || remote.length > 100) return false
  return remote.split('/').every((s) => s !== '.' && s !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
}

export type PushConfirm = 'protected' | 'force'
/** 확인이 필요한 것 — 보호 브랜치 푸시 · 강제 푸시 · 이미 푸시된 커밋 amend. */
export type ScmConfirm = PushConfirm | 'pushed'
/** 쓰기 작업 결과. need 가 있으면 아무것도 안 했다 — 사용자가 확인하면 confirmed 에 넣어 다시 부른다. message = git 의 말(자격 증명만 가림). */
export type ScmResult = { ok: true; message?: string } | { ok: false; message: string; need?: ScmConfirm[]; target?: string }
export type PushPlan =
  | { kind: 'blocked'; reason: 'detached' | 'noRemote' | 'badTarget' | 'forceProtected' }
  /** need = 아직 사용자가 확인하지 않은 것 — 비어 있어야 푼다. */
  | { kind: 'push'; remote: string; branch: string; publish: boolean; force: boolean; need: PushConfirm[] }

/**
 * 푸시 대상 판정. 대상 = upstream 이 있으면 그 원격 브랜치, 없으면 첫 게시(remote 의 같은 이름 브랜치, --set-upstream).
 * 보호 브랜치는 **대상 이름**으로 본다(로컬 이름이 달라도 원격 main 으로 가면 막는다). 보호 브랜치 강제 푸시는 확인으로도 못 푼다.
 */
export function planPush(i: {
  branch: string | null
  upstreamName?: string
  remotes: readonly string[]
  force: boolean
  protectedExtra?: readonly string[]
  confirmed?: readonly PushConfirm[]
}): PushPlan {
  if (!i.branch) return { kind: 'blocked', reason: 'detached' }
  let remote: string
  let branch: string
  // upstreamName = "origin/feature/x" — 원격 이름은 아는 목록에서 가장 긴 앞부분으로(원격 이름에도 '/' 가 올 수 있다).
  const up = i.upstreamName ? [...i.remotes].sort((a, b) => b.length - a.length).find((r) => i.upstreamName!.startsWith(r + '/')) : undefined
  if (up) {
    remote = up
    branch = i.upstreamName!.slice(up.length + 1)
  } else {
    const r = i.remotes.includes('origin') ? 'origin' : i.remotes[0]
    if (!r) return { kind: 'blocked', reason: 'noRemote' }
    remote = r
    branch = i.branch
  }
  if (!isSafeRemoteName(remote) || !branch || branch.startsWith('-')) return { kind: 'blocked', reason: 'badTarget' }
  const prot = isProtectedBranch(branch, i.protectedExtra)
  if (prot && i.force) return { kind: 'blocked', reason: 'forceProtected' }
  const ok = new Set(i.confirmed ?? [])
  const need: PushConfirm[] = []
  if (prot && !ok.has('protected')) need.push('protected')
  if (i.force && !ok.has('force')) need.push('force')
  return { kind: 'push', remote, branch, publish: !up, force: i.force, need }
}

/** amend 경고 — 마지막 커밋이 이미 원격에 있으면 고치면 이력이 갈라진다(다음 푸시는 강제 푸시가 된다). */
export function amendNeedsConfirm(headOnRemote: boolean, confirmed: boolean): boolean {
  return headOnRemote && !confirmed
}

export type PrimaryKind = 'commit' | 'stage' | 'push' | 'pull' | 'sync' | 'publish'
export type PrimaryAction = { kind: PrimaryKind; disabled: boolean; titleKey: string; count?: number }

/**
 * Orca resolveSourceControlPrimaryActionDecision 의 1차 판 — 순서도 같다(진행 중 → 충돌 → 스테이지됨 → 스테이지할 것 → upstream).
 * 뺀 것: PR/MR 만들기(묶음 11 — 2차·기본 꺼짐), 강제 푸시 제안(patch-equivalent 판정), 연결된 리뷰 브랜치.
 */
export function resolvePrimaryAction(i: {
  stagedCount: number
  hasUnstaged: boolean
  hasMessage: boolean
  hasConflicts: boolean
  busy: boolean
  hasBranch: boolean
  upstream: ScmUpstream | null
}): PrimaryAction {
  if (i.busy) return { kind: 'commit', disabled: true, titleKey: 'scm.title.busy' }
  if (i.hasConflicts) return { kind: 'commit', disabled: true, titleKey: 'scm.title.conflicts' }
  if (i.stagedCount > 0) return { kind: 'commit', disabled: !i.hasMessage, titleKey: i.hasMessage ? 'scm.title.commit' : 'scm.title.needMessage' }
  if (i.hasUnstaged) return { kind: 'stage', disabled: false, titleKey: 'scm.title.stageAll' }
  const u = i.upstream
  if (!u) return { kind: 'commit', disabled: true, titleKey: 'scm.title.nothing' }
  if (!u.hasUpstream) return i.hasBranch ? { kind: 'publish', disabled: false, titleKey: 'scm.title.publish' } : { kind: 'publish', disabled: true, titleKey: 'scm.title.detached' }
  if (u.ahead > 0 && u.behind > 0) return { kind: 'sync', disabled: false, titleKey: 'scm.title.sync', count: u.ahead + u.behind }
  if (u.behind > 0) return { kind: 'pull', disabled: false, titleKey: 'scm.title.pull', count: u.behind }
  if (u.ahead > 0) return { kind: 'push', disabled: false, titleKey: 'scm.title.push', count: u.ahead }
  return { kind: 'commit', disabled: true, titleKey: 'scm.title.upToDate' }
}

/** git 이 돌려준 말을 그대로 보여 주되, URL 에 끼어 있을 수 있는 자격 증명(https://user:token@host)만 가린다. */
export function scrubCredentials(msg: string): string {
  return msg.replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
}
