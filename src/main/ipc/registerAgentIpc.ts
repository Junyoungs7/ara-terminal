// F1a 에이전트 상태 IPC — 훅 서버·훅 설치를 묶고 화면으로 내보내는 자리.
//
// 렌더러는 상태를 **받아 그리기만** 한다: 상태를 만드는 것은 CLI 의 훅이고, 원장은 main 에 있다.
// (`aiSessions.ts` 가 세션 목록·마지막 출력으로 스스로 판정하던 시절과 갈리는 지점이 이것이다.)
import { type WebContents } from 'electron'
import { handle } from './handle'
import type { AgentHookState } from '@shared/agentStatus'
import { createAgentHookServer, type AgentHookServerHandle } from '../agent/AgentHookServer'
import { installClaudeHooks } from '../agent/claudeHooks'
import { pushSend } from '../util/windowPush'

/** 훅이 POST 할 주소를 셸에 알려 주는 env. 비밀이 아니다(토큰은 훅 설정 파일에만 산다). */
export const HOOK_PORT_ENV = 'ARA_HOOK_PORT'

export type AgentRuntime = {
  server: AgentHookServerHandle
  /** 훅 서버를 띄우고 포트를 env 에 심는다. **로컬 셸을 만들기 전에** 끝나야 한다. */
  start(): Promise<number>
}

export function registerAgentIpc(
  /** `~/.claude/settings.json` 의 홈. app.getPath('home') 을 그대로 받는다(e2e 는 임시 폴더 — 아래 호출부). */
  home: string,
  getWebContents: () => WebContents | null
): AgentRuntime {
  // 설치 결과는 기동 시 한 번 정해지고 그대로 화면이 말한다. 재시도 버튼을 만들지 않는다 —
  // 실패 사유(깨진 JSON·쓰기 불가)는 앱이 고칠 수 있는 것이 아니라 사람이 고칠 것이다.
  const { install, token } = installClaudeHooks(home)
  const server = createAgentHookServer({ token, onStatus: (s) => pushSend(getWebContents(), 'agent:status', s) })

  const state = (): AgentHookState => ({ port: server.port(), install, statuses: server.statuses() })
  handle('agent:state', () => state())

  return {
    server,
    async start() {
      const port = await server.start()
      // 포트를 못 잡아도 앱은 뜬다 — 그때 상태는 전부 `unverifiable` 이고 화면이 그렇게 말한다.
      if (port > 0) process.env[HOOK_PORT_ENV] = String(port)
      return port
    }
  }
}
