/**
 * 세션 분리(#133) — **같은 저장소를 다른 폴더에 다른 브랜치로 하나 더 펼친다.**
 *
 * 에이전트 둘을 같은 폴더에서 돌리면 서로의 파일을 덮어쓴다. git 은 이 문제를 이미 풀어 뒀다
 * (`git worktree`). 폴더를 복사하는 것과 다르다 — **git 이 아는 방식**이라 브랜치·머지가 그대로
 * 성립한다(복사본은 그게 안 된다).
 *
 * ```
 * ~/work/vgt-erp          (원래 · main)
 * ~/work/vgt-erp-refactor (분리 A · ara/refactor)   ← worktree
 * ~/work/vgt-erp-perf     (분리 B · ara/perf)       ← worktree
 * ```
 *
 * **이 파일은 문자열만 만든다.** 실행은 로컬(main/git.ts)이든 원격(remoteCatalog)이든 각자 하고,
 * 여기서 만든 것 말고는 아무것도 실행하지 않는다 — 이름이 곧 셸에 들어가는 값이라 검증이
 * 이 파일의 존재 이유다(설계 §10.3 규칙 6 "인자 검증은 기존 규칙 그대로").
 */

/**
 * 분리 이름으로 쓸 수 있는가. **영문·숫자·`-`·`_` 만**, 1~40자.
 *
 * 좁게 잡은 이유가 둘이다: ① 이 값이 폴더 이름과 브랜치 이름에 **동시에** 들어간다(둘의 허용
 * 문자가 다르고, 교집합만 쓰는 것이 안전하다) ② 셸 메타문자·공백·경로 구분자가 하나라도 통과하면
 * `git worktree add` 한 줄이 임의 실행이 된다. 한글을 막는 것은 아쉽지만 브랜치 이름으로 쓰기에
 * 문제가 잦다(원격 저장소·CI 가 깨지는 일이 흔하다).
 */
export function validWorktreeName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s) ? s : null
}

/** 만들어질 브랜치. `ara/` 접두어를 붙여 **우리가 만든 것**을 한눈에 가른다. */
export function branchFor(name: string): string {
  return `ara/${name}`
}

/**
 * 만들어질 폴더 — **형제 자리**다(`<원래폴더>-<이름>`). 숨김 폴더에 감추지 않는다:
 * 사용자가 탐색기로 열어 볼 수 있어야 하고, 나중에 손으로 지울 수도 있어야 한다(§10.3 규칙 2).
 */
export function worktreePath(parentPath: string, name: string, sep: '/' | '\\'): string {
  const trimmed = parentPath.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const dir = cut >= 0 ? trimmed.slice(0, cut) : ''
  const base = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  return dir === '' ? `${base}-${name}` : `${dir}${sep}${base}-${name}`
}

/** posix 셸 인용(원격 전용). 로컬은 execFile 로 인자 배열을 주므로 인용이 필요 없다. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 원격에서 돌릴 한 줄. **저장소인지 먼저 보고**(§10.3 규칙 1) 아니면 그 사실을 말한다 —
 * 빈 메뉴나 알 수 없는 실패로 두지 않는다.
 */
export function remoteWorktreeAdd(parentPath: string, name: string): string | null {
  const n = validWorktreeName(name)
  if (n === null || parentPath === '') return null
  const dest = worktreePath(parentPath, n, '/')
  // `rev-parse` 로 저장소를 확인하고, 아니면 우리가 아는 말로 알린다. `&&` 로 이어 두면
  // 실패 이유가 git 의 영어 오류로만 남는다.
  return (
    `cd ${q(parentPath)} 2>/dev/null || { echo 'ARA-WT no-such-dir'; exit 1; }; ` +
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo 'ARA-WT not-a-repo'; exit 1; }; ` +
    `git worktree add -b ${q(branchFor(n))} ${q(dest)} 2>&1 && echo "ARA-WT ok ${dest}"`
  )
}

/**
 * 지우는 한 줄. **`--force` 를 쓰지 않는다** — 커밋 안 된 변경이 있으면 git 이 거절하고,
 * 그 거절을 사용자에게 그대로 전한다(§10.3 규칙 5). 우리가 대신 밀어붙이지 않는다.
 */
export function remoteWorktreeRemove(parentPath: string, dest: string): string | null {
  if (parentPath === '' || dest === '') return null
  return `cd ${q(parentPath)} 2>/dev/null && git worktree remove ${q(dest)} 2>&1 && echo 'ARA-WT ok'`
}

/** 원격 응답 → 화면이 쓸 결과. 우리가 심은 표식만 믿는다(git 문구는 판마다 바뀐다). */
export type WorktreeResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'noDir' | 'notRepo' | 'git'; message: string }

export function parseWorktreeOut(out: string): WorktreeResult {
  const text = out.trim()
  if (text.includes('ARA-WT no-such-dir')) return { ok: false, reason: 'noDir', message: text }
  if (text.includes('ARA-WT not-a-repo')) return { ok: false, reason: 'notRepo', message: text }
  const ok = /ARA-WT ok(?: (.+))?$/m.exec(text)
  if (ok) return { ok: true, path: (ok[1] ?? '').trim() }
  // git 이 실패했다 — 그 말을 그대로 올린다(커밋 안 된 변경·이미 있는 브랜치 등).
  return { ok: false, reason: 'git', message: text }
}
