// p3-M21 셋업 가이드 진행 — Orca use-setup-guide-progress.ts 의 아라판. 이미 있는 값을 읽어 단계별 완료를 저절로 판정한다.
// 감지(기본 에이전트 설치)는 agentStore.detected — 첫 안내(AiOnboarding)·피커와 같은 값이다(따로 다시 감지하지 않는다).
// 사이드바 숨김은 Orca setupGuideSidebarDismissed(persisted UI)의 자리 — 아라 aiws 의 다른 기억처럼 localStorage.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAgentStore } from '../agentStore'
import { ensureAiwsLoaded, useAiwsStore } from '../store'
import { agentNotesEnabled } from '../../../store/notify'
import { setupGuideProgress, type SetupGuideProgress } from './steps'

const HIDDEN_KEY = 'aiws.setupGuide.hidden'
const hiddenSubs = new Set<() => void>()
const readHidden = (): boolean => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}
export function setSetupGuideHidden(on: boolean): void {
  try {
    if (on) localStorage.setItem(HIDDEN_KEY, '1')
    else localStorage.removeItem(HIDDEN_KEY)
  } catch {
    /* 저장 못 해도 이번 실행은 따른다 */
  }
  hiddenSubs.forEach((f) => f())
}
export const useSetupGuideHidden = (): boolean =>
  useSyncExternalStore(
    (f) => {
      hiddenSubs.add(f)
      return () => hiddenSubs.delete(f)
    },
    readHidden,
    () => false
  )

type Probes = { skill: boolean; tracker: boolean; oriel: boolean; setupScript: boolean }

/** 열린 동안 판정한다. 창으로 돌아오면(다른 곳에서 설치·연동했을 수 있다) 다시 묻는다(Orca focus·visibilitychange). */
export function useSetupGuideProgress(): SetupGuideProgress {
  const detected = useAgentStore((s) => s.detected)
  const settings = useAgentStore((s) => s.settings)
  const repos = useAiwsStore((s) => s.repos)
  const worktreesByRepo = useAiwsStore((s) => s.worktreesByRepo)
  const [probes, setProbes] = useState<Probes | null>(null)
  const [tick, setTick] = useState(0)
  const repoKey = repos.map((r) => r.id).join('|')

  useEffect(() => {
    void ensureAiwsLoaded()
    if (!useAgentStore.getState().detected) void useAgentStore.getState().loadAgents()
    const again = (): void => setTick((n) => n + 1)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') again()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', onVis)
    const offInt = window.ev.integrations.onUpdate(again)
    // [Oriel 설치]가 끝나면(main 이 이미 다시 감지했다) 판정을 다시.
    const offOriel = window.ev.oriel.onInstall((s) => s.phase === 'done' && again())
    return () => {
      offOriel()
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', onVis)
      offInt()
    }
  }, [])

  useEffect(() => {
    let alive = true
    const ids = repoKey ? repoKey.split('|') : []
    void Promise.all([
      window.ev.cli.skillStatus().then((s) => s.targets.some((x) => x.state !== 'missing'), () => false),
      window.ev.integrations.get().then((s) => s.gitlab.enabled && s.gitlab.hasToken, () => false),
      window.ev.oriel.status().then((s) => s.installed, () => false),
      // ponytail: 저장소마다 orca.yaml 을 읽는다(원격도) — 저장소가 수십 개가 되면 하나 찾을 때 멈추게 바꾼다.
      Promise.all(ids.map((id) => window.ev.repos.orcaYaml(id).then((y) => !!y.setup, () => false))).then((xs) => xs.some(Boolean))
    ]).then(([skill, tracker, oriel, setupScript]) => alive && setProbes({ skill, tracker, oriel, setupScript }))
    return () => {
      alive = false
    }
  }, [repoKey, tick])

  const agentNotes = agentNotesEnabled()
  return useMemo(() => {
    const extra = Object.values(worktreesByRepo)
      .flat()
      .filter((w) => !w.isMainWorktree && w.path).length
    const def = settings?.defaultAgent
    return setupGuideProgress(
      {
        defaultAgentInstalled: !!def && !!detected?.find((d) => d.id === def)?.installed,
        agentNotes,
        skillInstalled: probes?.skill ?? false,
        trackerConnected: probes?.tracker ?? false,
        hasSetupScript: probes?.setupScript ?? false,
        repoCount: repos.length,
        extraWorktreeCount: extra,
        orielInstalled: probes?.oriel ?? false
      },
      !!probes && !!detected && !!settings
    )
  }, [detected, settings, repos, worktreesByRepo, probes, agentNotes])
}
