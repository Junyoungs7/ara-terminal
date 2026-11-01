// FD-01 자원 관리자 — 기능 틀(docs/feature-module.md)의 main 등록 함수. Orca src/main/memory/collector.ts
// (orcaRef 7a7f46f8a3)를 따라: 앱 프로세스는 Electron getAppMetrics, PTY 는 호스트 프로세스 표에서 셸 트리 합산.
// 수집은 렌더러가 물을 때만 한다(팝오버가 열린 동안 2초마다) — 상시 폴러가 없다.
import { app } from 'electron'
import { handle } from '../ipc/handle'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import { createHostProcs } from './hostProcs'
import { aggregatePtys, appKind, snapshotOf, type AgentLimits, type AppProc, type ResourceSnapshot } from '@shared/resources'

const hostProcesses = createHostProcs()

function appProcs(): AppProc[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    kind: appKind(m.type),
    name: m.name ?? m.serviceName,
    cpu: m.cpu.percentCPUUsage,
    memory: m.memory.workingSetSize * 1024
  }))
}

export type ResourcesService = {
  snapshot(): Promise<ResourceSnapshot>
}

/** agentLimits: 에이전트 상한(설정 › 에이전트 — 적용은 로컬 데몬이 한다). 팝오버가 보여 주기만 한다. */
export function registerResourcesFeature(sessions: MainSessionManager, agentLimits: () => AgentLimits): ResourcesService {
  let inflight: Promise<ResourceSnapshot> | null = null
  const service: ResourcesService = {
    // 창 두 개가 같이 물어도 한 번만 잰다(Orca collectMemorySnapshot 의 inflight 와 같은 이유).
    snapshot() {
      inflight ??= hostProcesses()
        .then((rows) => {
          const app = appProcs()
          const appPids = new Set(app.map((a) => a.pid))
          // 앱 프로세스는 Electron 값으로 이미 셌다 — PTY 트리 합산에서 겹치지 않게 뺀다.
          return snapshotOf(app, aggregatePtys(rows.filter((r) => !appPids.has(r.pid)), sessions.ptyList()), Date.now(), agentLimits())
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    }
  }
  handle('resources:snapshot', () => service.snapshot())
  // 안전 종료 = 탭 닫기와 같은 길(sessions.destroy → 화면에 session:closed 가 간다). 렌더러가 보낸 id 는 목록에서 확인한다.
  handle('resources:killPty', ({ id }) => {
    if (!sessions.ptyList().some((p) => p.id === id)) return { ok: false }
    sessions.destroy(id)
    return { ok: true }
  })
  return service
}
