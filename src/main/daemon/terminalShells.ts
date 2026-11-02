// M11 R2 터미널 공간 로컬 셸을 데몬에(Orca: 터미널 PTY 는 모두 데몬에 산다 — 앱 재시작·업데이트에도 산다). SSH 는 대상 아님(서버 무영향).
// 데몬 세션 meta 에 터미널 세션 모양을 실어 두었다가, 켤 때는 붙지 않고 세워 둔다(service parked) → 화면의 F6 복원이 저장한 세션 id 로
// 다시 찾으면(SessionSpec.reattach) 그 자리에 붙인다. 아무도 안 찾은 셸은 복원이 끝날 때(session:restored) 끈다. 데몬이 없으면 지금처럼 새 셸.
import type { Session } from '@shared/types'
import type { SessionSpec } from '../sessions/ISessionManager'
import type { LocalDaemonHook } from '../sessions/MainSessionManager'
import type { DaemonSessionInfo } from './protocol'
import type { AgentDaemon } from './service'
import { withAraCliPath } from '../cli/childPath'

/**
 * 첫 셸이 데몬 띄우기를 기다리는 상한. 데몬은 켤 때 미리 띄우므로(warm) 보통은 이미 붙어 있다. 판이 바뀐 뒤 첫 실행은 런타임 복사(수백 MB)로
 * 늦을 수 있어 — 넘으면 그 셸은 앱 안 PTY 로 연다(지금과 같음, 재시작을 못 넘을 뿐). 뒤의 셸부터 데몬에.
 */
export const TERMINAL_DAEMON_WAIT_MS = 3_000

export const isTerminalInfo = (info: DaemonSessionInfo): boolean => info.meta['kind'] === 'terminal'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** 데몬 meta → 아라 세션 모양. 데몬이 기억한 것은 만들 때 모양 — 그 뒤 바뀐 제목·cwd·창은 화면이 claim 할 때 다시 준다(MainSessionManager.create). */
export function terminalSessionOf(info: DaemonSessionInfo): Omit<Session, 'id'> {
  const m = (info.meta['session'] ?? {}) as Record<string, unknown>
  return {
    type: 'local',
    title: str(m['title']) ?? 'shell',
    serverKey: 'localhost',
    cwd: str(m['cwd']) ?? (info.cwd || undefined),
    profileId: null,
    ...(str(m['shell']) ? { shell: str(m['shell']) } : {}),
    ...(m['manualTitle'] === true ? { manualTitle: true } : {}),
    // 만들 때 부른 창(떼어낸 창에서 연 탭). 켤 때 claim 하면 화면이 준 창으로 바꾼다(MainSessionManager.create).
    ...(str(m['winId']) ? { winId: str(m['winId']) } : {}),
    cols: info.cols,
    rows: info.rows
  }
}

/** 데몬 셸은 앱의 지금 환경을 받는다(에이전트와 같은 이유 — 데몬 환경은 띄운 순간에 굳는다). PATH 맨 앞에 ara 폴더(정리 1, cli/childPath.ts). */
export const appEnv = (): Record<string, string> =>
  withAraCliPath(Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => typeof x[1] === 'string' && x[0] !== 'ELECTRON_RUN_AS_NODE')))

const within = (p: Promise<boolean>, ms: number): Promise<boolean> =>
  Promise.race([p, new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())])

export function createTerminalDaemonHook(daemon: AgentDaemon, log: (m: string) => void, waitMs = TERMINAL_DAEMON_WAIT_MS): LocalDaemonHook {
  return {
    async create(spec: SessionSpec, id: string) {
      if (!(await within(daemon.warm(), waitMs))) {
        log(`terminal shell ${id}: daemon not ready in ${waitMs}ms — in-app PTY`)
        return false
      }
      const session = { title: spec.title, cwd: spec.cwd, shell: spec.shell, manualTitle: spec.manualTitle, winId: spec.winId }
      try {
        await daemon.create({ id, cwd: spec.cwd ?? '', cols: spec.cols, rows: spec.rows, env: appEnv(), space: 'terminal', ...(spec.shell ? { shell: spec.shell } : {}), meta: { kind: 'terminal', session } })
        return true
      } catch (e) {
        log(`terminal shell ${id}: daemon create failed — in-app PTY: ${String(e)}`)
        return false
      }
    },
    claim: (id) => daemon.claim(id),
    release: () => daemon.releaseParked()
  }
}
