// M8 DM-02·03 관리형 서버 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 동의·설치·업데이트·제거 IPC 를 여기서 건다.
// 동의 기록은 userData/managed-servers.json(호스트별). 기록이 있다 = 그 호스트에 동의했다. 철회 = 제거(검증해서 흔적 0 일 때만 기록을 지운다).
// 연결: M8 R3 부터 저장된 SSH 프로필로 **셸 없이** 따로 붙는다(connectSshClient — 터미널 탭 없이 AI 공간만으로). 그 연결이 안 되면(비밀번호를
// 저장 안 함 등) 그 호스트로 열린 터미널 세션의 Client 를 빌린다(R1 방식). 원격 에이전트 다리는 자기 연결 위에 있어 터미널 탭을 닫아도 안 끊긴다.
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
import type { SshProfile } from '@shared/types'
import { runOnHosts } from '@shared/runOn'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'
import { connectSshClient, holdClient, type ConnectFailure } from '../sessions/ssh/SshBackend'
import { removeRemoteFiles, uploadPasteImage, type PasteResult } from '../sessions/ssh/pasteImage'
import { hopCredentialsFrom } from '../ipc/registerSshIpc'
import type { DaemonCreateSpec, DaemonSessionInfo } from '../daemon/protocol'
import { TOKEN_BYTES, execSh, installHost, probeHost, uninstallHost } from './host'
import type { RemoteRun } from './remoteWorktrees'
import { ORCAD_PY } from './orcadScript'
import { createRemoteAgents, type RemoteAgents } from './remoteAgents'
import { setRemoteClients } from '../work/backend'

export function registerManagedFeature(deps: {
  userData: string
  sessions: () => MainSessionManager
  profiles: ProfileStore
  knownHosts: Pick<WorkspaceStore, 'getKnownHosts' | 'addKnownHost'>
  appVersion: string
  /** M8 R4: 데몬 판을 바꿨을 때 알림 센터에 한 줄(묻지 않는 교체 — 동의 범위 안). */
  updated?: (e: { hostKey: string; from: string; to: string }) => void
}): ManagedFeature {
  const file = join(deps.userData, 'managed-servers.json')
  const log = (m: string): void => {
    try {
      appendFileSync(join(dirname(mainErrorLogPath()), 'managed-servers.log'), `${new Date().toISOString()} ${m}\n`)
    } catch {
      /* 무시 */
    }
  }
  cleanupTemp(file)
  const raw = readJsonWithBackup<{ hosts?: unknown; tabs?: unknown; kills?: unknown } | null>(file, null)
  let records: ManagedRecord[] = Array.isArray(raw?.hosts) ? (raw.hosts as ManagedRecord[]).filter((r) => r && typeof r.hostKey === 'string' && typeof r.consentedAt === 'string') : []
  // M8 R4 앱을 다시 켰을 때 되살릴 원격 탭(Orca: 원격 PTY 바인딩을 로컬에 남겨 두고 다시 켜면 '끊김' 칸 → 사람이 다시 붙기). 서버에 묻지 않고 이것으로 그린다.
  let tabs: SavedTab[] = Array.isArray(raw?.tabs) ? (raw.tabs as SavedTab[]).filter((x) => x && typeof x.hostKey === 'string' && typeof x.info?.id === 'string') : []
  // 끊긴 채 닫은 탭 — 서버에 닿지 못해 못 끝낸 것. 다음에 그 서버에 붙을 때 끝낸다(Orca SshPendingPtyKill).
  let kills: { hostKey: string; id: string }[] = Array.isArray(raw?.kills) ? (raw.kills as { hostKey: string; id: string }[]).filter((x) => x && typeof x.hostKey === 'string' && typeof x.id === 'string') : []
  const save = (): void => writeJsonAtomic(file, { hosts: records, tabs, kills })
  const dropTab = (id: string): void => {
    if (!tabs.some((x) => x.info.id === id)) return
    tabs = tabs.filter((x) => x.info.id !== id)
    save()
  }
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
  // ── 셸 없는 자기 연결(호스트마다 하나). 끊기면 지운다 — 다음에 부를 때 새로 붙는다(자동 재접속 없음). ──
  const own = new Map<string, Client>()
  const dialing = new Map<string, Promise<Client>>()
  const profileOf = (hostKey: string): SshProfile | undefined => deps.profiles.list().find((p): p is SshProfile => p.type === 'ssh' && hostKeyOf(p) === hostKey)
  const dialOwn = async (hostKey: string): Promise<Client> => {
    const p = profileOf(hostKey)
    if (!p) throw new Error('이 서버의 SSH 프로필이 없습니다.')
    const lookup = deps.profiles.lookupSecret(p)
    if (!lookup.ok) throw new Error('저장된 비밀번호가 없습니다 — 터미널에서 이 서버에 접속한 뒤 다시 해 보세요.')
    const r = await connectSshClient(p, {
      knownHosts: deps.knownHosts.getKnownHosts(),
      secret: lookup.secret,
      // 지문은 여기서 묻지 않는다(묻는 화면은 터미널 접속에 있다) — 처음 보는 서버는 사유만.
      acceptHostKey: false,
      onHostKeyAccepted: (id, host) => deps.knownHosts.addKnownHost(id, host),
      hopCredentials: hopCredentialsFrom(deps.profiles)
    })
    if (!r.ok) throw new Error(failText(r))
    const c = r.client
    own.set(hostKey, c)
    const drop = (): void => void (own.get(hostKey) === c && own.delete(hostKey))
    c.on('close', drop)
    c.on('error', drop)
    log(`ssh ${hostKey} connected (no shell)`)
    return c
  }
  const clientFor = async (hostKey: string): Promise<Client> => {
    const have = own.get(hostKey)
    if (have) return have
    let p = dialing.get(hostKey)
    if (!p) {
      p = dialOwn(hostKey).finally(() => dialing.delete(hostKey))
      dialing.set(hostKey, p)
    }
    try {
      return await p
    } catch (e) {
      // 자기 연결이 안 되면 열린 터미널 세션의 연결을 빌린다(R1 방식 — 한 번만 친 비밀번호로 접속한 경우).
      // R4: 빌린 연결은 이 호스트의 연결이 된다 — 그 터미널 탭을 닫아도 셸만 닫히고 연결은 남아 원격 에이전트 탭이 안 끊긴다(Orca: 연결은 대상의 것).
      const t = targets().find((x) => x.hostKey === hostKey)
      const c = t ? deps.sessions().sshClient(t.sessionId) : null
      if (!t || !c) throw e
      holdClient(c)
      own.set(hostKey, c)
      const drop = (): void => void (own.get(hostKey) === c && own.delete(hostKey))
      c.on('close', drop)
      c.on('error', drop)
      log(`ssh ${hostKey} borrowed from terminal ${t.sessionId} (kept open when that tab closes)`)
      return c
    }
  }
  // M8 R5 원격 작업 단위의 파일·검색·git(work/backend)도 이 호스트 연결을 쓴다(동의와 무관 — 워크트리처럼 SSH 만).
  setRemoteClients(clientFor)

  const remote = createRemoteAgents({
    adopt: (backend, info, hostKey) => {
      const title = typeof info.meta['title'] === 'string' ? info.meta['title'] : 'agent'
      deps.sessions().adopt(backend, { type: 'ssh', title, serverKey: hostKey, cwd: info.cwd, profileId: null, space: 'ai', cols: info.cols, rows: info.rows }, info.id)
      tabs = [...tabs.filter((x) => x.info.id !== info.id), { hostKey, info: { id: info.id, pid: info.pid, cwd: info.cwd, cols: info.cols, rows: info.rows, meta: info.meta } }]
      save()
    },
    gone: (id, hostKey) => {
      dropTab(id)
      // 이 탭에 붙여 넣은 이미지를 치운다(못 치운 것은 다음 붙여넣기의 하루 지난 것 청소가 걷는다).
      const files = pasted.get(id)
      pasted.delete(id)
      const c = own.get(hostKey)
      if (files && c) void removeRemoteFiles(c, files)
    },
    // 서버에 없는 저장 탭은 이미 끝난 것 — 지운다.
    listed: (hostKey, ids) => {
      const next = tabs.filter((x) => x.hostKey !== hostKey || ids.includes(x.info.id))
      if (next.length === tabs.length) return
      tabs = next
      save()
    },
    log
  })
  const pasted = new Map<string, string[]>()
  /** 끊긴 채 닫아 못 끝낸 세션을 끝낸다(그 서버에 다시 붙을 때). */
  const flushKills = async (hostKey: string, client: Client): Promise<void> => {
    for (const k of kills.filter((x) => x.hostKey === hostKey)) {
      await remote.kill(hostKey, client, k.id).catch(() => {})
      kills = kills.filter((x) => x !== k)
      save()
    }
  }

  /** 동의한 호스트 확인 + 판이 다르면 동의 범위 안에서 교체(돌고 있는 에이전트가 있으면 미룸). 동의가 없으면 아무것도 깔지 않는다. */
  const ensureReady = async (hostKey: string): Promise<ManagedRecord> => {
    if (!records.some((r) => r.hostKey === hostKey)) throw new Error('이 서버에는 설치 동의가 없습니다.')
    try {
      const client = await clientFor(hostKey)
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
      if (d === 'update' && probe.installed) {
        log(`orcad ${hostKey} updated ${probe.installed} -> ${deps.appVersion}`)
        deps.updated?.({ hostKey, from: probe.installed, to: deps.appVersion })
      }
      return put(hostKey, { state: 'installed', version: deps.appVersion })
    } catch (e) {
      return put(hostKey, { state: 'failed', note: e instanceof Error ? e.message : String(e) })
    }
  }

  handle('managed:list', (): ManagedListResult => ({ records, targets: targets().map(({ hostKey, label }) => ({ hostKey, label })) }))
  handle('managed:plan', async ({ hostKey }) => {
    try {
      const probe = await probeHost(await clientFor(hostKey))
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
      const client = await clientFor(hostKey)
      remote.detach(hostKey)
      const remnants = await uninstallHost(client)
      if (remnants.length) {
        put(hostKey, { state: 'failed', note: `남은 것: ${remnants.join(', ')}` })
        return { ok: false, remnants }
      }
      records = records.filter((r) => r.hostKey !== hostKey)
      tabs = tabs.filter((x) => x.hostKey !== hostKey)
      kills = kills.filter((x) => x.hostKey !== hostKey)
      save()
      log(`orcad ${hostKey} removed — nothing left`)
      return { ok: true, remnants: [] }
    } catch (e) {
      return { ok: false, remnants: [], error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('managed:hosts', () => runOnHosts(deps.profiles.list().filter((p): p is SshProfile => p.type === 'ssh'), records))

  return {
    remote,
    ensureReady,
    run: (hostKey) => async (script, timeoutMs) => execSh(await clientFor(hostKey), script, timeoutMs),
    // DM-05: 실행 직전에 준비(동의 확인 · 판 비교 → 같으면 그대로, 다르면 동의 범위 안에서 교체, 돌고 있으면 미룸) → 원격 세션.
    async launch(hostKey, spec) {
      const rec = await ensureReady(hostKey)
      if (rec.state === 'failed' || rec.state === 'missing') throw new Error(rec.note ?? '이 서버의 아라 데몬을 준비하지 못했습니다.')
      await remote.create(hostKey, await clientFor(hostKey), spec)
    },
    // 끊긴 원격 탭 [다시 연결] — 새 연결로 붙어 원격에 산 세션을 같은 id 로 되살린다(이미 붙은 것은 건너뛴다).
    reconnect: async (hostKey) => {
      const c = await clientFor(hostKey)
      await flushKills(hostKey, c)
      return remote.attach(hostKey, c)
    },
    savedTabs: () => tabs.map((x) => x.info),
    // 끊긴 원격 탭 닫기 — 잠깐 붙어서 끝낸다. 못 붙으면 기억해 두고 다음에 붙을 때 끝낸다(탭은 바로 닫힌다).
    async kill(hostKey, id) {
      dropTab(id)
      try {
        await remote.kill(hostKey, await clientFor(hostKey), id)
        return true
      } catch (e) {
        log(`orcad ${hostKey} kill ${id} deferred: ${e instanceof Error ? e.message : String(e)}`)
        if (records.some((r) => r.hostKey === hostKey)) {
          kills = [...kills.filter((x) => x.id !== id), { hostKey, id }]
          save()
        }
        return false
      }
    },
    // 원격 에이전트 탭 붙여넣기 — 그 세션의 서버 연결로 ~/.ara-paste 에 올린다(R2 터미널과 같은 규칙).
    async pasteImage(sessionId, bytes, mime) {
      const hostKey = remote.hostOf(sessionId)
      if (!hostKey) return null
      try {
        const r = await uploadPasteImage(await clientFor(hostKey), bytes, mime)
        if (r.ok) pasted.set(sessionId, [...(pasted.get(sessionId) ?? []), r.path])
        return r
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
    closeAll() {
      remote.closeAll()
      for (const c of own.values()) c.end()
      own.clear()
    }
  }
}

export type ManagedFeature = {
  remote: RemoteAgents
  ensureReady(hostKey: string): Promise<ManagedRecord>
  /** DM-04 원격 git — 그 서버에서 sh -c 한 번(연결은 clientFor). */
  run(hostKey: string): RemoteRun
  /** DM-05 원격 에이전트 세션 만들기(준비 포함). */
  launch(hostKey: string, spec: DaemonCreateSpec): Promise<void>
  reconnect(hostKey: string): Promise<DaemonSessionInfo[]>
  /** 앱을 다시 켰을 때 '끊김'으로 되살릴 원격 탭(서버에 묻지 않는다 — 자동 재접속 없음). */
  savedTabs(): DaemonSessionInfo[]
  /** 끊긴 원격 탭을 닫을 때 서버의 세션을 끝낸다. false = 못 붙어서 다음 연결 때로 미룸. */
  kill(hostKey: string, id: string): Promise<boolean>
  /** 원격 에이전트 탭이면 그 서버에 올린 경로, 아니면 null. */
  pasteImage(sessionId: string, bytes: Buffer, mime: string): Promise<PasteResult | null>
  closeAll(): void
}

type SavedTab = { hostKey: string; info: DaemonSessionInfo }

function failText(r: ConnectFailure): string {
  if (r.reason === 'hostKeyNew') return '처음 보는 서버 지문입니다 — 터미널에서 이 서버에 한 번 접속해 지문을 확인해 주세요.'
  if (r.reason === 'hostKeyMismatch') return '서버 지문이 저장된 것과 다릅니다 — 접속하지 않았습니다.'
  return r.message
}
