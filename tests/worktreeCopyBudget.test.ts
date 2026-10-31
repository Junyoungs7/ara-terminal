// M2 라운드 2 — .worktreeinclude 복사 상한(Orca worktree-include-copy-budget.test.ts 에서 옮김 — 작은 예산으로 거절을 본다).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorktreeCopyBudgetTracker, DEFAULT_WORKTREE_COPY_BUDGET } from '../src/main/worktrees/copyBudget'
import { copyIncludePaths } from '../src/main/worktrees/git'

const TINY_BYTE_BUDGET = { maxBytes: 64, maxEntries: 10_000 }
const TINY_ENTRY_BUDGET = { maxBytes: 1024 * 1024 * 1024, maxEntries: 3 }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ara-copy-budget-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('worktree copy budget', () => {
  it('Orca 기본값 — 2GB · 5만 개', () => {
    expect(DEFAULT_WORKTREE_COPY_BUDGET).toEqual({ maxBytes: 2 * 1024 * 1024 * 1024, maxEntries: 50_000 })
  })

  it('맞는 것은 들이고 잰 크기를 알린다', async () => {
    writeFileSync(join(root, 'small.env'), 'A=1\n')
    await expect(createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET).admit(join(root, 'small.env'))).resolves.toEqual({ withinBudget: true, bytes: 4, entries: 1 })
  })

  it('바이트를 넘는 폴더는 거절', async () => {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'a'), 'x'.repeat(40))
    writeFileSync(join(root, 'node_modules', 'b'), 'x'.repeat(40))
    await expect(createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET).admit(join(root, 'node_modules'))).resolves.toEqual({ withinBudget: false, reason: 'bytes' })
  })

  it('가벼워도 파일 수가 넘으면 거절', async () => {
    mkdirSync(join(root, 'cache'))
    for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(root, 'cache', n), '')
    await expect(createWorktreeCopyBudgetTracker(TINY_ENTRY_BUDGET).admit(join(root, 'cache'))).resolves.toEqual({ withinBudget: false, reason: 'entries' })
  })

  it('예산 하나를 모든 항목이 나눠 쓴다', async () => {
    writeFileSync(join(root, 'first'), 'x'.repeat(40))
    writeFileSync(join(root, 'second'), 'x'.repeat(40))
    const tracker = createWorktreeCopyBudgetTracker(TINY_BYTE_BUDGET)
    await expect(tracker.admit(join(root, 'first'))).resolves.toMatchObject({ withinBudget: true })
    await expect(tracker.admit(join(root, 'second'))).resolves.toEqual({ withinBudget: false, reason: 'bytes' })
  })

  it('copyIncludePaths — 넘는 항목은 복사하지 않고 사유를 붙여 돌려준다', async () => {
    const src = join(root, 'src')
    const dst = join(root, 'dst')
    mkdirSync(join(src, 'big'), { recursive: true })
    mkdirSync(dst)
    writeFileSync(join(src, '.env'), 'A=1\n')
    writeFileSync(join(src, 'big', 'blob'), 'x'.repeat(100))
    const skipped = await copyIncludePaths(src, dst, ['.env', 'big'], TINY_BYTE_BUDGET)
    expect(skipped).toEqual(['big (bytes)'])
    expect(existsSync(join(dst, '.env'))).toBe(true)
    expect(existsSync(join(dst, 'big'))).toBe(false)
  })
})
