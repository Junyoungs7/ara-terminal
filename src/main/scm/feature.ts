// M7 R2 WS-12·13 소스 제어 — 기능 틀(docs/feature-module.md)의 main 등록 함수. git 쓰기 IPC 는 전부 여기서 건다.
// root = 워크트리 폴더(절대 경로), paths = 그 기준 '/' 경로(M7 R1 git:status 의 entry.path 그대로). 렌더러 값은 다시 거른다.
// M8 R5: host 가 있으면 원격 작업 단위 — 같은 함수(푸시 안전장치 WS-13 포함)를 SSH exec 로(work/backend). 원격 git 의 자격 증명은 그 서버의 것.
import { isAbsolute } from 'node:path'
import { handle } from '../ipc/handle'
import { workBackend } from '../work/backend'
import type { PushConfirm } from '@shared/scm'
import { abortOperation, amend, commit, discardPath, pull, push, safeRelPaths, stagePaths, unstagePaths } from './git'

const bad = { ok: false as const, message: 'bad request' }
const okRoot = (root: unknown): root is string => typeof root === 'string' && isAbsolute(root)
const CONFIRMS: readonly PushConfirm[] = ['protected', 'force']

export function registerScmFeature(): void {
  const x = (host: unknown) => workBackend(host).exec
  handle('scm:stage', ({ root, paths, host }) => {
    const p = safeRelPaths(paths)
    return okRoot(root) && p ? stagePaths(root, p, x(host)) : bad
  })
  handle('scm:unstage', ({ root, paths, host }) => {
    const p = safeRelPaths(paths)
    return okRoot(root) && p ? unstagePaths(root, p, x(host)) : bad
  })
  handle('scm:discard', ({ root, path, host }) => {
    const p = safeRelPaths([path])
    return okRoot(root) && p ? discardPath(root, p[0], x(host)) : bad
  })
  handle('scm:commit', ({ root, message, host }) => (okRoot(root) && typeof message === 'string' ? commit(root, message, x(host)) : bad))
  handle('scm:amend', ({ root, message, confirmed, host }) => (okRoot(root) && typeof message === 'string' ? amend(root, message, confirmed === true, x(host)) : bad))
  handle('scm:push', ({ root, force, confirmed, host }) =>
    okRoot(root) ? push(root, force === true, Array.isArray(confirmed) ? CONFIRMS.filter((c) => confirmed.includes(c)) : [], x(host)) : bad
  )
  handle('scm:pull', ({ root, merge, host }) => (okRoot(root) ? pull(root, merge === true, x(host)) : bad))
  // M12 R2 — op 는 셋 중 하나만(git 인자로 그대로 들어간다).
  handle('scm:abort', ({ root, op, host }) => (okRoot(root) && (op === 'merge' || op === 'rebase' || op === 'cherry-pick') ? abortOperation(root, op, x(host)) : bad))
}
