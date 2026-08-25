import { execFile } from 'node:child_process'
import { branchFor, parseWorktreeOut, validWorktreeName, worktreePath, type WorktreeResult } from '@shared/gitWorktree'

/**
 * 로컬 세션 분리(#133) — `git worktree` 를 이 PC 에서 돌린다.
 *
 * **셸을 거치지 않는다.** `execFile` 로 인자를 배열째 넘기므로 인용이라는 개념 자체가 없다 —
 * 원격 쪽(remoteWorktreeAdd)이 문자열을 조립하며 인용을 신경 써야 하는 것과 대조적이다.
 * 그래도 이름은 **여기서 한 번 더** 검증한다: 렌더러가 보낸 값은 신뢰 경계 밖이다.
 */
const TIMEOUT_MS = 20_000

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim()
      const code = (err as { code?: unknown } | null)?.code
      resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, out })
    })
  })
}

/** 저장소인가. 아니면 왜 안 되는지 말해 줄 수 있어야 한다(§10.3 규칙 1 — 빈 메뉴 금지). */
export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], dir)
  return r.code === 0 && r.out.startsWith('true')
}

export async function addWorktree(parentPath: string, rawName: string): Promise<WorktreeResult> {
  const name = validWorktreeName(rawName)
  if (name === null) return { ok: false, reason: 'git', message: '이름에 쓸 수 없는 글자가 있습니다.' }
  if (!(await isGitRepo(parentPath))) return { ok: false, reason: 'notRepo', message: parentPath }
  const dest = worktreePath(parentPath, name, process.platform === 'win32' ? '\\' : '/')
  const r = await git(['worktree', 'add', '-b', branchFor(name), dest], parentPath)
  // 성공 판정을 종료코드로 한다 — 로컬은 우리가 심은 표식이 필요 없다(셸을 안 거친다).
  return r.code === 0 ? { ok: true, path: dest } : { ok: false, reason: 'git', message: r.out }
}

/**
 * 지운다. **`--force` 없이** 부른다 — 커밋 안 된 변경이 있으면 git 이 거절하고, 그 거절을
 * 그대로 올린다(§10.3 규칙 5). 대신 밀어붙이면 사용자의 작업이 조용히 사라진다.
 */
export async function removeWorktree(parentPath: string, dest: string): Promise<WorktreeResult> {
  const r = await git(['worktree', 'remove', dest], parentPath)
  return r.code === 0 ? { ok: true, path: dest } : { ok: false, reason: 'git', message: r.out }
}

/** 원격 결과 파서를 로컬에서도 쓸 일이 있을까 봐 다시 내보낸다(호출측이 한 곳만 보게). */
export { parseWorktreeOut }
