// 원격 3차 R3 — 원격 탭의 "다른 계정으로 이어서": 고를 계정 = 그 서버의 로그인된 같은 에이전트 계정(+ 서버 본래 로그인, 지금 계정 빼고),
// 한도 = 서버 훅이 알린 것(limitById — 풀리는 시각은 모름). 로컬 탭은 R0 그대로(사용량 저장소).
import { describe, expect, it } from 'vitest'
import { accountChoices, limitOf } from '../src/renderer/features/aiws/accountRestart'
import { useAgentStore, type AgentTab } from '../src/renderer/features/aiws/agentStore'
import type { ServerAccounts } from '../src/shared/managedServers'
import type { UsageState } from '../src/shared/usage'

const u = { accounts: { claude: { active: null, list: [] }, codex: { active: null, list: [] } } } as unknown as UsageState
const tab = (p: Partial<AgentTab>): AgentTab => ({ sessionId: 's1', agent: 'claude', worktreeId: 'w', title: 't', line: '', exited: false, host: 'dev@h:22', ...p })
const srv: ServerAccounts = {
  accounts: [
    { id: 'aaaaaaaaaaaa', agent: 'claude', label: '업무 A', loggedIn: true, email: null, createdAt: 1 },
    { id: 'bbbbbbbbbbbb', agent: 'claude', label: '업무 B', loggedIn: true, email: null, createdAt: 2 },
    { id: 'cccccccccccc', agent: 'claude', label: '로그인 전', loggedIn: false, email: null, createdAt: 3 },
    { id: 'dddddddddddd', agent: 'codex', label: 'Codex', loggedIn: true, email: null, createdAt: 4 }
  ],
  default: 'aaaaaaaaaaaa'
}

describe('원격 탭 — 다른 계정으로 이어서', () => {
  it('서버의 로그인된 같은 에이전트 계정 + 서버 본래 로그인, 지금 계정은 뺀다', () => {
    expect(accountChoices(u, tab({ account: 'aaaaaaaaaaaa' }), srv).map((a) => a.id)).toEqual([null, 'bbbbbbbbbbbb'])
    expect(accountChoices(u, tab({ account: null }), srv).map((a) => a.id)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    expect(accountChoices(u, tab({ agent: 'codex', account: null }), srv).map((a) => a.id)).toEqual(['dddddddddddd'])
    // 목록을 아직 못 받았으면 서버 본래 로그인만.
    expect(accountChoices(u, tab({ account: 'aaaaaaaaaaaa' }), null).map((a) => a.id)).toEqual([null])
  })
  it('한도 = 서버 훅이 알린 것(그 탭의 계정 이름) · 끝난 탭은 아님', () => {
    expect(limitOf(u, tab({ account: 'bbbbbbbbbbbb' }), 0, srv)).toBeNull()
    useAgentStore.setState({ limitById: { s1: true } })
    expect(limitOf(u, tab({ account: 'bbbbbbbbbbbb' }), 0, srv)).toEqual({ resetsAt: null, label: '업무 B' })
    expect(limitOf(u, tab({ account: 'bbbbbbbbbbbb', exited: true }), 0, srv)).toBeNull()
    useAgentStore.setState({ limitById: { s1: false } })
    expect(limitOf(u, tab({ account: 'bbbbbbbbbbbb' }), 0, srv)).toBeNull()
  })
})
