// M7 R2 WS-12·13 소스 제어 — 기능 틀(docs/feature-module.md)의 main 등록 함수. git 쓰기 IPC 는 전부 여기서 건다.
// root = 워크트리 폴더(절대 경로), paths = 그 기준 '/' 경로(M7 R1 git:status 의 entry.path 그대로). 렌더러 값은 다시 거른다.
import { isAbsolute } from 'node:path'
import { handle } from '../ipc/handle'
import type { PushConfirm } from '@shared/scm'
import { amend, commit, discardPath, pull, push, safeRelPaths, stagePaths, unstagePaths } from './git'

const bad = { ok: false as const, message: 'bad request' }
const okRoot = (root: unknown): root is string => typeof root === 'string' && isAbsolute(root)
const CONFIRMS: readonly PushConfirm[] = ['protected', 'force']

export function registerScmFeature(): void {
  handle('scm:stage', ({ root, paths }) => {
    const p = safeRelPaths(paths)
    return okRoot(root) && p ? stagePaths(root, p) : bad
  })
  handle('scm:unstage', ({ root, paths }) => {
    const p = safeRelPaths(paths)
    return okRoot(root) && p ? unstagePaths(root, p) : bad
  })
  handle('scm:discard', ({ root, path }) => {
    const p = safeRelPaths([path])
    return okRoot(root) && p ? discardPath(root, p[0]) : bad
  })
  handle('scm:commit', ({ root, message }) => (okRoot(root) && typeof message === 'string' ? commit(root, message) : bad))
  handle('scm:amend', ({ root, message, confirmed }) => (okRoot(root) && typeof message === 'string' ? amend(root, message, confirmed === true) : bad))
  handle('scm:push', ({ root, force, confirmed }) =>
    okRoot(root) ? push(root, force === true, Array.isArray(confirmed) ? CONFIRMS.filter((c) => confirmed.includes(c)) : []) : bad
  )
  handle('scm:pull', ({ root, merge }) => (okRoot(root) ? pull(root, merge === true) : bad))
}
