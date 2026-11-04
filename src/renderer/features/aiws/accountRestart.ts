// 원격 3차 R0 다른 계정으로 이어서 — Orca renderer/src/lib/agent-account-restart-startup.ts(orcaRef ec112c6b01)의 아라판.
// 그 탭의 CLI 세션 id 를 받고(닫기 전에 — 닫으면 main 이 transcript 경로를 잊는다) 세션을 끈 뒤, 같은 에이전트·같은 폴더로
// `--resume <id>` 를 새 계정 env 로 띄워 옛 탭 자리에 둔다(hibernation.ts wakeTab 과 같은 자리 바꾸기).
// Claude 는 세션 id 가 없으면 하지 않는다(Orca: null). Codex 는 없으면 새로 띄운다. 대화 기록은 main 이 공유(Claude)·복사(Codex)한다.
// 한도 신호는 기존 사용량 저장소 — 그 탭의 계정이 지금 고른 계정이고 5시간·주간 중 하나가 100% 면 걸린 것(사용량은 고른 계정 것만 있다).
// 뺀 것: "풀리면 알림"(목업 [15:00 에 알림]), 실행 설정(인자) 되살리기 — 고른 설정·계정으로 새로 띄운다.
// R3 원격 탭: 계정 = 그 서버의 계정(설정 › 관리형 서버 › 계정), 세션 id = 서버 훅이 알려 준 것, 한도 = 서버 훅 StopFailure rate_limit(풀리는 시각은 모름).
// 옛 세션은 서버에서 끝내고(이 PC 에서만 닫으면 서버에 같은 대화를 쓰는 프로세스가 둘이 된다) 같은 서버에 새 계정으로 띄운다.
import type { UsageState, UsageWindow } from '@shared/usage'
import type { ServerAccounts } from '@shared/managedServers'
import { useAgentStore, type AgentTab } from './agentStore'
import { useAiwsStore } from './store'
import { liveWindow } from '../../store/usage'
import { t } from '../../i18n'

export type AccountProviderId = 'claude' | 'codex'
export type AccountChoice = { id: string | null; label: string }

export const accountProviderOf = (tab: Pick<AgentTab, 'agent'>): AccountProviderId | null => (tab.agent === 'claude' || tab.agent === 'codex' ? tab.agent : null)

/** R3 원격 탭의 계정 이름(서버 목록에서 — 모르면 서버 본래 로그인). */
const serverLabel = (srv: ServerAccounts | null, id: string | null | undefined): string => (id ? (srv?.accounts.find((a) => a.id === id)?.label ?? id) : t('managed.acct.system'))

/** 탭이 띄운 계정(모르면 지금 고른 계정 — 예전 탭·되살린 탭). */
const tabAccount = (u: UsageState, tab: AgentTab, p: AccountProviderId): string | null => (tab.account !== undefined ? tab.account : u.accounts[p].active)

/** 그 탭의 계정 이름. */
export function accountLabel(u: UsageState, p: AccountProviderId, id: string | null): string {
  return id === null ? t('usage.acct.system') : (u.accounts[p].list.find((a) => a.id === id)?.label ?? t('usage.acct.system'))
}

/** 옮겨 갈 수 있는 계정(시스템 기본 + 추가한 계정, 지금 계정은 뺀다). 원격 탭은 그 서버의 로그인된 계정(srv). */
export function accountChoices(u: UsageState, tab: AgentTab, srv: ServerAccounts | null = null): AccountChoice[] {
  const p = accountProviderOf(tab)
  if (!p) return []
  if (tab.host) {
    const mine = (srv?.accounts ?? []).filter((a) => a.agent === p && a.loggedIn).map((a) => ({ id: a.id, label: a.label }))
    return [{ id: null, label: t('managed.acct.system') }, ...mine].filter((a) => a.id !== (tab.account ?? null))
  }
  const cur = tabAccount(u, tab, p)
  return [{ id: null, label: t('usage.acct.system') }, ...u.accounts[p].list].filter((a) => a.id !== cur)
}

/** 한도에 걸렸나 — 걸린 창의 초기화 시각(모르면 null)과 계정 이름. 안 걸렸으면 null. */
export function limitOf(u: UsageState, tab: AgentTab, now: number, srv: ServerAccounts | null = null): { resetsAt: number | null; label: string } | null {
  const p = accountProviderOf(tab)
  if (!p || tab.exited || tab.slept) return null
  if (tab.host) return useAgentStore.getState().limitById[tab.sessionId] ? { resetsAt: null, label: serverLabel(srv, tab.account) } : null
  const cur = tabAccount(u, tab, p)
  if (cur !== u.accounts[p].active) return null
  const hit = [u[p]?.session ?? null, u[p]?.weekly ?? null].map((w) => liveWindow(w, now)).filter((w): w is UsageWindow => !!w && w.usedPercent >= 100)
  if (!hit.length) return null
  const at = hit.map((w) => w.resetsAt).filter((x): x is number => x !== null)
  return { resetsAt: at.length ? Math.max(...at) : null, label: accountLabel(u, p, cur) }
}

const switching = new Set<string>()

/** 이 탭을 그 계정으로 이어 띄운다. 실패면 사유, 성공이면 null. */
export async function switchAccount(sessionId: string, account: string | null, label: string): Promise<string | null> {
  const st = useAgentStore.getState()
  const old = st.tabs.find((x) => x.sessionId === sessionId)
  if (!old || !accountProviderOf(old) || old.exited || old.slept) return t('aiws.acct.cannot')
  if (switching.has(sessionId)) return null
  const w = Object.values(useAiwsStore.getState().worktreesByRepo)
    .flat()
    .find((x) => x.id === old.worktreeId)
  if (!w) return t('aiws.agent.restart.noWorktree')
  switching.add(sessionId)
  try {
    const ids = await window.ev.agents.resumeIds([sessionId]).catch(() => ({}) as Record<string, string | null>)
    const resume = ids[sessionId] ?? undefined
    if (!resume && old.agent === 'claude') return t('aiws.acct.noSession')
    // 같은 대화를 두 프로세스가 쓰지 않게 먼저 끈다(Orca: PTY 를 끝내고 다시 띄운다). 한도에 걸린 턴은 이미 멈춰 있다.
    // 원격 탭의 destroy 는 이 PC 에서만 놓기라 서버에서 끝낸다.
    if (old.host) await window.ev.agents.killRemote(old.host, sessionId).catch(() => false)
    else await window.ev.session.destroy(sessionId)
    const r = await st.launchAgent({ agent: old.agent, worktreeId: old.worktreeId, cwd: w.path, ...(resume ? { resume } : {}), options: { account }, ...(old.vaultTitle ? { vaultTitle: old.vaultTitle } : {}) })
    if (!r.ok) return r.error
    const fresh = r.sessionId
    const keep = { switched: label, ...(old.name ? { name: old.name } : {}), ...(old.genTitle ? { genTitle: old.genTitle } : {}) }
    useAgentStore.setState((s) => {
      const nt = s.tabs.find((x) => x.sessionId === fresh)
      return nt ? { tabs: s.tabs.filter((x) => x !== nt).flatMap((x) => (x.sessionId === sessionId ? [x, { ...nt, ...keep }] : [x])) } : {}
    })
    // 채팅으로 보던 탭은 채팅으로 이어 본다.
    if (st.chatOn[sessionId] && !useAgentStore.getState().chatOn[fresh]) useAgentStore.getState().toggleChat(fresh)
    useAgentStore.getState().closeTab(sessionId)
    useAgentStore.getState().setActiveTab(old.worktreeId, fresh)
    return null
  } finally {
    switching.delete(sessionId)
  }
}
