// M15 R1 연동(IN-01 GitLab · IN-02 Slack) — 기능 틀(docs/feature-module.md)의 main 등록 함수.
// 설정 userData/integrations.json(켜기·주소·채널·사용자), 토큰은 vault(safeStorage — secrets.vault). 렌더러에는 토큰이 '있다/없다'만 간다.
// **꺼져 있으면 네트워크 호출 0**: GitLab 은 켜져 있을 때 사람이 부른 IPC 에서만, Slack 은 켜고 토큰이 둘 다 있을 때만 소켓을 연다.
import { basename } from 'node:path'
import { net, type WebContents } from 'electron'
import { AGENTS, isAgentId } from '@shared/agents'
import type { AgentStatusView } from '@shared/agentHooks'
import type { AskAnswerKeyGroup } from '@shared/agentAsk'
import { integrationsPrefsOf, normalizeBaseUrl, projectPathFor, type GitLabResult, type IntegrationsPrefs, type IntegrationsState, type SlackLink } from '@shared/integrations'
import { handle } from '../ipc/handle'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { runProcess } from '../util/runProcess'
import { pushSend } from '../util/windowPush'
import { createGitLabClient, type FetchLike } from './gitlab'
import { startSlackSocket, type SlackFetch, type SlackSocket } from './slack'
import { createConnectorSeam, type ConnectorHost, type ConnectorSeam } from './connector'
import { describeCard, describeTurnEnd, isSlackCommand, runSlackCommand, type SlackTab } from './slackCommands'

const V_GITLAB = 'gitlab.token'
const V_SLACK_APP = 'slack.appToken'
const V_SLACK_BOT = 'slack.botToken'
/** 알림·턴 결과용 상태 훑기 간격 — Slack 이 붙어 있을 때만 돈다. */
const NOTIFY_POLL_MS = 3000
const GIT_TIMEOUT_MS = 5000

type Vault = { get(k: string): string | null; set(k: string, v: string): void; delete(k: string): void; has(k: string): boolean }
export type AgentsLink = {
  views(): AgentStatusView[]
  tabs(): { sessionId: string; agent: string; cwd: string }[]
  answer(sessionId: string, groups: AskAnswerKeyGroup[]): { ok: boolean }
  /** IN-02b 이어 지시 — M3 안전 입력(채팅·첫 지시와 같은 길). */
  followUp(sessionId: string, text: string): { ok: boolean }
  /** IN-02b 턴 결과 — 탭 화면 글. */
  screen(sessionId: string): Promise<string>
}

export function registerIntegrationsFeature(deps: {
  userData: string
  vault: Vault
  fetch?: FetchLike & SlackFetch
  mainWc: () => WebContents | null
  agents: () => AgentsLink | null
  /** IN-02b 시작 — ara CLI agent.launch(앱의 [+] 와 같은 길). 없으면 시작은 실패 답. */
  launch?: ConnectorHost['launch']
  /** 시험용 Slack API 주소(모의 서버). */
  slackApi?: string
}): { stop(): void } {
  const fetch = deps.fetch ?? (((url, init) => net.fetch(url, init)) as FetchLike & SlackFetch)
  const file = `${deps.userData}/integrations.json`
  let prefs: IntegrationsPrefs = integrationsPrefsOf(readJsonWithBackup<unknown>(file, null))
  let link: SlackLink = 'off'
  let linkError: string | undefined
  let socket: SlackSocket | null = null
  let poll: ReturnType<typeof setInterval> | null = null

  // 앱 잠금으로 켰으면(locked-startup) vault 가 던진다 — 그때는 '없음'으로 본다.
  const secret = (k: string): string | null => {
    try {
      return deps.vault.get(k)
    } catch {
      return null
    }
  }
  const has = (k: string): boolean => {
    try {
      return deps.vault.has(k)
    } catch {
      return false
    }
  }
  const putSecret = (k: string, v: string | undefined): void => {
    if (v === undefined) return
    if (v.trim()) deps.vault.set(k, v.trim())
    else deps.vault.delete(k)
  }

  const state = (): IntegrationsState => ({
    gitlab: { ...prefs.gitlab, hasToken: has(V_GITLAB) },
    slack: { ...prefs.slack, hasAppToken: has(V_SLACK_APP), hasBotToken: has(V_SLACK_BOT), link, ...(linkError ? { error: linkError } : {}) }
  })
  const push = (): void => pushSend(deps.mainWc(), 'integrations:update', state())
  const save = (next: IntegrationsPrefs): void => {
    prefs = integrationsPrefsOf(next)
    writeJsonAtomic(file, prefs)
  }

  // ── Slack ──
  const slackTabs = (): SlackTab[] => {
    const a = deps.agents()
    if (!a) return []
    const views = new Map(a.views().map((v) => [v.sessionId, v]))
    return a.tabs().map((t, i) => {
      const v = views.get(t.sessionId)
      const label = `${isAgentId(t.agent) ? AGENTS[t.agent].label : t.agent} · ${basename(t.cwd)}${v?.title ? ` (${v.title})` : ''}`
      return { n: i + 1, sessionId: t.sessionId, label, agent: t.agent, state: v?.state ?? null, ...(v?.ask ? { ask: v.ask } : {}) }
    })
  }
  // IN-02b 커넥터 이음새(connector.ts) — Slack 은 그 위의 운반 하나. 시작·지시는 allowRun 스위치(기본 꺼짐).
  const seam: ConnectorSeam = createConnectorSeam(
    {
      tabs: slackTabs,
      answer: (id, groups) => deps.agents()?.answer(id, groups) ?? { ok: false },
      followUp: (id, text) => deps.agents()?.followUp(id, text) ?? { ok: false },
      screen: async (id) => (await deps.agents()?.screen(id)) ?? '',
      launch: (req) => (deps.launch ? deps.launch(req) : Promise.resolve({ ok: false as const, error: '아라가 아직 준비되지 않았습니다.' }))
    },
    { allowRun: () => prefs.slack.allowRun }
  )
  /** 대화 키 ↔ Slack 스레드: externalId = "<채널> <스레드 ts>". */
  const threadOf = (externalId: string): { channel: string; ts: string } => {
    const [channel = '', ts = ''] = externalId.split(' ')
    return { channel, ts }
  }
  // Orca watch — 이어진 대화는 그 스레드로(늘), 나머지는 알림 채널로(상태 알림이 켜졌을 때만).
  let ticking = false
  const watch = async (): Promise<void> => {
    if (ticking || !socket) return
    ticking = true
    try {
      for (const ev of await seam.tick()) {
        const text = ev.kind === 'prompt' ? describeCard(ev.tab) : describeTurnEnd(ev.tab, ev.lastOutput)
        if (!text || !socket) continue
        if (ev.key) {
          const t = threadOf(ev.key.externalId)
          void socket.post(t.channel, text, t.ts)
        } else if (prefs.slack.notify && prefs.slack.channel) void socket.post(prefs.slack.channel, text)
      }
    } finally {
      ticking = false
    }
  }
  const stopSlack = (): void => {
    if (poll) clearInterval(poll)
    poll = null
    seam.reset()
    socket?.stop()
    socket = null
    link = 'off'
    linkError = undefined
  }
  const startSlack = (): void => {
    stopSlack()
    const app = secret(V_SLACK_APP)
    const bot = secret(V_SLACK_BOT)
    if (!prefs.slack.enabled || !app || !bot) return
    const sock = startSlackSocket({
      fetch,
      appToken: app,
      botToken: bot,
      ...(deps.slackApi ? { apiBase: deps.slackApi } : {}),
      onLink: (l, error) => {
        if (socket !== sock && l !== 'off') return
        link = l
        linkError = error
        push()
      },
      onMessage: (m) => {
        // 명령 권한 = 지정 사용자만(비면 아무도). 자리 = 지정 채널 또는 DM.
        if (!prefs.slack.users.includes(m.user)) return
        const dm = m.channelType === 'im'
        if (!dm && m.channel !== prefs.slack.channel) return
        if (!dm && !isSlackCommand(m.text)) return
        const thread = m.threadTs ?? m.ts
        // 배달 id = 글 ts(Slack 이 같은 봉투를 다시 보내도 한 번만 실행).
        void runSlackCommand(m.text, seam, { key: { source: 'slack', externalId: `${m.channel} ${thread}` }, deliveryId: m.ts }).then((text) => sock.post(m.channel, text, thread))
      }
    })
    socket = sock
    // 이어진 스레드의 턴 결과는 알림을 꺼도 간다 — 붙어 있는 동안 늘 훑는다.
    poll = setInterval(() => void watch(), NOTIFY_POLL_MS)
  }

  // ── GitLab ──
  const gitlab = (): ReturnType<typeof createGitLabClient> | { off: string } => {
    if (!prefs.gitlab.enabled || !prefs.gitlab.baseUrl) return { off: 'off' }
    const token = secret(V_GITLAB)
    return token ? createGitLabClient(fetch, prefs.gitlab.baseUrl, token) : { off: 'noToken' }
  }
  const git = async (cwd: string, args: string[]): Promise<string | null> => {
    const r = await runProcess('git', ['-C', cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS })
    return r.error || r.code !== 0 ? null : r.stdout.trim()
  }
  /** 이 폴더의 origin → 이 GitLab 안 프로젝트 경로. 다른 호스트면 토큰을 안 보낸다. */
  const project = async (cwd: unknown): Promise<GitLabResult<{ project: string }>> => {
    if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'noRemote' }
    const url = await git(cwd, ['remote', 'get-url', 'origin'])
    if (!url) return { ok: false, error: 'noRemote' }
    const p = projectPathFor(prefs.gitlab.baseUrl, url)
    return p ? { ok: true, project: p } : { ok: false, error: 'otherHost' }
  }

  handle('integrations:get', () => state())
  handle('integrations:setGitlab', (req) => {
    putSecret(V_GITLAB, req.token)
    save({ ...prefs, gitlab: { enabled: req.enabled === true, baseUrl: normalizeBaseUrl(req.baseUrl) } })
    push() // 소스 제어의 MR 목록·MR 만들기는 따로 구독한다 — 알리지 않으면 켜도 안 나타난다.
    return state()
  })
  handle('integrations:setSlack', (req) => {
    putSecret(V_SLACK_APP, req.appToken)
    putSecret(V_SLACK_BOT, req.botToken)
    save({ ...prefs, slack: { enabled: req.enabled === true, channel: req.channel, users: req.users, notify: req.notify, allowRun: req.allowRun === true } })
    startSlack()
    return state()
  })
  handle('gitlab:test', async () => {
    const c = gitlab()
    return 'off' in c ? { ok: false, error: c.off } : c.viewer()
  })
  handle('gitlab:mrs', async ({ cwd, state: st }) => {
    const c = gitlab()
    if ('off' in c) return { ok: false, error: c.off }
    const p = await project(cwd)
    if (!p.ok) return p
    const r = await c.listMrs(p.project, st === 'merged' || st === 'closed' || st === 'all' ? st : 'opened')
    return r.ok ? { ok: true, project: p.project, mrs: r.mrs } : r
  })
  // MR 만들기 — 사람이 [MR 만들기]를 누를 때만 온다. 푸시는 하지 않는다(브랜치가 원격에 없으면 GitLab 이 거절 → 그 말을 보여 준다).
  handle('gitlab:createMr', async ({ cwd, title, description, target }) => {
    const c = gitlab()
    if ('off' in c) return { ok: false, error: c.off }
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'emptyTitle' }
    const p = await project(cwd)
    if (!p.ok) return p
    const source = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!source || source === 'HEAD') return { ok: false, error: 'detached' }
    const tgt = (typeof target === 'string' ? target : '').replace(/^origin\//, '').trim()
    if (!tgt) return { ok: false, error: 'noTarget' }
    const r = await c.createMr(p.project, { source, target: tgt, title: title.trim(), description: typeof description === 'string' ? description : '' })
    return r.ok ? { ok: true, mr: r.mr } : r
  })

  startSlack()
  return { stop: stopSlack }
}
