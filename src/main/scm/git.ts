// M7 R2 WS-12·13 소스 제어 — git **쓰기**(stage·unstage·버리기·커밋·amend·푸시·풀). 조회는 M7 R1 의 main/git/inspect.ts.
// Orca src/main/git/source-control/staging.ts·discard-changes.ts·commit-changes.ts · git/remote.ts(gitPush·gitPull)
// · git/push-target-validation.ts(orcaRef fdfcfb3551)의 1차 판. 전부 runProcess(셸 없음·인자 배열·시간 상한).
// 뺀 것: drive-checkout 재쓰기·WSL·작업 잠금·읽기 캐시 무효화(캐시가 없다)·포크 push target·서브모듈 오류 풀이.
// 인증: 사내 GitLab HTTPS 는 git 의 자격 증명 관리자에 맡긴다 — 앱은 비밀번호를 받지 않고, 터미널 프롬프트는 끈다(멈춤 방지).
import { runProcess, type RunResult } from '../util/runProcess'
import type { Exec } from '../work/backend'
import { PROTECTED_BRANCH_CONFIG, amendNeedsConfirm, planPush, scrubCredentials, type PushConfirm, type ScmResult } from '@shared/scm'

const SHORT_MS = 30_000
/** 원격 작업 — 자격 증명 관리자 창이 사람을 기다릴 수 있다. */
const REMOTE_MS = 5 * 60_000
const MAX_BUFFER = 16 * 1024 * 1024

// M8 R5 — 함수마다 끝 인자 x(Exec, 기본 로컬 runProcess). 원격 작업 단위는 work/backend 가 SSH exec 를 넘긴다 — 규칙(푸시 안전장치 포함)은 하나.
function git(root: string, args: string[], timeoutMs = SHORT_MS, x: Exec = runProcess): Promise<RunResult> {
  // --literal-pathspecs: 파일 이름의 * ? [ 를 패턴으로 읽지 않는다(Orca literalPathspec).
  return x('git', ['--literal-pathspecs', ...args], { cwd: root, timeoutMs, maxBuffer: MAX_BUFFER, env: { GIT_TERMINAL_PROMPT: '0' } })
}

const fail = (r: RunResult, fallback: string): Extract<ScmResult, { ok: false }> => ({
  ok: false,
  message: scrubCredentials((r.stderr.trim() || r.stdout.trim() || r.error?.message || fallback).trim())
})
const done = (r: RunResult, fallback: string): ScmResult => (r.code === 0 ? { ok: true, message: scrubCredentials(r.stderr.trim() || r.stdout.trim()) || undefined } : fail(r, fallback))

/** 워크트리 기준 '/' 경로만 — 절대 경로·`..`·옵션처럼 보이는 것은 거른다. */
export function safeRelPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0) return null
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.startsWith('-') || /^([a-zA-Z]:)?[\\/]/.test(p) || p.split(/[\\/]/).includes('..')) return null
  }
  return paths as string[]
}

/** -A: 지운 파일도 스테이지(Orca stageFile 의 add 와 같은 결과 + 삭제). */
export const stagePaths = async (root: string, paths: string[], x: Exec = runProcess): Promise<ScmResult> => done(await git(root, ['add', '-A', '--', ...paths], SHORT_MS, x), 'stage failed')

/** reset 은 첫 커밋 전(HEAD 없음)에도 된다 — restore --staged 는 거기서 실패한다. */
export const unstagePaths = async (root: string, paths: string[], x: Exec = runProcess): Promise<ScmResult> => done(await git(root, ['reset', '-q', '--', ...paths], SHORT_MS, x), 'unstage failed')

/** Orca discardChanges — 추적 중이면 작업 폴더만 인덱스로 되돌리고, 안 추적이면 지운다(git clean). */
export async function discardPath(root: string, path: string, x: Exec = runProcess): Promise<ScmResult> {
  const tracked = (await git(root, ['ls-files', '--error-unmatch', '--', path], SHORT_MS, x)).code === 0
  return tracked ? done(await git(root, ['restore', '--worktree', '--', path], SHORT_MS, x), 'discard failed') : done(await git(root, ['clean', '-f', '-q', '--', path], SHORT_MS, x), 'discard failed')
}

export async function commit(root: string, message: string, x: Exec = runProcess): Promise<ScmResult> {
  if (!message.trim()) return { ok: false, message: 'emptyMessage' }
  return done(await git(root, ['commit', '-m', message], SHORT_MS, x), 'commit failed')
}

/** HEAD 가 어느 원격 추적 브랜치에라도 들어 있나 = 이미 푸시됨. */
export async function headOnRemote(root: string, x: Exec = runProcess): Promise<boolean> {
  const r = await git(root, ['branch', '-r', '--contains', 'HEAD'], SHORT_MS, x)
  return r.code === 0 && r.stdout.trim() !== ''
}

/** 마지막 커밋 고치기 — 스테이지된 것을 더하고, 메시지가 비면 그대로(--no-edit). 이미 푸시된 커밋이면 확인 전엔 안 한다. */
export async function amend(root: string, message: string, confirmed: boolean, x: Exec = runProcess): Promise<ScmResult> {
  if (amendNeedsConfirm(await headOnRemote(root, x), confirmed)) return { ok: false, message: 'pushed', need: ['pushed'] }
  return done(await git(root, ['commit', '--amend', ...(message.trim() ? ['-m', message] : ['--no-edit'])], SHORT_MS, x), 'amend failed')
}

const out = async (root: string, args: string[], x: Exec): Promise<string> => {
  const r = await git(root, args, SHORT_MS, x)
  return r.code === 0 ? r.stdout.trim() : ''
}

/** 푸시 — 대상 판정(@shared/scm planPush) → 브랜치 이름 검사(Orca validateGitPushTarget) → git push. */
export async function push(root: string, force: boolean, confirmed: readonly PushConfirm[], x: Exec = runProcess): Promise<ScmResult> {
  const plan = planPush({
    branch: (await out(root, ['symbolic-ref', '--short', '-q', 'HEAD'], x)) || null,
    upstreamName: (await out(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], x)) || undefined,
    remotes: (await out(root, ['remote'], x)).split(/\r?\n/).filter(Boolean),
    force,
    protectedExtra: (await out(root, ['config', '--get-all', PROTECTED_BRANCH_CONFIG], x)).split(/\r?\n/).filter(Boolean),
    confirmed
  })
  if (plan.kind === 'blocked') return { ok: false, message: plan.reason }
  const target = `${plan.remote}/${plan.branch}`
  if (plan.need.length) return { ok: false, message: 'confirm', need: plan.need, target }
  const ref = await git(root, ['check-ref-format', '--branch', plan.branch], SHORT_MS, x)
  if (ref.code !== 0) return { ok: false, message: 'badTarget', target }
  const r = await git(
    root,
    ['push', ...(plan.force ? ['--force-with-lease'] : []), ...(plan.publish ? ['--set-upstream'] : []), plan.remote, `HEAD:refs/heads/${plan.branch}`],
    REMOTE_MS,
    x
  )
  return r.code === 0 ? { ok: true, message: target } : { ...fail(r, 'push failed'), target }
}

/** M12 R2 — 진행 중인 병합·리베이스·체리픽 중단(Orca git-conflict-operation abortMerge·abortRebase + cherry-pick 같은 꼴). 작업 폴더가 그 작업 전으로 돌아간다. */
export const abortOperation = async (root: string, op: 'merge' | 'rebase' | 'cherry-pick', x: Exec = runProcess): Promise<ScmResult> =>
  done(await git(root, [op, '--abort'], SHORT_MS, x), `${op} --abort failed`)

/** 풀 — pull 은 빨리 감기만, sync 는 갈라졌으면 병합(Orca runPullWithDivergenceFallback 의 병합 폴백). 푸시는 렌더러가 push 로 따로(같은 안전장치). */
export const pull = async (root: string, merge: boolean, x: Exec = runProcess): Promise<ScmResult> => done(await git(root, ['pull', merge ? '--no-rebase' : '--ff-only'], REMOTE_MS, x), 'pull failed')
