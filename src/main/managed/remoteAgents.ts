// M8 DM-02 — 원격 orcad 의 에이전트 세션을 아라 세션 파이프라인에 태운다(로컬 데몬 service.ts 의 원격판, 핵심만).
// 호스트마다 다리 하나(SSH exec 채널). 세션은 원격 데몬에 산다 — SSH 가 끊기면 이 쪽 탭만 끝나고(잃음 표시) 원격 세션은 남는다.
// 다시 붙으면(attach) 목록을 받아 같은 id 로 되살린다(원격 replay 로 화면이 돌아온다). 턴 끝·상태 판정은 아라 쪽 파이프라인(M3 매니페스트 tap)이 한다 —
// 데몬은 PTY 바이트만 나른다.
import type { Client } from 'ssh2'
import { AGENT_SESSION_LOST_EXIT } from '@shared/agentHooks'
import type { DaemonConnection } from '../daemon/client'
import type { DaemonCreateSpec, DaemonSessionInfo } from '../daemon/protocol'
import { DaemonBackend } from '../daemon/service'
import { openBridge } from './host'

export type RemoteAgents = {
  /** 붙고(없으면 다리를 연다) 원격에 산 세션을 모두 되살린다. 이미 붙은 세션은 건너뛴다. */
  attach(hostKey: string, client: Client): Promise<DaemonSessionInfo[]>
  /** 원격에 세션을 만든다. env 는 원격 환경 위에 덧붙는다(아라의 로컬 환경을 보내지 않는다 — Windows PATH 가 원격을 망친다). */
  create(hostKey: string, client: Client, spec: DaemonCreateSpec): Promise<DaemonSessionInfo>
  /** 원격에 돌고 있는 세션 수(업데이트 미룸 판정). 붙어 있지 않으면 붙어서 잰다. */
  liveSessions(hostKey: string, client: Client): Promise<number>
  /** M8 R4 탭 닫기 = 그 세션을 서버에서 끝낸다(Orca: 닫기 = 종료). 끊긴 탭이면 잠깐 붙어서 끝내고, 이 호스트에 붙은 탭이 없으면 다리를 닫는다. */
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
      if (e.type === 'memoryOver') return
      const x = backends.get(e.id)
      if (!x) return
      if (e.type === 'data') return x.b.emitData(e.data)
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
    const b = new DaemonBackend(info.id, info.pid, conn)
    backends.set(info.id, { b, host: hostKey })
    deps.adopt(b, info, hostKey)
    if (restored) deps.restored?.(info, hostKey)
    try {
      await conn.request({ type: 'attach', id: info.id })
    } catch {
      backends.delete(info.id)
      b.emitExit(0)
    }
  }

  const detach = (hostKey: string): void => {
    conns.get(hostKey)?.close()
    conns.delete(hostKey)
  }

  return {
    async attach(hostKey, client) {
      const conn = await ensure(hostKey, client)
      const list = await conn.request<DaemonSessionInfo[]>({ type: 'list' })
      deps.listed?.(hostKey, list.map((x) => x.id))
      const fresh = list.filter((info) => !backends.has(info.id))
      for (const info of fresh) await adoptOne(hostKey, conn, info, true)
      return fresh
    },
    async create(hostKey, client, spec) {
      const conn = await ensure(hostKey, client)
      const info = await conn.request<DaemonSessionInfo>({ type: 'create', spec })
      await adoptOne(hostKey, conn, info, false)
      return info
    },
    async liveSessions(hostKey, client) {
      const conn = await ensure(hostKey, client)
      return (await conn.request<DaemonSessionInfo[]>({ type: 'list' })).length
    },
    async kill(hostKey, client, id) {
      const conn = await ensure(hostKey, client)
      await conn.request({ type: 'kill', id })
      deps.gone?.(id, hostKey)
      if (![...backends.values()].some((x) => x.host === hostKey)) detach(hostKey)
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
