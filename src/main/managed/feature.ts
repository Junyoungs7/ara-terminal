// M8 DM-02·03 관리형 서버 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 동의·설치·업데이트·제거 IPC 를 여기서 건다.
// 동의 기록은 userData/managed-servers.json(호스트별). 기록이 있다 = 그 호스트에 동의했다. 철회 = 제거(검증해서 흔적 0 일 때만 기록을 지운다).
// 연결은 새로 만들지 않는다 — 그 호스트로 열려 있는 SSH 세션의 ssh2 Client 를 빌린다(sftp·remote 콘솔과 같은 규칙). 연결 계층은 호출만.
// 터미널 공간은 여기를 부르지 않는다 — 설치는 사람이 설정 › 관리형 서버에서 [설치]를 눌렀을 때만.
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Client } from 'ssh2'
import { handle } from '../ipc/handle'
import { mainErrorLogPath } from '../log/MainErrorLog'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { ProfileStore } from '../secrets/ProfileStore'
import { consentPlan, decideUpdate, hostKeyOf, type ManagedRecord, type ManagedState } from '@shared/managedServers'
import type { ManagedListResult, ManagedRemoveResult } from '@shared/ipc'
import { TOKEN_BYTES, installHost, probeHost, uninstallHost } from './host'
import { ORCAD_PY } from './orcadScript'
import { createRemoteAgents, type RemoteAgents } from './remoteAgents'

export function registerManagedFeature(deps: {
  userData: string
  sessions: () => MainSessionManager
  profiles: Pick<ProfileStore, 'get'>
  appVersion: string
}): { remote: RemoteAgents; ensureReady(hostKey: string): Promise<ManagedRecord> } {
  const file = join(deps.userData, 'managed-servers.json')
  const log = (m: string): void => {
    try {
      appendFileSync(join(dirname(mainErrorLogPath()), 'managed-servers.log'), `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* 무시 */
    }
  }
  cleanupTemp(file)
  const raw = readJsonWithBackup<{ hosts?: unknown } | null>(file, null)
  let records: ManagedRecord[] = Array.isArray(raw?.hosts) ? (raw.hosts as ManagedRecord[]).filter((r) => r && typeof r.hostKey === 'string' && typeof r.consentedAt === 'string') : []
  const save = (): void => writeJsonAtomic(file, { hosts: records })
  const now = (): string => new Date().toISOString()
  const put = (hostKey: string, patch: Partial<ManagedRecord> & { state: ManagedState }): ManagedRecord => {
    const prev = records.find((r) => r.hostKey === hostKey)
    const next: ManagedRecord = { hostKey, consentedAt: prev?.consentedAt ?? now(), version: prev?.version ?? null, checkedAt: now(), ...patch }
    if (!patch.note) delete next.note
    records = [...records.filter((r) => r.hostKey !== hostKey), next]
    save()
    return next
  }

  /** 지금 열린 SSH 세션들의 호스트(설치 고르기 목록). 같은 호스트에 탭이 여럿이면 하나. */
  const targets = (): { hostKey: string; label: string; sessionId: string }[] => {
    const seen = new Map<string, { hostKey: string; label: string; sessionId: string }>()
    for (const s of deps.sessions().snapshot()) {
      if (s.type !== 'ssh' || !s.profileId) continue
      const p = deps.profiles.get(s.profileId)
      if (!p || p.type !== 'ssh' || !deps.sessions().sshClient(s.id)) continue
      const hostKey = hostKeyOf(p)
      if (!seen.has(hostKey)) seen.set(hostKey, { hostKey, label: p.name, sessionId: s.id })
    }
    return [...seen.values()]
  }
  const clientFor = (hostKey: string): Client => {
    const t = targets().find((x) => x.hostKey === hostKey)
    const c = t ? deps.sessions().sshClient(t.sessionId) : null
    if (!c) throw new Error('이 서버로 열린 SSH 연결이 없습니다. 먼저 접속하세요.')
    return c
  }

  const remote = createRemoteAgents({
    adopt: (backend, info, hostKey) => {
      const title = typeof info.meta['title'] === 'string' ? info.meta['title'] : 'agent'
      deps.sessions().adopt(backend, { type: 'ssh', title, serverKey: hostKey, cwd: info.cwd, profileId: null, space: 'ai', cols: info.cols, rows: info.rows }, info.id)
    },
    log
  })

  /** 동의한 호스트 확인 + 판이 다르면 동의 범위 안에서 교체(돌고 있는 에이전트가 있으면 미룸). 동의가 없으면 아무것도 깔지 않는다. */
  const ensureReady = async (hostKey: string): Promise<ManagedRecord> => {
    if (!records.some((r) => r.hostKey === hostKey)) throw new Error('이 서버에는 설치 동의가 없습니다.')
    const client = clientFor(hostKey)
    try {
      const probe = await probeHost(client)
      const live = probe.installed ? await remote.liveSessions(hostKey, client).catch(() => 0) : 0
      const d = decideUpdate({ installed: probe.installed, app: deps.appVersion, liveSessions: live })
      // 세는 데 연 다리 — 세션이 없으면 닫는다(데몬이 혼자 남아 상주하지 않게: 연결도 세션도 없으면 스스로 끝난다).
      if (live === 0) remote.detach(hostKey)
      if (d === 'current' || d === 'keepNewer') return put(hostKey, { state: 'installed', version: probe.installed })
      if (d === 'defer') return put(hostKey, { state: 'deferred', version: probe.installed, note: `에이전트 ${live}개가 돌고 있어 업데이트를 미뤘습니다.` })
      // install(사용자가 손으로 지움 — 동의는 남아 있다) · update: 옛 데몬은 세션이 없으니 다리를 닫으면 스스로 내려간다.
      remote.detach(hostKey)
      await installHost(client, deps.appVersion)
      return put(hostKey, { state: 'installed', version: deps.appVersion })
    } catch (e) {
      return put(hostKey, { state: 'failed', note: e instanceof Error ? e.message : String(e) })
    }
  }

  handle('managed:list', (): ManagedListResult => ({ records, targets: targets().map(({ hostKey, label }) => ({ hostKey, label })) }))
  handle('managed:plan', async ({ hostKey }) => {
    try {
      const probe = await probeHost(clientFor(hostKey))
      return consentPlan(hostKey, probe, Buffer.byteLength(ORCAD_PY), TOKEN_BYTES * 2, Buffer.byteLength(deps.appVersion))
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  // [설치] = 동의. 기록을 먼저 남긴다(설치가 중간에 실패해도 무엇에 동의했는지 남고, 목록에서 [제거]로 치울 수 있다).
  handle('managed:install', async ({ hostKey }) => {
    put(hostKey, { state: 'missing' })
    return ensureReady(hostKey)
  })
  handle('managed:check', ({ hostKey }) => ensureReady(hostKey))
  // 철회 = 제거. 원격에서 지우고 남은 것을 잰다 — 0 일 때만 기록을 지운다(남았으면 목록에 남겨 다시 [제거]할 수 있게).
  handle('managed:remove', async ({ hostKey }): Promise<ManagedRemoveResult> => {
    try {
      const client = clientFor(hostKey)
      remote.detach(hostKey)
      const remnants = await uninstallHost(client)
      if (remnants.length) {
        put(hostKey, { state: 'failed', note: `남은 것: ${remnants.join(', ')}` })
        return { ok: false, remnants }
      }
      records = records.filter((r) => r.hostKey !== hostKey)
      save()
      log(`orcad ${hostKey} removed — nothing left`)
      return { ok: true, remnants: [] }
    } catch (e) {
      return { ok: false, remnants: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  return { remote, ensureReady }
}
