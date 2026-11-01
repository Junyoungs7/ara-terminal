// M11 R2 앱 재시작·업데이트 후 에이전트 복원(Orca: 데몬에 살아 있으면 다시 붙고, 데몬째 죽었으면 — PC 재부팅 등 — 패인에 남긴 세션으로 재개).
// 출처: stablyai/orca @fdfcfb3551 (MIT) src/main/ipc/pty/host-env/saved-resume-admission.ts admitColdRestoreReattach 의 판정 — 핵심만.
// 아라판: 띄운 로컬 에이전트 탭을 userData/agent-tabs.json 에 적어 두고(끝나면 지움), 켤 때 살아 있지 않은 것을 가른다.
//   · 데몬을 찾았는데 그 세션이 없다 = 앱이 꺼진 사이 끝났다 → 되살리지 않는다(1차 M4 규칙 그대로).
//   · 데몬을 못 찾았다(데몬째 죽음) 또는 앱 안 PTY 로 떴던 탭 = 잃었다 → 같은 에이전트·같은 폴더로 재개(CLI 세션 id 를 알면 --resume).
import { isAgentId, type AgentId } from '@shared/agents'

export type AgentTabRecord = { agent: AgentId; cwd: string; title: string; line: string; startedAt: number; local?: true }

export function readTabRecords(v: unknown): Map<string, AgentTabRecord> {
  const out = new Map<string, AgentTabRecord>()
  if (!v || typeof v !== 'object') return out
  for (const [id, r] of Object.entries(v as Record<string, unknown>)) {
    const x = r as Partial<AgentTabRecord> | null
    if (!x || !isAgentId(x.agent) || typeof x.cwd !== 'string' || typeof x.title !== 'string') continue
    out.set(id, { agent: x.agent, cwd: x.cwd, title: x.title, line: typeof x.line === 'string' ? x.line : '', startedAt: typeof x.startedAt === 'number' ? x.startedAt : 0, ...(x.local === true ? { local: true as const } : {}) })
  }
  return out
}

/** 켤 때 한 번: 되살릴 것(cold)과 버릴 것(drop). 살아 있는 세션의 기록은 그대로 둔다. 기록 순서 = 띄운 순서. */
export function pickColdTabs(records: ReadonlyMap<string, AgentTabRecord>, alive: (id: string) => boolean, daemonFound: boolean): { cold: [string, AgentTabRecord][]; drop: string[] } {
  const cold: [string, AgentTabRecord][] = []
  const drop: string[] = []
  for (const [id, r] of records) {
    if (alive(id)) continue
    if (daemonFound && !r.local) drop.push(id)
    else cold.push([id, r])
  }
  return { cold, drop }
}
