/**
 * 아라 대화 IPC(#125) — 화면과 엔진 사이의 유일한 통로.
 *
 * 이 파일에는 **판단이 없다.** 대화 한 벌의 규칙은 AraChat 이 갖고(#124), 프로세스 수명은
 * 엔진이 갖는다(#123). 여기는 채널 이름을 이 파일 안에만 두고 사건을 창으로 올릴 뿐이다
 * (registerRemoteIpc·registerMcpIpc 와 같은 형태).
 */
import { type WebContents } from 'electron'
import { handle } from './handle'
import { createAraChat, type AraChat, type AraChatDeps } from '../ai/AraChat'
import { pushSend } from '../util/windowPush'
import { araModelOf } from '@shared/aiModels'
import { listAraChats } from '../ai/araChats'
import type { WorkspaceStore } from '../workspace/WorkspaceStore'

export type AraRuntime = { chat: AraChat }

export function registerAraIpc(
  deps: Omit<AraChatDeps, 'emit'>,
  getWebContents: () => WebContents | null,
  /** 대화 이름 저장소(2026-08-26). AraChat 은 이걸 모른다 — 이름은 화면의 일이라 여기서만 다룬다. */
  ws: WorkspaceStore
): AraRuntime {
  const chat = createAraChat({
    ...deps,
    emit: (e) => pushSend(getWebContents(), 'ara:event', e)
  })

  handle('ara:open', ({ cwd, resumeId, active, engine }) =>
    chat.open({
      ...(cwd ? { cwd } : {}),
      ...(resumeId ? { resumeId } : {}),
      ...(active === undefined ? {} : { active }),
      ...(engine === 'api' ? { engine: 'api' as const } : {})
    })
  )
  handle('ara:send', ({ text }) => {
    chat.send(text)
    return { ok: true } as const
  })
  handle('ara:planMode', ({ on }) => {
    chat.setPlanMode(on === true)
    return { ok: true } as const
  })
  handle('ara:approvePlan', () => {
    chat.approvePlan()
    return { ok: true } as const
  })
  handle('ara:model', ({ model }) => {
    chat.setModel(araModelOf(model))
    return { ok: true } as const
  })
  handle('ara:interrupt', () => {
    chat.interrupt()
    return { ok: true } as const
  })
  handle('ara:close', () => {
    chat.close()
    return { ok: true } as const
  })
  // 화면이 다시 붙을 때(패널을 닫았다 열거나 창을 새로 그릴 때) 지금 상태를 묻는다.
  handle('ara:state', () => ({ open: chat.isOpen(), resumeId: chat.resumeId(), pending: chat.pending() }))

  /**
   * 지난 대화 목록(2026-08-26 준영님 요청). **Claude Code 의 기록을 읽기만 한다** — 우리 형식으로
   * 다시 저장하면 두 벌이 되고 CLI 가 형식을 바꾸는 날 조용히 어긋난다(araChats.ts 주석).
   *
   * 어느 폴더의 목록인가: 지금 열려 있는 대화의 작업 폴더. 아직 안 열었으면 기본 자리를 본다 —
   * 그게 아라를 그냥 열었을 때 가는 곳이라 사용자가 기대하는 목록과 같다.
   */
  handle('ara:chats', () => ({
    items: listAraChats(chat.cwd() ?? deps.araCwd(), ws.get().ui.araChatNames ?? {})
  }))
  handle('ara:renameChat', ({ id, name }) => {
    ws.setAraChatName(id, typeof name === 'string' ? name : '')
    return { ok: true } as const
  })

  return { chat }
}
