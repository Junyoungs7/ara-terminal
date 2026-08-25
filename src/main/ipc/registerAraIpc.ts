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

export type AraRuntime = { chat: AraChat }

export function registerAraIpc(
  deps: Omit<AraChatDeps, 'emit'>,
  getWebContents: () => WebContents | null
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

  return { chat }
}
