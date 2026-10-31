// 출처: stablyai/orca src/main/ipc/worktree-include-copy-budget.ts@7a7f46f8a3 (MIT)
// .worktreeinclude 복사 상한 — 복사 전에 재고(fs.cp 는 중간에 못 멈춘다) 한 예산을 모든 항목이 나눠 쓴다.
// 뺀 것: APFS 클론(bytesAreCopied·chargeBytes) — macOS 전용 경로. 경고 문장 포맷터(formatWorktreeIncludeCopyWarning).
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type WorktreeCopyBudget = { maxBytes: number; maxEntries: number }

// 저장소가 적은 목록 하나로 node_modules 같은 큰 트리를 통째로 복사해 생성이 멈추지 않게 — 바이트와 파일 수 둘 다.
export const DEFAULT_WORKTREE_COPY_BUDGET: WorktreeCopyBudget = { maxBytes: 2 * 1024 * 1024 * 1024, maxEntries: 50_000 }

// 거절된 큰 트리를 재느라 뒤의 작은 항목이 굶지 않게 걷기 예산은 따로(파일 수의 5배).
const WORKTREE_COPY_SIZING_HEADROOM = 5

/** sizing = 이 항목 탓이 아니라 앞 항목들이 재는 예산을 다 썼다. */
export type WorktreeCopyBudgetExceededReason = 'bytes' | 'entries' | 'sizing'

export type WorktreeCopySizeVerdict =
  | { withinBudget: true; bytes: number; entries: number }
  | { withinBudget: false; reason: WorktreeCopyBudgetExceededReason }

async function measureCopySize(
  source: string,
  remainingBytes: number,
  remainingEntries: number,
  remainingWalk: number
): Promise<{ verdict: WorktreeCopySizeVerdict; walked: number }> {
  let bytes = 0
  let entries = 0
  const pending: string[] = [source]
  while (pending.length > 0) {
    const current = pending.pop() as string
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(current)
    } catch {
      continue // 그사이 사라졌다 — 복사도 건너뛴다
    }
    entries += 1
    if (entries > Math.min(remainingEntries, remainingWalk)) {
      const reason = remainingWalk < remainingEntries ? 'sizing' : 'entries'
      return { verdict: { withinBudget: false, reason }, walked: entries }
    }
    // 링크는 따라가지 않는다(복사도 링크 그대로 — 두 번 세거나 돌지 않게).
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      try {
        for (const name of await readdir(current)) pending.push(join(current, name))
      } catch {
        // 못 읽는 폴더 — 잴 것이 없고 복사가 실패로 알린다
      }
      continue
    }
    bytes += stats.size
    if (bytes > remainingBytes) return { verdict: { withinBudget: false, reason: 'bytes' }, walked: entries }
  }
  return { verdict: { withinBudget: true, bytes, entries }, walked: entries }
}

/** admit 은 차례로 await 한다 — 남은 예산으로 재고, 들어오면 그만큼 쓴다. 거절된 것은 예산을 안 쓴다(걷기 예산만). */
export function createWorktreeCopyBudgetTracker(budget: WorktreeCopyBudget = DEFAULT_WORKTREE_COPY_BUDGET): {
  admit: (source: string) => Promise<WorktreeCopySizeVerdict>
} {
  let remainingBytes = budget.maxBytes
  let remainingEntries = budget.maxEntries
  let remainingWalk = budget.maxEntries * WORKTREE_COPY_SIZING_HEADROOM
  return {
    admit: async (source) => {
      if (remainingWalk <= 0) return { withinBudget: false, reason: 'sizing' }
      const { verdict, walked } = await measureCopySize(source, remainingBytes, remainingEntries, remainingWalk)
      remainingWalk -= walked
      if (verdict.withinBudget) {
        remainingBytes -= verdict.bytes
        remainingEntries -= verdict.entries
      }
      return verdict
    }
  }
}
