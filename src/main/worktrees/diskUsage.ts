// 3차 WS-26 작업 단위 디스크 사용량 — Orca src/main/workspace-space-local-scan.ts·shared/workspace-space-entry-traversal.ts(@ec112c6b01, MIT)의 아라판.
// lstat 로 걷고 **링크는 따라가지 않는다**(링크 자체 크기만) — 공유 경로(node_modules 접합점)를 두 번 세거나 본 폴더로 넘어가지 않게.
// 맨 위 항목별 크기를 같이 내 무엇이 무거운지 보인다(Orca compactWorkspaceSpaceItems 의 큰 것 몇 개). du 빠른 길·취소 토큰은 뺐다 —
// utility process(diskUsageWorker.ts)에서 돌고, 항목 상한을 넘으면 truncated 로 멈춘다.
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiskUsage } from '@shared/worktrees'

/** 한 작업 단위에서 셀 항목 상한. ponytail: 고정 50만, 모노레포에서 모자라면 설정으로. */
export const DISK_SCAN_MAX_ENTRIES = 500_000
const CONCURRENCY = 32
const TOP_N = 5

export async function scanDiskUsage(root: string, maxEntries = DISK_SCAN_MAX_ENTRIES): Promise<DiskUsage> {
  const rootSt = await lstat(root).catch(() => null)
  if (!rootSt?.isDirectory()) return { path: root, ok: false, bytes: 0, entries: 0, truncated: false, top: [] }
  let entries = 0
  let truncated = false
  /** 폴더 하나의 크기(재귀). 같이 도는 수를 묶는다 — 큰 트리에서 파일 핸들이 바닥나지 않게. */
  let active = 0
  const waiters: (() => void)[] = []
  const slot = async <T,>(job: () => Promise<T>): Promise<T> => {
    if (active >= CONCURRENCY) await new Promise<void>((r) => waiters.push(r))
    active += 1
    try {
      return await job()
    } finally {
      active -= 1
      waiters.shift()?.()
    }
  }
  const sizeOf = async (path: string): Promise<number> => {
    if (truncated) return 0
    entries += 1
    if (entries > maxEntries) {
      truncated = true
      return 0
    }
    const st = await slot(() => lstat(path)).catch(() => null)
    if (!st) return 0
    if (st.isSymbolicLink() || !st.isDirectory()) return st.size
    const names: string[] = []
    try {
      const d = await slot(() => opendir(path))
      for await (const e of d) names.push(e.name)
    } catch {
      return 0
    }
    const sizes = await Promise.all(names.map((n) => sizeOf(join(path, n))))
    return sizes.reduce((a, b) => a + b, 0)
  }
  const names: string[] = []
  try {
    for await (const e of await opendir(root)) names.push(e.name)
  } catch {
    return { path: root, ok: false, bytes: 0, entries: 0, truncated: false, top: [] }
  }
  const top = await Promise.all(names.map(async (name) => ({ name, bytes: await sizeOf(join(root, name)) })))
  top.sort((a, b) => b.bytes - a.bytes)
  return { path: root, ok: true, bytes: top.reduce((a, b) => a + b.bytes, 0), entries: Math.min(entries, maxEntries), truncated, top: top.slice(0, TOP_N) }
}
