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
import { listAraChats, listApiChats } from '../ai/araChats'
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
  handle('ara:chats', () => {
    const names = ws.get().ui.araChatNames ?? {}
    /**
     * **어느 폴더의 대화를 보여 주나** — 2026-08-26 준영님 제보 *"이전 대화 목록 누르면 아무것도
     * 안나와"* 를 판 자리다.
     *
     * Claude Code 는 기록을 **작업 폴더별로** 나눠 둔다. 처음엔 "지금 대화의 폴더" 하나만 봤는데,
     * 아라를 서버 탭에서 열면 그 폴더가 `D:\어떤프로젝트` 로 잡히고 정작 아라 대화 대부분이 있는
     * 아라 폴더는 안 보인다 — 사용자에게는 그냥 "빈 목록"이다.
     *
     * 사람이 기대하는 것은 **내 아라 대화 전부**다. 그래서 아라 폴더(늘 여기다)와 지금 폴더를
     * 함께 본다. `~/.claude/projects` 전체를 훑지는 않는다 — 거기에는 이 앱과 무관한 대화도 있다.
     */
    const dirs = new Set([deps.araCwd(), ...(chat.cwd() ? [chat.cwd() as string] : [])])
    const cli = [...dirs].flatMap((d) => listAraChats(d, names))
    // API 는 우리가 남긴 것(폴더가 하나다 — 작업 폴더 개념이 없다).
    const api = deps.apiChatDir ? listApiChats(deps.apiChatDir(), names) : []
    // 같은 대화가 두 번 오지 않게(폴더 둘이 겹칠 수 있다) id 로 접는다.
    const byId = new Map([...cli, ...api].map((r) => [r.id, r]))
    return { items: [...byId.values()].sort((a, b) => b.at - a.at) }
  })
  handle('ara:renameChat', ({ id, name }) => {
    ws.setAraChatName(id, typeof name === 'string' ? name : '')
    return { ok: true } as const
  })

  return { chat }
}
