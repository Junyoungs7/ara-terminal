// M8 DM-02·03 관리형 서버 — 기능 틀(docs/feature-module.md)의 main 등록 함수. 동의·설치·업데이트·제거 IPC 를 여기서 건다.
// 동의 기록은 userData/managed-servers.json(호스트별). 기록이 있다 = 그 호스트에 동의했다. 철회 = 제거(검증해서 흔적 0 일 때만 기록을 지운다).
// 연결: M8 R3 부터 저장된 SSH 프로필로 **셸 없이** 따로 붙는다(connectSshClient — 터미널 탭 없이 AI 공간만으로). 그 연결이 안 되면(비밀번호를
// 저장 안 함 등) 그 호스트로 열린 터미널 세션의 Client 를 빌린다(R1 방식). 원격 에이전트 다리는 자기 연결 위에 있어 터미널 탭을 닫아도 안 끊긴다.
// 터미널 공간은 여기를 부르지 않는다 — 설치는 사람이 설정 › 관리형 서버에서 [설치]를 눌렀을 때만.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { Client } from 'ssh2'
import { handle } from '../ipc/handle'
import { mainErrorLogPath } from '../log/MainErrorLog'
import { cleanupTemp, readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import type { MainSessionManager } from '../sessions/MainSessionManager'
import type { ProfileStore } from '../secrets/ProfileStore'
import { LOGIN_SESSION_KIND, STOP_SCRIPT, accountErrorText, lostToReboot, residentScript, accountLoginLine, consentPlan, decideUpdate, hostKeyOf, isServerAccountAgent, serverAccountsOf, serverRowsOf, type ManagedRecord, type ManagedState, type ServerAccount, type ServerSessionsHost } from '@shared/managedServers'
import type { ManagedAccountsRequest, ManagedAccountsResult, ManagedListResult, ManagedRemoveResult } from '@shared/ipc'
import type { SshProfile } from '@shared/types'
import type { TranscriptSlice } from '@shared/agentChat'
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
  /** R1 원격 탭에 붙은 PC 가 바뀌었다(탭의 "PC 2대" 표시). */
  viewers?: (e: { sessionId: string; viewers: string[] }) => void
  /** R2 서버가 들은 에이전트 훅 — 로컬 훅과 같은 상태 파이프라인으로. */
  status?: (sessionId: string, source: string, payload: Record<string, unknown>) => void
  /** R6 다른 PC 가 원격 탭에 입력했다("노트북 입력 중"). */
  typing?: (e: { sessionId: string; pc: string }) => void
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
    adopt: (backend, info, hostKey, boot) => {
      const title = typeof info.meta['title'] === 'string' ? info.meta['title'] : 'agent'
      deps.sessions().adopt(backend, { type: 'ssh', title, serverKey: hostKey, cwd: info.cwd, profileId: null, space: 'ai', cols: info.cols, rows: info.rows }, info.id)
      // R3 계정 로그인 칸은 설정 화면 안에서만 산다 — 다시 켜도 되살리지 않는다.
      if (info.meta['kind'] === LOGIN_SESSION_KIND) return
      tabs = [...tabs.filter((x) => x.info.id !== info.id), { hostKey, info: { id: info.id, pid: info.pid, cwd: info.cwd, cols: info.cols, rows: info.rows, meta: info.meta }, ...(boot ? { boot } : {}) }]
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
    // R1 이 PC 에서만 닫았다 — 서버 세션은 산다. 다음에 켜도 '끊김'으로 되살리지 않는다.
    released: (id) => dropTab(id),
    viewers: (id, viewers) => deps.viewers?.({ sessionId: id, viewers }),
    status: (id, source, payload) => deps.status?.(id, source, payload),
    typing: (id, pc) => deps.typing?.({ sessionId: id, pc }),
    pc: hostname(),
    // 서버에 없는 저장 탭은 이미 끝난 것 — 지운다. R5: 만들 때와 부팅 id 가 다르면 재부팅으로 잃은 것(다시 연결 결과로 알린다).
    listed: (hostKey, ids, boot) => {
      const lost = lostToReboot(tabs.filter((x) => x.hostKey === hostKey).map((x) => ({ id: x.info.id, boot: x.boot })), ids, boot)
      if (lost.length) rebooted.set(hostKey, [...(rebooted.get(hostKey) ?? []), ...lost])
      const next = tabs.filter((x) => x.hostKey !== hostKey || ids.includes(x.info.id))
      if (next.length === tabs.length) return
      tabs = next
      save()
    },
    log
  })
  const pasted = new Map<string, string[]>()
  const rebooted = new Map<string, string[]>()
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
      // 서버가 안 돌면 세지 않는다 — 세려고 띄우면 상주(R5 기본)라 그대로 남는다.
      const live = probe.installed && probe.running ? await remote.liveSessions(hostKey, client).catch(() => 0) : 0
      const d = decideUpdate({ installed: probe.installed, app: deps.appVersion, liveSessions: live })
      // 세는 데 연 다리 — 세션이 없으면 닫는다(데몬이 혼자 남아 상주하지 않게: 연결도 세션도 없으면 스스로 끝난다).
      if (live === 0) remote.detach(hostKey)
      const resident = probe.resident !== false
      if (d === 'current' || d === 'keepNewer') return put(hostKey, { state: 'installed', version: probe.installed, resident })
      if (d === 'defer') return put(hostKey, { state: 'deferred', version: probe.installed, resident, note: `에이전트 ${live}개가 돌고 있어 업데이트를 미뤘습니다.` })
      // install(사용자가 손으로 지움 — 동의는 남아 있다) · update: 옛 데몬은 세션이 없으니 다리를 닫으면 스스로 내려간다.
      // R1: 다른 PC 가 연결만 붙여 둔 옛 데몬은 안 내려가고 새 토큰을 거절한다 — 세션이 0 이니 내린다(세션 보존 규칙 그대로).
      remote.detach(hostKey)
      if (d === 'update') await execSh(client, STOP_SCRIPT)
      await installHost(client, deps.appVersion)
      if (d === 'update' && probe.installed) {
        log(`orcad ${hostKey} updated ${probe.installed} -> ${deps.appVersion}`)
        deps.updated?.({ hostKey, from: probe.installed, to: deps.appVersion })
      }
      return put(hostKey, { state: 'installed', version: deps.appVersion, resident })
    } catch (e) {
      return put(hostKey, { state: 'failed', note: e instanceof Error ? e.message : String(e) })
    }
  }

  handle('managed:list', (): ManagedListResult => ({ records, targets: targets().map(({ hostKey, label }) => ({ hostKey, label })) }))
  handle('managed:plan', async ({ hostKey }) => {
    try {
      const client = await clientFor(hostKey)
      const probe = await probeHost(client)
      // R1 이미 설치됨(다른 PC) — 채택 화면에 판·살아 있는 세션 수. 서버가 안 돌면 세지 않는다(세려고 띄우지 않게).
      const sessions = probe.installed && probe.running ? (await remote.list(hostKey, client).catch(() => [])).length : 0
      return consentPlan(hostKey, probe, Buffer.byteLength(ORCAD_PY), TOKEN_BYTES * 2, Buffer.byteLength(deps.appVersion), { app: deps.appVersion, sessions })
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

  // R1 서버 세션 목록(설정·F1·AI 공간 › 서버) — 동의한 서버마다 붙지 않고 목록만. 못 붙은 서버는 사유 한 줄.
  handle('managed:sessions', async (): Promise<ServerSessionsHost[]> =>
    Promise.all(
      records.map(async (r): Promise<ServerSessionsHost> => {
        const label = profileOf(r.hostKey)?.name ?? r.hostKey
        try {
          const infos = await remote.list(r.hostKey, await clientFor(r.hostKey))
          return { hostKey: r.hostKey, label, version: r.version, ok: true, sessions: serverRowsOf(r.hostKey, infos, (id) => remote.hostOf(id) === r.hostKey) }
        } catch (e) {
          return { hostKey: r.hostKey, label, version: r.version, ok: false, error: e instanceof Error ? e.message : String(e), sessions: [] }
        }
      })
    )
  )

  // R3 서버 계정(설정 › 관리형 서버 › 계정) — 목록·추가(+ 그 자리 로그인 칸)·다시 로그인·지우기·기본. 실패는 이유 + 할 일 한 줄.
  handle('managed:accounts', async (req: ManagedAccountsRequest): Promise<ManagedAccountsResult> => {
    const { hostKey } = req
    if (!records.some((r) => r.hostKey === hostKey)) return { ok: false, error: '이 서버에는 아라 서버가 없습니다 — 먼저 [설치]해 주세요.' }
    try {
      const op = req.op ?? 'list'
      if (op === 'add') {
        if (!isServerAccountAgent(req.agent)) return { ok: false, error: '모르는 에이전트입니다.' }
        // 계정 추가는 새 판 서버가 필요하다 — 동의 범위 안에서 올린다(돌고 있는 에이전트가 있으면 미뤄 옛 판 그대로 → 아래 '옛 판' 한 줄).
        await ensureReady(hostKey)
      }
      const client = await clientFor(hostKey)
      const login = async (a: ServerAccount): Promise<string> => {
        const id = randomUUID()
        await remote.create(hostKey, client, { id, cwd: '', env: {}, account: { agent: a.agent, id: a.id }, meta: { kind: LOGIN_SESSION_KIND, title: a.label } })
        deps.sessions().write(id, accountLoginLine(a.agent) + '\r')
        return id
      }
      if (op === 'add') {
        const made = serverAccountsOf({ accounts: [await remote.account(hostKey, client, { op: 'add', agent: req.agent, label: req.label ?? '' })] }).accounts[0]
        if (!made) throw new Error('계정을 만들지 못했습니다.')
        const loginSession = await login(made)
        return { ok: true, ...serverAccountsOf(await remote.account(hostKey, client, { op: 'list' })), loginSession }
      }
      if (op === 'login') {
        const all = serverAccountsOf(await remote.account(hostKey, client, { op: 'list' }))
        const a = all.accounts.find((x) => x.id === req.id)
        if (!a) throw new Error('no such account')
        return { ok: true, ...all, loginSession: await login(a) }
      }
      const r = await remote.account(hostKey, client, op === 'list' ? { op } : { op, id: typeof req.id === 'string' ? req.id : null })
      return { ok: true, ...serverAccountsOf(r) }
    } catch (e) {
      return { ok: false, error: accountErrorText(e instanceof Error ? e.message : String(e)) }
    }
  })

  // R5 상주 모드 켜고 끄기(설정 › 관리형 서버, 서버별) — 서버의 설치 폴더에 파일로 남긴다(다른 PC 도 같은 값). 서버를 띄우지 않는다.
  handle('managed:resident', async ({ hostKey, on }): Promise<ManagedRecord | { error: string }> => {
    const rec = records.find((r) => r.hostKey === hostKey)
    if (!rec || typeof on !== 'boolean') return { error: '이 서버에는 아라 서버가 없습니다 — 먼저 [설치]해 주세요.' }
    try {
      const r = await execSh(await clientFor(hostKey), residentScript(on))
      if (r.code !== 0) throw new Error(r.err.trim() || `종료 코드 ${r.code}`)
      log(`orcad ${hostKey} resident ${on ? 'on' : 'off'}`)
      return put(hostKey, { state: rec.state, ...(rec.note ? { note: rec.note } : {}), resident: on })
    } catch (e) {
      return { error: `상주 설정을 바꾸지 못했습니다(${e instanceof Error ? e.message : String(e)}) — 터미널에서 이 서버에 한 번 접속한 뒤 다시 해 보세요.` }
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
      if (rec.state === 'failed' || rec.state === 'missing') throw new Error(rec.note ?? '이 서버의 아라 서버를 준비하지 못했습니다.')
      return remote.create(hostKey, await clientFor(hostKey), spec)
    },
    // 끊긴 원격 탭 [다시 연결] — 새 연결로 붙어 원격에 산 세션을 같은 id 로 되살린다(이미 붙은 것은 건너뛴다).
    // R1: 이 PC 의 탭(저장한 것)만 — 다른 PC 의 세션은 서버 세션 목록에서 골라 붙는다(attachOne).
    reconnect: async (hostKey) => {
      const c = await clientFor(hostKey)
      await flushKills(hostKey, c)
      return remote.attach(hostKey, c, tabs.filter((x) => x.hostKey === hostKey).map((x) => x.info.id))
    },
    takeRebooted: (hostKey) => {
      const ids = rebooted.get(hostKey) ?? []
      rebooted.delete(hostKey)
      return ids
    },
    attachOne: async (hostKey, id) => remote.attach(hostKey, await clientFor(hostKey), [id]),
    forget: (id) => dropTab(id),
    meta: (id, patch) => remote.meta(id, patch),
    read: (id, path, offset) => remote.read(id, path, offset),
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
  /** DM-05 원격 에이전트 세션 만들기(준비 포함). R2: 함수면 그 서버의 훅 폴더(옛 서버는 null)를 받아 spec 을 만든다. */
  launch(hostKey: string, spec: DaemonCreateSpec | ((hookDir: string | null) => DaemonCreateSpec)): Promise<DaemonSessionInfo>
  reconnect(hostKey: string): Promise<DaemonSessionInfo[]>
  /** R5 지난 연결에서 재부팅으로 잃었다고 가른 탭 id(한 번 읽으면 비운다). */
  takeRebooted(hostKey: string): string[]
  /** R1 서버 세션 하나에 붙는다(다른 PC 가 만든 것도). 이미 붙었으면 빈 배열. */
  attachOne(hostKey: string, id: string): Promise<DaemonSessionInfo[]>
  /** R1 끊긴 원격 탭을 이 PC 에서만 닫았다 — 저장 목록에서만 뺀다(서버 세션은 산다). */
  forget(id: string): void
  /** R1 붙은 원격 세션의 meta 덧쓰기(제목 — 다른 PC 의 목록에 보인다). */
  meta(id: string, patch: Record<string, unknown>): void
  /** R4 원격 탭 채팅 보기 — 서버 transcript 조각(RemoteAgents.read). */
  read(id: string, path: string, offset: number | null): Promise<TranscriptSlice>
  /** 앱을 다시 켰을 때 '끊김'으로 되살릴 원격 탭(서버에 묻지 않는다 — 자동 재접속 없음). */
  savedTabs(): DaemonSessionInfo[]
  /** 끊긴 원격 탭을 닫을 때 서버의 세션을 끝낸다. false = 못 붙어서 다음 연결 때로 미룸. */
  kill(hostKey: string, id: string): Promise<boolean>
  /** 원격 에이전트 탭이면 그 서버에 올린 경로, 아니면 null. */
  pasteImage(sessionId: string, bytes: Buffer, mime: string): Promise<PasteResult | null>
  closeAll(): void
}

/** boot: 만들 때(붙을 때) 본 서버 부팅 id(R5 — 재부팅으로 잃은 탭 가르기). */
type SavedTab = { hostKey: string; info: DaemonSessionInfo; boot?: string }

function failText(r: ConnectFailure): string {
  if (r.reason === 'hostKeyNew') return '처음 보는 서버 지문입니다 — 터미널에서 이 서버에 한 번 접속해 지문을 확인해 주세요.'
  if (r.reason === 'hostKeyMismatch') return '서버 지문이 저장된 것과 다릅니다 — 접속하지 않았습니다.'
  return r.message
}
