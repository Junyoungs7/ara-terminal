// M8 DM-02 — 원격 orcad 의 에이전트 세션을 아라 세션 파이프라인에 태운다(로컬 데몬 service.ts 의 원격판, 핵심만).
// 호스트마다 다리 하나(SSH exec 채널). 세션은 원격 데몬에 산다 — SSH 가 끊기면 이 쪽 탭만 끝나고(잃음 표시) 원격 세션은 남는다.
// 다시 붙으면(attach) 목록을 받아 같은 id 로 되살린다(원격 replay 로 화면이 돌아온다). 턴 끝·상태 판정은 아라 쪽 파이프라인(M3 매니페스트 tap)이 한다 —
// 데몬은 PTY 바이트만 나른다.
// R1 다른 PC 에서 이어 보기: 같은 세션에 PC 여럿이 붙는다(입력은 모두 같은 PTY 로, 출력은 모두에게 — Orca 처럼). 탭 닫기 = 이 PC 에서만 놓기(detach),
// 서버에서 끝내기는 kill 따로. 붙을 때 PC 이름을 알려 다른 PC 에 "누가 보는 중"(viewers 사건)이 보인다.
// R2 서버에서 상태 판정: 에이전트 훅이 orcad 에 닿으면 status 사건(붙은 PC 모두에게, 늦게 붙으면 attach 때 마지막 것) → deps.status.
// R3 서버 계정: account 요청(목록·추가·지우기·기본) — 붙은 탭이 없으면 다리를 닫는다(list 와 같다).
// R4 채팅 보기: read 요청(그 세션의 연결 그대로 — SFTP 를 따로 열지 않는다).
import type { Client } from 'ssh2'
import { AGENT_SESSION_LOST_EXIT } from '@shared/agentHooks'
import type { TranscriptSlice } from '@shared/agentChat'
import type { DaemonConnection } from '../daemon/client'
import type { DaemonCreateSpec, DaemonSessionInfo } from '../daemon/protocol'
import { DaemonBackend } from '../daemon/service'
import { openBridge } from './host'

export type RemoteAgents = {
  /** 붙고(없으면 다리를 연다) 원격에 산 세션을 되살린다(only 를 주면 그 id 만). 이미 붙은 세션은 건너뛴다. */
  attach(hostKey: string, client: Client, only?: readonly string[]): Promise<DaemonSessionInfo[]>
  /** R1 서버 세션 목록(붙지 않고 보기만 — viewers = 지금 붙은 PC). */
  list(hostKey: string, client: Client): Promise<DaemonSessionInfo[]>
  /** R1 이 PC 에서만 닫기 — 서버 세션은 산다. 이 호스트에 붙은 탭이 없으면 다리를 닫는다. */
  release(id: string): void
  /** R1 서버 세션의 meta 덧쓰기(제목 등 — 다른 PC 가 목록에서 본다). 붙은 세션만, 실패는 넘어간다. */
  meta(id: string, patch: Record<string, unknown>): void
  /**
   * 원격에 세션을 만든다. env 는 원격 환경 위에 덧붙는다(아라의 로컬 환경을 보내지 않는다 — Windows PATH 가 원격을 망친다).
   * R2: spec 을 함수로 주면 그 서버 orcad 의 훅 폴더(hello hookDir — 옛 orcad 는 null)를 받아 만든다.
   */
  create(hostKey: string, client: Client, spec: DaemonCreateSpec | ((hookDir: string | null) => DaemonCreateSpec)): Promise<DaemonSessionInfo>
  /** R3 서버 계정 요청(답 그대로). */
  account(hostKey: string, client: Client, req: { op: 'list' | 'add' | 'remove' | 'default'; agent?: string; label?: string; id?: string | null }): Promise<unknown>
  /** R4 붙은 세션의 서버 연결로 transcript 조각(경로 검사는 orcad). 붙지 않았으면 실패. */
  read(id: string, path: string, offset: number | null): Promise<TranscriptSlice>
  /** 원격에 돌고 있는 세션 수(업데이트 미룸 판정). 붙어 있지 않으면 붙어서 잰다. */
  liveSessions(hostKey: string, client: Client): Promise<number>
  /** R1 "서버에서도 끝내기"(탭 닫기 기본은 release). 끊긴 탭이면 잠깐 붙어서 끝내고, 이 호스트에 붙은 탭이 없으면 다리를 닫는다. */
  kill(hostKey: string, client: Client, id: string): Promise<void>
  /** 이 세션이 붙은 호스트(원격 붙여넣기가 연결을 찾는다). */
  hostOf(id: string): string | undefined
  /** 다리만 닫는다(세션은 원격에 산다). 제거 전에 부른다. */
  detach(hostKey: string): void
  connected(hostKey: string): boolean
  /** 앱 종료 — 다리 모두 닫기. */
  closeAll(): void
}

export function createRemoteAgents(deps: {
  adopt: (backend: DaemonBackend, info: DaemonSessionInfo, hostKey: string) => void
  /** attach 로 되살린 세션(탭 복원·상태 판정 붙이기). adopt 뒤에 불린다. */
  restored?: (info: DaemonSessionInfo, hostKey: string) => void
  /** 세션이 서버에서 정말 끝났다(잃음 아님) — 저장한 탭 목록에서 뺀다. */
  gone?: (id: string, hostKey: string) => void
  /** attach 가 받은 서버의 세션 목록 전부(저장한 탭 중 서버에 없는 것을 거른다). */
  listed?: (hostKey: string, ids: string[]) => void
  /** R1 이 PC 에서만 닫았다(서버 세션은 산다) — 저장한 탭 목록에서 뺀다. */
  released?: (id: string, hostKey: string) => void
  /** R1 그 세션에 붙은 PC 가 바뀌었다(이 PC 포함). */
  viewers?: (id: string, viewers: string[]) => void
  /** R2 서버가 들은 에이전트 훅(이 PC 에 붙은 세션만). */
  status?: (id: string, source: string, payload: Record<string, unknown>) => void
  /** R1 서버에 알릴 이 PC 의 이름. */
  pc?: string
  log: (msg: string) => void
  /** 시험이 다리를 바꿔 끼울 때만. */
  bridge?: (client: Client) => Promise<DaemonConnection>
}): RemoteAgents {
  const open = deps.bridge ?? openBridge
  const conns = new Map<string, DaemonConnection>()
  const connecting = new Map<string, Promise<DaemonConnection>>()
  const backends = new Map<string, { b: DaemonBackend; host: string }>()

  const wire = (hostKey: string, conn: DaemonConnection): void => {
    conn.onEvent((e) => {
      if (e.type === 'memoryOver' || e.type === 'meta') return
      const x = backends.get(e.id)
      if (!x) return
      if (e.type === 'data') return x.b.emitData(e.data)
      if (e.type === 'viewers') return deps.viewers?.(e.id, e.viewers)
      if (e.type === 'status') return deps.status?.(e.id, e.source, e.payload)
      backends.delete(e.id)
      deps.gone?.(e.id, x.host)
      x.b.emitExit(e.code, e.signal)
    })
    conn.onClose((intentional) => {
      if (conns.get(hostKey) === conn) conns.delete(hostKey)
      const mine = [...backends.values()].filter((x) => x.b.conn === conn)
      if (!intentional) deps.log(`orcad ${hostKey} bridge lost — ${mine.length} tab(s) detached (sessions live on the server)`)
      for (const x of mine) {
        backends.delete(x.b.id)
        x.b.emitExit(AGENT_SESSION_LOST_EXIT)
      }
    })
  }

  const ensure = (hostKey: string, client: Client): Promise<DaemonConnection> => {
    const have = conns.get(hostKey)
    if (have) return Promise.resolve(have)
    let p = connecting.get(hostKey)
    if (!p) {
      p = open(client)
        .then((conn) => {
          conns.set(hostKey, conn)
          wire(hostKey, conn)
          deps.log(`orcad ${hostKey} attached pid=${conn.hello.pid} protocol=${conn.hello.protocol} version=${conn.hello.appVersion ?? '?'}`)
          return conn
        })
        .finally(() => connecting.delete(hostKey))
      connecting.set(hostKey, p)
    }
    return p
  }

  const adoptOne = async (hostKey: string, conn: DaemonConnection, info: DaemonSessionInfo, restored: boolean): Promise<void> => {
    const b = new RemoteBackend(info.id, info.pid, conn, () => release(info.id))
    backends.set(info.id, { b, host: hostKey })
    deps.adopt(b, info, hostKey)
    if (restored) deps.restored?.(info, hostKey)
    try {
      await conn.request({ type: 'attach', id: info.id, ...(deps.pc ? { pc: deps.pc } : {}) })
    } catch {
      backends.delete(info.id)
      b.emitExit(0)
    }
  }

  const detach = (hostKey: string): void => {
    conns.get(hostKey)?.close()
    conns.delete(hostKey)
  }
  const idle = (hostKey: string): boolean => ![...backends.values()].some((x) => x.host === hostKey)

  const release = (id: string): void => {
    const x = backends.get(id)
    if (!x) return
    backends.delete(id)
    deps.released?.(id, x.host)
    // 붙은 탭이 더 없으면 다리째 닫는다(서버가 이 PC 를 보는 중에서 뺀다). 남았으면 이 세션만 놓는다.
    if (idle(x.host)) detach(x.host)
    else void x.b.conn.request({ type: 'detach', id }).catch(() => {})
  }

  return {
    async attach(hostKey, client, only) {
      const conn = await ensure(hostKey, client)
      const list = await conn.request<DaemonSessionInfo[]>({ type: 'list' })
      deps.listed?.(hostKey, list.map((x) => x.id))
      const fresh = list.filter((info) => !backends.has(info.id) && (!only || only.includes(info.id)))
      // 붙을 것이 없으면 세려고 연 다리를 닫는다(서버가 혼자 남은 연결 때문에 살지 않게).
      if (!fresh.length && idle(hostKey)) detach(hostKey)
      for (const info of fresh) await adoptOne(hostKey, conn, info, true)
      return fresh
    },
    async create(hostKey, client, spec) {
      const conn = await ensure(hostKey, client)
      let made: DaemonCreateSpec
      try {
        made = typeof spec === 'function' ? spec(conn.hello.hookDir ?? null) : spec
      } catch (e) {
        if (idle(hostKey)) detach(hostKey)
        throw e
      }
      const info = await conn.request<DaemonSessionInfo>({ type: 'create', spec: made })
      await adoptOne(hostKey, conn, info, false)
      return info
    },
    async list(hostKey, client) {
      const conn = await ensure(hostKey, client)
      const list = await conn.request<DaemonSessionInfo[]>({ type: 'list' })
      if (idle(hostKey)) detach(hostKey)
      return list
    },
    async account(hostKey, client, req) {
      const conn = await ensure(hostKey, client)
      try {
        return await conn.request({ type: 'account', ...req })
      } finally {
        if (idle(hostKey)) detach(hostKey)
      }
    },
    release,
    read(id, path, offset) {
      const x = backends.get(id)
      return x ? x.b.conn.request<TranscriptSlice>({ type: 'read', id, path, offset }) : Promise.reject(new Error('not attached'))
    },
    meta(id, patch) {
      const x = backends.get(id)
      if (x) void x.b.conn.request({ type: 'meta', id, meta: patch }).catch(() => {})
    },
    async liveSessions(hostKey, client) {
      const conn = await ensure(hostKey, client)
      return (await conn.request<DaemonSessionInfo[]>({ type: 'list' })).length
    },
    async kill(hostKey, client, id) {
      const conn = await ensure(hostKey, client)
      await conn.request({ type: 'kill', id })
      deps.gone?.(id, hostKey)
      if (idle(hostKey)) detach(hostKey)
    },
    hostOf: (id) => backends.get(id)?.host,
    detach,
    connected: (hostKey) => conns.has(hostKey),
    closeAll() {
      for (const c of conns.values()) c.close()
      conns.clear()
    }
  }
}

/** 원격 탭의 백엔드 — 닫기(kill) = 이 PC 에서만 놓기(R1 결정 4 ⓑ). 서버에서 끝내기는 RemoteAgents.kill. */
class RemoteBackend extends DaemonBackend {
  constructor(
    id: string,
    pid: number,
    conn: DaemonConnection,
    private readonly onClose: () => void
  ) {
    super(id, pid, conn)
  }
  override kill(): void {
    this.onClose()
  }
}
