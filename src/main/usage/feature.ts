// M9 AI-10 사용량 — 기능 틀(docs/feature-module.md)의 main 등록 함수. IPC `usage:get`·`usage:refresh`, 창 push `usage:update`.
// 갱신(Orca service-polling·service-configuration): 시작 1초 뒤 한 번(창이 활성일 때), 창이 포커스를 받을 때 refreshPlan 대로,
// 15분마다(창이 보이고 포커스가 있을 때만). 사람이 팝오버에서 누르면 바로. 상시 폴러는 이 15분 타이머 하나뿐이다.
// M13: %사용/%남음·Gemini 켜기(userData/usage-prefs.json), 계정 여러 개(accounts.ts — 고른 계정 폴더의 자격으로 묻는다),
//  컨텍스트 사용량(statusLine context_window → 탭별), 통계(stats.ts — 열 때만 utility process).
import { app, net, type BrowserWindow, type WebContents } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_POLL_MS, parseClaudeContext, parseClaudeStatusLine, usagePrefsOf, type AccountProvider, type UsagePrefs } from '@shared/usage'
import { firstCommandPath } from '@shared/agents'
import { handle } from '../ipc/handle'
import { readJsonWithBackup, writeJsonAtomic } from '../util/atomicJson'
import { runProcess } from '../util/runProcess'
import { pushSend } from '../util/windowPush'
import { createAccountsFeature, type AccountsFeature } from './accounts'
import type { PostLike } from './gemini'
import { createUsageService, type FetchLike, type UsageService } from './service'
import { createStatsFeature, type StatsFeature } from './stats'

const STARTUP_DELAY_MS = 1000

export type UsageFeature = {
  service: UsageService
  accounts: AccountsFeature
  stats: StatsFeature
  /** 에이전트 탭 Claude statusLine 입력 — 사용량(rate_limits, 그 탭의 계정이 고른 계정일 때만)·컨텍스트(context_window). */
  ingestStatusLine(payload: Record<string, unknown>, pane?: string): void
}

export function registerUsageFeature(deps: {
  /** 자격 파일을 찾을 홈. e2e 는 임시 홈 — 사용자 실제 ~/.claude·~/.codex 를 읽지 않는다. */
  home: string
  /** CLAUDE_CONFIG_DIR·CODEX_HOME 을 볼 환경(e2e 는 빈 객체). */
  env: Record<string, string | undefined>
  userData: string
  mainWindow: () => BrowserWindow | null
  mainWc: () => WebContents | null
}): UsageFeature {
  const active = (): boolean => {
    const w = deps.mainWindow()
    try {
      return Boolean(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused())
    } catch {
      return false
    }
  }
  const defaultDir = (p: AccountProvider): string => (p === 'claude' ? deps.env['CLAUDE_CONFIG_DIR'] || join(deps.home, '.claude') : deps.env['CODEX_HOME'] || join(deps.home, '.codex'))
  const prefsFile = join(deps.userData, 'usage-prefs.json')
  let service: UsageService | null = null
  const accounts = createAccountsFeature({ userData: deps.userData, defaultDir, onChange: (v) => service?.setAccounts(v) })
  // gemini 실행 파일(토큰 새로 받기용 OAuth 클라이언트 값을 그 패키지에서 읽는다) — 처음 한 번 찾는다.
  let geminiBin: Promise<string | null> | null = null
  const win = process.platform === 'win32'
  service = createUsageService({
    claudeDir: () => accounts.dir('claude') ?? defaultDir('claude'),
    codexDir: () => accounts.dir('codex') ?? defaultDir('codex'),
    fetch: ((url, init) => net.fetch(url, init)) as FetchLike,
    gemini: {
      dir: () => join(deps.home, '.gemini'),
      post: ((url, init) => net.fetch(url, init)) as PostLike,
      bin: () => (geminiBin ??= runProcess(win ? 'where' : 'which', ['gemini'], { timeoutMs: 4000 }).then((r) => (r.error ? null : firstCommandPath(r.stdout, win))))
    },
    accounts: accounts.view(),
    prefs: usagePrefsOf(readJsonWithBackup<unknown>(prefsFile, null)),
    push: (s) => pushSend(deps.mainWc(), 'usage:update', s),
    windowActive: active
  })
  const svc = service
  const stats = createStatsFeature({
    userData: deps.userData,
    dirs: () => ({
      claude: [defaultDir('claude'), ...accounts.view().claude.list.map((a) => accounts.dir('claude', a.id)!)],
      codex: [defaultDir('codex'), ...accounts.view().codex.list.map((a) => accounts.dir('codex', a.id)!)]
    })
  })
  app.on('before-quit', () => stats.flush())

  handle('usage:get', () => svc.state())
  handle('usage:refresh', () => svc.refresh(true))
  handle('usage:setPrefs', (p: UsagePrefs) => {
    const next = usagePrefsOf(p)
    writeJsonAtomic(prefsFile, next)
    svc.setPrefs(next)
    return svc.state()
  })
  handle('usage:account', async (a) => {
    if (!a || (a.provider !== 'claude' && a.provider !== 'codex')) return { ok: false, error: '모르는 계정 종류' }
    if (a.op === 'add') return { ok: true, id: accounts.add(a.provider, a.label) }
    if (a.op === 'remove') accounts.remove(a.provider, a.id)
    else if (a.op === 'rename') accounts.rename(a.provider, a.id, a.label)
    else if (a.op === 'select') accounts.select(a.provider, a.id)
    else if (a.op === 'loginCode' || a.op === 'loginRetry' || a.op === 'loginCancel') {
      const ok = accounts.loginCtl(a.provider, a.id, a.op === 'loginCode' ? { op: 'code', code: String(a.code ?? '') } : { op: a.op === 'loginRetry' ? 'retry' : 'cancel' })
      return ok ? { ok: true } : { ok: false, error: '진행 중인 로그인이 없습니다' }
    } else if (a.op === 'login') {
      const r = await accounts.login(a.provider, a.id)
      // 고른 계정에 로그인했으면 바로 다시 묻는다.
      if (r.ok && accounts.view()[a.provider].active === a.id) void svc.refresh(true)
      return r
    }
    return { ok: true }
  })
  handle('usage:accountUsage', ({ provider, id }) => {
    const dir = id === null ? defaultDir(provider) : accounts.dir(provider, id)
    if (!dir) return { provider, session: null, weekly: null, updatedAt: Date.now(), status: 'error', failure: 'missing-credentials' }
    const cur = svc.state()[provider]
    return id === accounts.view()[provider].active && cur && cur.status !== 'fetching' ? cur : svc.accountUsage(provider, dir)
  })
  handle('usage:stats', async ({ force } = {}) => {
    try {
      return { summary: stats.summary(), report: await stats.report(force === true) }
    } catch (e) {
      return { summary: stats.summary(), report: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

  app.on('browser-window-focus', (_e, w) => {
    if (w === deps.mainWindow() && active()) void svc.refresh()
  })
  setTimeout(() => {
    if (active()) void svc.refresh()
  }, STARTUP_DELAY_MS)
  setInterval(() => void svc.poll(), DEFAULT_POLL_MS)

  /** transcript_path 가 아라 계정 폴더 안이면 그 계정, 아니면 시스템 기본(null). */
  const claudeAccountOf = (payload: Record<string, unknown>): string | null => {
    const tp = payload['transcript_path']
    if (typeof tp !== 'string' || !tp) return null
    for (const a of accounts.view().claude.list) {
      const rel = relative(resolve(accounts.dir('claude', a.id)!), resolve(tp))
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return a.id
    }
    return null
  }
  return {
    service: svc,
    accounts,
    stats,
    ingestStatusLine(payload, pane) {
      const w = parseClaudeStatusLine(payload)
      if (w) svc.ingestClaudeLive(w, claudeAccountOf(payload))
      const c = pane ? parseClaudeContext(payload, Date.now()) : null
      if (c && pane) svc.ingestContext(pane, c)
    }
  }
}
