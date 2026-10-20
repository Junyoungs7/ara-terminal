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
import type { AraTarget } from '@shared/araPersona'
import { listAraChats, listApiChats, projectDir, readChatMessages } from '../ai/araChats'
import { chatPath } from '../ai/apiChatLog'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 대화 id 의 유일한 모양(UUID). 두 곳이 이걸 본다:
 *  · 파일명으로 폴더 밖에 못 나가게 — apiChatLog.chatPath 와 같은 규칙.
 *  · `--resume <id>` 로 **엔진의 argv 에 들어가는 값**이다(ClaudeCliEngine.realSpawn 이 `shell:true`
 *    를 버리고 cmd 를 직접 부른 뒤로 인용은 #152 인코더가 지킨다). 인코더 하나에 기대는 것보다
 *    모양으로 막는 편이 싸다 — 정상 UI 로는 만들 수 없는 값이다.
 */
const NAME_OK = /^[0-9a-f-]{36}$/i
import type { WorkspaceStore } from '../workspace/WorkspaceStore'

/**
 * 이어서 열 대화 id. 모양이 아니면 null 이고, 그러면 **이어 열지 않고 새로 연다** —
 * 조용히 이상한 값을 `--resume` 뒤에 싣는 것보다 낫다(못 이어받는 것은 화면에서 바로 보인다).
 */
export function validResumeId(v: unknown): string | null {
  return typeof v === 'string' && NAME_OK.test(v) ? v : null
}

/**
 * 렌더러가 알린 활성 세션을 모양으로 거른다(신뢰 경계 밖). 모양이 아니면 null — "대상 없음"으로 읽힌다.
 */
export function araTargetOf(v: unknown): AraTarget | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '' || o.id.length > 200) return null
  if (o.type !== 'local' && o.type !== 'ssh' && o.type !== 'rdp') return null
  return {
    id: o.id,
    type: o.type,
    title: typeof o.title === 'string' ? o.title.slice(0, 200) : '',
    cwd: typeof o.cwd === 'string' && o.cwd !== '' ? o.cwd.slice(0, 1000) : null
  }
}

export type AraRuntime = {
  chat: AraChat
  /** 지금 보는 세션(렌더러의 마지막 보고). 승인 게이트가 자동 허용 대상을 여기서 본다. */
  active: () => AraTarget | null
}

export function registerAraIpc(
  deps: Omit<AraChatDeps, 'emit' | 'activeSession' | 'savedModel'>,
  getWebContents: () => WebContents | null,
  /** 대화 이름 저장소(2026-08-26). AraChat 은 이걸 모른다 — 이름은 화면의 일이라 여기서만 다룬다. */
  ws: WorkspaceStore,
  /** main 이 아는 세션인가(RDP 는 main 원장에 없어 모양만 본다). 모르는 id 는 "대상 없음"으로 읽는다. */
  hasSession: (id: string) => boolean
): AraRuntime {
  // 아라 채팅 v2: 지금 보는 세션. 렌더러가 탭이 바뀔 때마다 알린다(main 원장에는 "어느 탭을 보나"가 없다).
  let active: AraTarget | null = null
  const chat = createAraChat({
    ...deps,
    activeSession: () => active,
    savedModel: () => araModelOf(ws.get().ui.araModel),
    emit: (e) => pushSend(getWebContents(), 'ara:event', e)
  })

  handle('ara:active', ({ active: next }) => {
    const t = araTargetOf(next)
    active = t && (t.type === 'rdp' || hasSession(t.id)) ? t : null
    return { ok: true } as const
  })

  handle('ara:open', ({ cwd, resumeId, active: a, engine }) => {
    const rid = validResumeId(resumeId)
    // 엔진을 안 주면 **지난번에 고른 것**(아라 채팅 v2). 사람이 고른 것(이어 열기 제외)만 저장한다 —
    // 지난 대화를 열 때는 그 대화의 엔진을 따르는 것이지 사람이 엔진을 바꾼 것이 아니다.
    const picked = engine === 'api' || engine === 'cli' ? engine : null
    if (picked && !rid) ws.setAraPick({ engine: picked })
    const eng = picked ?? ws.get().ui.araEngine ?? 'cli'
    return chat.open({
      ...(cwd ? { cwd } : {}),
      ...(rid ? { resumeId: rid } : {}),
      ...(a === undefined ? {} : { active: a }),
      ...(eng === 'api' ? { engine: 'api' as const } : {})
    })
  })
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
    const m = araModelOf(model)
    ws.setAraPick({ model: m })
    chat.setModel(m)
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
  /**
   * 이어서 열 때 화면을 채울 지난 말들(2026-08-26 제보: *"클릭하면 여전히 아무것도 안나와"*).
   * `--resume` 은 문맥만 이어받고 지난 메시지를 다시 보내 주지 않는다 — 화면은 우리가 그린다.
   *
   * 어느 저장소에 있는지는 **찾아본다**: 목록이 두 곳을 합쳐 보여 주므로 id 만으로는 알 수 없다.
   */
  handle('ara:chatLog', ({ id }) => {
    const cand: (string | null)[] = [
      deps.apiChatDir ? chatPath(deps.apiChatDir(), id) : null,
      ...[...new Set([deps.araCwd(), ...(chat.cwd() ? [chat.cwd() as string] : [])])].map((d) =>
        NAME_OK.test(id) ? join(projectDir(d), `${id}.jsonl`) : null
      )
    ]
    for (const p of cand) {
      if (!p || !existsSync(p)) continue
      const items = readChatMessages(p)
      if (items.length) return { items }
    }
    return { items: [] }
  })

  handle('ara:renameChat', ({ id, name }) => {
    ws.setAraChatName(id, typeof name === 'string' ? name : '')
    return { ok: true } as const
  })

  return { chat, active: () => active }
}
