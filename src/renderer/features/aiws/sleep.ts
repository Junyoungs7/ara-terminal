// M10 WS-16 재우기·보관 — Orca sleep-worktree-flow.ts·worktrees:sleep(orcaRef fdfcfb3551)의 아라판.
//  재우기: 그 작업 단위의 에이전트 탭을 모두 끝내고(세션 종료) 목록엔 남긴다. 탭마다 CLI 세션 id 를 받아 두었다가
//          깨우면(줄을 고르거나 [깨우기]) 그 세션으로 다시 띄운다(Orca resumeSleptPane). id 를 모르는 탭은 못 되살린다 — 수를 알린다.
//  보관: 목록에서 숨긴다(Orca WorktreeMeta.isArchived). 살아 있는 탭이 있으면 먼저 재운다(숨은 채 돌지 않게). 보관함에서 [복원].
// 원격(M8) 작업 단위: 보관은 같다(메타만). 재우기는 막는다 — 세션 기록(transcript)이 서버에 있어 이 PC 가 세션 id 를 못 읽고,
// 그러면 깨울 때 되살릴 것이 없다. 살아 있는 원격 탭이 있는 작업 단위는 보관도 막는다(같은 이유).
import { hostOfWorktree, useAiwsStore } from './store'
import { useAgentStore } from './agentStore'
import type { SleepTab, Worktree } from '@shared/worktrees'

export type SleepRefusal = 'remote' | 'main' | 'failed'

const findWorktree = (id: string): Worktree | undefined =>
  Object.values(useAiwsStore.getState().worktreesByRepo)
    .flat()
    .find((w) => w.id === id)

// p3-M21 자동으로 잠든 탭(hibernation.ts)도 같은 재개 기록에 든다 — 세션은 끝났지만 재개 id 를 탭이 들고 있다.
const liveTabs = (id: string) => useAgentStore.getState().tabs.filter((x) => x.worktreeId === id && (!x.exited || x.slept))

/** 재운다. 막히면 사유. */
export async function sleepWorktree(id: string): Promise<SleepRefusal | null> {
  if (hostOfWorktree(id)) return 'remote'
  const live = liveTabs(id)
  // 닫기 전에 받는다 — 닫으면 main 이 그 탭의 transcript 경로를 잊는다.
  const awake = live.filter((x) => !x.slept)
  const ids = awake.length ? await window.ev.agents.resumeIds(awake.map((x) => x.sessionId)) : {}
  const sleep: SleepTab[] = live.map((x) => ({ agent: x.agent, resume: x.slept?.resume ?? ids[x.sessionId] ?? null }))
  if (!(await useAiwsStore.getState().updateWorktreeMeta(id, { sleep }))) return 'failed'
  const a = useAgentStore.getState()
  for (const x of a.tabs.filter((x) => x.worktreeId === id)) a.closeTab(x.sessionId)
  return null
}

/** 깨운다 — 잠든 탭을 그 세션으로 다시 띄운다. 돌려주는 값 = 못 되살린 탭 수(세션 id 를 몰랐거나 띄우기 실패). */
export async function wakeWorktree(id: string): Promise<number> {
  const w = findWorktree(id)
  if (!w?.sleep) return 0
  const tabs = w.sleep
  await useAiwsStore.getState().updateWorktreeMeta(id, { sleep: null })
  let missed = 0
  for (const s of tabs) {
    if (!s.resume) {
      missed += 1
      continue
    }
    const r = await useAgentStore.getState().launchAgent({ agent: s.agent, worktreeId: id, cwd: w.path, resume: s.resume })
    if (!r.ok) missed += 1
  }
  return missed
}

/** 보관 — 살아 있는 탭이 있으면 먼저 재운다. 본 작업 폴더는 보관하지 않는다(지우기와 같은 규칙). */
export async function archiveWorktree(id: string): Promise<SleepRefusal | null> {
  const w = findWorktree(id)
  if (!w || w.isMainWorktree) return 'main'
  if (liveTabs(id).length > 0) {
    const r = await sleepWorktree(id)
    if (r) return r
  }
  return (await useAiwsStore.getState().updateWorktreeMeta(id, { isArchived: true })) ? null : 'failed'
}

export async function restoreWorktree(id: string): Promise<boolean> {
  return (await useAiwsStore.getState().updateWorktreeMeta(id, { isArchived: false })) !== null
}
