// M13 사용량·계정 2차 — %사용/%남음(Orca usage-percentage-display 시험 옮김), Gemini 할당량(모의 네트워크·가짜 자격은 임시 폴더),
// 컨텍스트 사용량, 통계(transcript 파싱·임시 폴더 스캔·에이전트 요약), 계정 여러 개(임시 userData — 사용자 ~/.claude·~/.codex 안 건드림).
// 실제 엔드포인트·실제 자격 파일·실제 CLI 를 쓰지 않는다.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ utilityProcess: { fork: () => { throw new Error('시험은 fork 하지 않는다') } } }))

import {
  displayedPercent,
  normalizeUsagePercentageDisplay,
  parseClaudeContext,
  parseGeminiQuota,
  refreshPlan,
  tightestBucket,
  usagePrefsOf,
  EMPTY_ACCOUNTS,
  EMPTY_USAGE,
  MAX_CONTEXT_ENTRIES,
  type AccountsView,
  type UsageState
} from '../src/shared/usage'
import { aggregateTurns, daySeries, dayOf, formatDuration, formatTokens, parseClaudeLine, parseCodexLine, type CodexCtx } from '../src/shared/usageStats'
import { createUsageService, CLAUDE_USAGE_URL, type FetchLike } from '../src/main/usage/service'
import { fetchGeminiUsage, findOAuthClient, GEMINI_LOAD_URL, GEMINI_QUOTA_URL, GOOGLE_TOKEN_URL, type PostLike } from '../src/main/usage/gemini'
import { scanUsage } from '../src/main/usage/statsScan'
import { createStatsFeature } from '../src/main/usage/stats'
import { createAccountsFeature } from '../src/main/usage/accounts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-m13-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const NOW = Date.UTC(2026, 10, 2, 3, 0, 0)
const FAKE = 'fake-token-for-test'

describe('%사용/%남음(Orca usage-percentage-display.test 옮김)', () => {
  it('모르는 저장값은 used', () => {
    expect(normalizeUsagePercentageDisplay(undefined)).toBe('used')
    expect(normalizeUsagePercentageDisplay('left')).toBe('used')
    expect(usagePrefsOf({ display: 'remaining', gemini: 'yes' })).toEqual({ display: 'remaining', gemini: false })
  })
  it('사용 % 그대로 또는 그 보수', () => {
    expect(displayedPercent(6, 'used')).toBe(6)
    expect(displayedPercent(6, 'remaining')).toBe(94)
  })
  it('반올림한 사용 % 를 뒤집는다(20.5 → 79 남음), 범위 밖·NaN', () => {
    expect(displayedPercent(20.5, 'used')).toBe(21)
    expect(displayedPercent(20.5, 'remaining')).toBe(79)
    expect(displayedPercent(120, 'remaining')).toBe(0)
    expect(displayedPercent(-20, 'used')).toBe(0)
    expect(displayedPercent(Number.NaN, 'remaining')).toBe(0)
  })
})

describe('Gemini 할당량', () => {
  it('배열·{buckets} 둘 다, 사용 % = (1-남은 비율)·100, 같은 %·초기화는 하나로(이름표 모델 우선)', () => {
    const reset = '2026-11-03T00:00:00Z'
    const b = parseGeminiQuota({
      buckets: [
        { remainingFraction: 0.75, resetTime: reset, modelId: 'gemini-2.5-pro-preview' },
        { remainingFraction: 0.75, resetTime: reset, modelId: 'gemini-2.5-pro' },
        { remainingFraction: 0.1, resetTime: reset, modelId: 'gemini-2.5-flash' },
        { remainingFraction: 'x', resetTime: reset, modelId: 'bad' }
      ]
    })
    expect(b).toEqual([
      { name: 'Pro', usedPercent: 25, resetsAt: Date.parse(reset) },
      { name: 'Flash', usedPercent: 90, resetsAt: Date.parse(reset) }
    ])
    expect(parseGeminiQuota([{ remainingFraction: 1, resetTime: 'nope', modelId: 'gemini-9-ultra' }])).toEqual([{ name: '9 Ultra', usedPercent: 0, resetsAt: null }])
    expect(parseGeminiQuota(null)).toEqual([])
    expect(tightestBucket(b)).toEqual({ usedPercent: 90, windowMinutes: 1440, resetsAt: Date.parse(reset) })
    expect(tightestBucket([])).toBeNull()
  })

  const creds = (dir: string, expiry: number) => writeFileSync(join(dir, 'oauth_creds.json'), JSON.stringify({ access_token: FAKE, refresh_token: 'r-' + FAKE, expiry_date: expiry }))
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  it('자격 없음 → 요청 없이 missing-credentials', async () => {
    const calls: string[] = []
    const r = await fetchGeminiUsage({ dir: tmp(), post: async (u) => (calls.push(u), ok({})), geminiBin: async () => null, now: () => NOW })
    expect(r).toMatchObject({ provider: 'gemini', status: 'error', failure: 'missing-credentials' })
    expect(calls).toEqual([])
  })
  it('유효 토큰 → loadCodeAssist → retrieveUserQuota(프로젝트), 자격 파일은 그대로(쓰지 않음), 결과에 토큰 없음', async () => {
    const d = tmp()
    creds(d, NOW + 3_600_000)
    const before = readFileSync(join(d, 'oauth_creds.json'), 'utf8')
    const calls: { url: string; auth?: string; body: string }[] = []
    const post: PostLike = async (url, init) => {
      calls.push({ url, auth: init.headers['Authorization'], body: init.body })
      return url === GEMINI_LOAD_URL ? ok({ cloudaicompanionProject: 'proj-1' }) : ok([{ remainingFraction: 0.4, resetTime: '2026-11-03T00:00:00Z', modelId: 'gemini-2.5-pro' }])
    }
    const r = await fetchGeminiUsage({ dir: d, post, geminiBin: async () => null, now: () => NOW })
    expect(calls.map((c) => c.url)).toEqual([GEMINI_LOAD_URL, GEMINI_QUOTA_URL])
    expect(calls[0].auth).toBe(`Bearer ${FAKE}`)
    expect(JSON.parse(calls[1].body)).toEqual({ project: 'proj-1' })
    expect(r).toMatchObject({ status: 'ok', session: { usedPercent: 60 }, buckets: [{ name: 'Pro', usedPercent: 60 }] })
    expect(JSON.stringify(r)).not.toContain(FAKE)
    expect(readFileSync(join(d, 'oauth_creds.json'), 'utf8')).toBe(before)
  })
  it('만료 토큰: gemini 패키지에서 클라이언트 값을 찾아 메모리에서만 새로 받는다 · 못 찾으면 stale-token', async () => {
    const d = tmp()
    creds(d, NOW - 1)
    expect((await fetchGeminiUsage({ dir: d, post: async () => ok({}), geminiBin: async () => null, now: () => NOW })).failure).toBe('stale-token')
    // 가짜 설치: <prefix>/node_modules/@google/gemini-cli/{package.json,bundle/x.js}, 실행 파일은 <prefix>/gemini.cmd
    const prefix = tmp()
    const pkg = join(prefix, 'node_modules', '@google', 'gemini-cli')
    mkdirSync(join(pkg, 'bundle'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@google/gemini-cli' }))
    writeFileSync(join(pkg, 'bundle', 'chunk-a.js'), 'var x=1;')
    writeFileSync(join(pkg, 'bundle', 'chunk-b.js'), 'const OAUTH_CLIENT_ID = "cid.apps"; const OAUTH_CLIENT_SECRET = "csecret";')
    writeFileSync(join(prefix, 'gemini.cmd'), '')
    expect(await findOAuthClient(join(prefix, 'gemini.cmd'))).toEqual({ clientId: 'cid.apps', clientSecret: 'csecret' })
    const before = readFileSync(join(d, 'oauth_creds.json'), 'utf8')
    const calls: { url: string; body: string; auth?: string }[] = []
    const post: PostLike = async (url, init) => {
      calls.push({ url, body: init.body, auth: init.headers['Authorization'] })
      if (url === GOOGLE_TOKEN_URL) return ok({ access_token: 'new-access' })
      return url === GEMINI_LOAD_URL ? ok({ cloudaicompanionProject: 'p' }) : ok({ buckets: [] })
    }
    const r = await fetchGeminiUsage({ dir: d, post, geminiBin: async () => join(prefix, 'gemini.cmd'), now: () => NOW })
    expect(calls[0].url).toBe(GOOGLE_TOKEN_URL)
    expect(new URLSearchParams(calls[0].body).get('client_id')).toBe('cid.apps')
    expect(calls[1].auth).toBe('Bearer new-access')
    expect(r.status).toBe('ok')
    expect(readFileSync(join(d, 'oauth_creds.json'), 'utf8')).toBe(before)
  })
  it('프로젝트 없는 계정 → usage-unavailable, 429 → rate-limited, 네트워크 → network', async () => {
    const d = tmp()
    creds(d, NOW + 3_600_000)
    expect((await fetchGeminiUsage({ dir: d, post: async () => ok({}), geminiBin: async () => null, now: () => NOW })).failure).toBe('usage-unavailable')
    expect((await fetchGeminiUsage({ dir: d, post: async () => ({ ok: false, status: 429, json: async () => ({}) }), geminiBin: async () => null, now: () => NOW })).failure).toBe('rate-limited')
    expect(
      (
        await fetchGeminiUsage({
          dir: d,
          post: async () => {
            throw new TypeError('fetch failed')
          },
          geminiBin: async () => null,
          now: () => NOW
        })
      ).failure
    ).toBe('network')
  })
})

describe('컨텍스트 사용량(statusLine context_window)', () => {
  it('used_percentage 우선, 없으면 current_usage / context_window_size, 둘 다 없으면 null', () => {
    expect(parseClaudeContext({ model: { display_name: 'Opus' }, context_window: { used_percentage: 42.5, context_window_size: 200000 } }, NOW)).toEqual({ usedPercent: 42.5, windowTokens: 200000, model: 'Opus', at: NOW })
    expect(
      parseClaudeContext({ context_window: { context_window_size: 1000, current_usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 50, output_tokens: 999 } } }, NOW)?.usedPercent
    ).toBe(20)
    expect(parseClaudeContext({ context_window: { total_input_tokens: 5 } }, NOW)).toBeNull()
    expect(parseClaudeContext({ rate_limits: {} }, NOW)).toBeNull()
  })
})

describe('통계 — transcript 파싱·합치기', () => {
  const claudeLine = (id: string, ts: string, usage: Record<string, number>, model = 'claude-opus-4') =>
    JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'req', message: { id, model, usage } })
  it('Claude: assistant 줄의 usage, 0 이면 null, 다른 줄 무시', () => {
    expect(parseClaudeLine(claudeLine('m1', '2026-11-01T01:00:00Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }))).toMatchObject({
      key: 'm1:req',
      turn: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7, turns: 1, model: 'claude-opus-4' }
    })
    expect(parseClaudeLine(claudeLine('m2', '2026-11-01T01:00:00Z', { input_tokens: 0 }))).toBeNull()
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: 'usage' } }))).toBeNull()
    expect(parseClaudeLine('{"usage": broken')).toBeNull()
  })
  it('Codex: turn_context 의 모델, last_token_usage(캐시는 입력에서 뺀다), 누계만 오면 차이, 같은 누계 재전송은 안 셈', () => {
    const ctx: CodexCtx = { model: null, prev: null }
    const tc = (info: unknown, ts = '2026-11-01T02:00:00Z') => JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info } })
    expect(parseCodexLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }), ctx)).toBeNull()
    const a = parseCodexLine(tc({ total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }), ctx)
    expect(a).toMatchObject({ model: 'gpt-5.6', input: 60, cacheRead: 40, output: 10 })
    expect(parseCodexLine(tc({ total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }), ctx)).toBeNull()
    expect(parseCodexLine(tc({ total_token_usage: { input_tokens: 150, cached_input_tokens: 40, output_tokens: 30 } }), ctx)).toMatchObject({ input: 50, cacheRead: 0, output: 20 })
    expect(parseCodexLine(tc(null), ctx)).toBeNull()
  })
  it('합치기: since 이전 빼기, 날짜별·모델별(많은 순)', () => {
    const t = (at: number, model: string, input: number) => ({ at, model, input, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 })
    const r = aggregateTurns([t(NOW, 'a', 10), t(NOW, 'b', 30), t(NOW - 86_400_000, 'a', 5), t(0, 'a', 999)], NOW - 2 * 86_400_000)
    expect(r.totals).toMatchObject({ input: 45, turns: 3 })
    expect(r.byModel.map((m) => m.model)).toEqual(['b', 'a'])
    expect(r.byDay[dayOf(NOW)]).toBe(40)
    const s = daySeries(r.byDay, NOW - 2 * 86_400_000, NOW)
    expect(s).toHaveLength(3)
    expect(s[2]).toEqual({ day: dayOf(NOW), tokens: 40 })
  })
  it('글자: 토큰·시간(Orca formatTokens·formatDuration)', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1234)).toBe('1.2K')
    expect(formatTokens(3_400_000)).toBe('3.4M')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(130 * 60_000)).toBe('2h 10m')
    expect(formatDuration(76 * 3_600_000)).toBe('3d 4h')
  })
  it('scanUsage(임시 폴더): Claude projects·Codex sessions, 같은 응답은 한 번(여러 줄·여러 파일), 오래된 파일은 안 연다', async () => {
    const claude = tmp()
    const codex = tmp()
    const now = Date.now()
    const ts = new Date(now - 3_600_000).toISOString()
    mkdirSync(join(claude, 'projects', 'p1', 's1', 'subagents'), { recursive: true })
    writeFileSync(
      join(claude, 'projects', 'p1', 's1.jsonl'),
      [claudeLine('m1', ts, { input_tokens: 1, output_tokens: 2 }), claudeLine('m1', ts, { input_tokens: 1, output_tokens: 20 }), 'garbage'].join('\n')
    )
    writeFileSync(join(claude, 'projects', 'p1', 's1', 'subagents', 'a.jsonl'), claudeLine('m1', ts, { input_tokens: 1, output_tokens: 20 }) + '\n' + claudeLine('m9', ts, { input_tokens: 4 }, 'claude-haiku'))
    mkdirSync(join(codex, 'sessions', '2026', '11', '01'), { recursive: true })
    writeFileSync(
      join(codex, 'sessions', '2026', '11', '01', 'rollout-x.jsonl'),
      [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6' } }), JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 3 } } } })].join('\n')
    )
    const r = await scanUsage({ claude: [claude, claude], codex: [codex] }, now - 30 * 86_400_000, now)
    expect(r.files).toBe(3)
    expect(r.claude.totals).toMatchObject({ input: 5, output: 20, turns: 2 })
    expect(r.claude.byModel.map((m) => m.model).sort()).toEqual(['claude-haiku', 'claude-opus-4'])
    expect(r.codex.totals).toMatchObject({ input: 7, output: 3, turns: 1 })
    // 고친 지 오래된 파일은 열지 않는다
    expect((await scanUsage({ claude: [claude], codex: [codex] }, now + 60_000, now)).files).toBe(0)
  })
})

describe('통계 — 에이전트 요약(Orca collector)', () => {
  it('처음 일하기 시작한 탭 = 1, 일한 시간 = 일하는 중 구간 합, 같은 탭 재시작은 세지 않음, flush 로 저장·다시 읽기', async () => {
    const ud = tmp()
    let now = NOW
    const s = createStatsFeature({ userData: ud, dirs: () => ({ claude: [], codex: [] }), scan: async () => ({ since: 0, at: now, files: 0, claude: aggregateTurns([], 0), codex: aggregateTurns([], 0) }), now: () => now })
    s.observe('a', true, NOW)
    s.observe('a', true, NOW + 1000) // 그대로 일하는 중 — 무시
    s.observe('a', false, NOW + 60_000)
    s.observe('a', true, NOW + 120_000)
    s.observe('a', false, NOW + 180_000)
    s.observe('b', false, NOW) // 짝 없는 멈춤은 안 셈
    s.observe('b', true, NOW + 10)
    expect(s.summary()).toEqual({ agentsSpawned: 2, agentTimeMs: 120_000, firstEventAt: NOW })
    now = NOW + 70_010
    s.flush() // 일하는 중인 b 를 닫고 쓴다
    expect(JSON.parse(readFileSync(join(ud, 'usage-stats.json'), 'utf8'))).toEqual({ agentsSpawned: 2, agentTimeMs: 190_000, firstEventAt: NOW })
    const again = createStatsFeature({ userData: ud, dirs: () => ({ claude: [], codex: [] }), scan: async () => { throw new Error('x') } })
    expect(again.summary().agentsSpawned).toBe(2)
  })
  it('토큰 통계: 1분 안에는 지난 답, force 면 다시, 동시에 두 번이면 한 번만 읽는다', async () => {
    let now = NOW
    let n = 0
    const s = createStatsFeature({ userData: tmp(), dirs: () => ({ claude: ['c'], codex: ['x'] }), scan: async (req) => (n++, { since: req.since, at: now, files: n, claude: aggregateTurns([], 0), codex: aggregateTurns([], 0) }), now: () => now })
    await Promise.all([s.report(), s.report()])
    expect(n).toBe(1)
    now += 30_000
    await s.report()
    expect(n).toBe(1)
    await s.report(true)
    expect(n).toBe(2)
  })
})

describe('계정 여러 개(임시 userData)', () => {
  const setup = () => {
    const ud = tmp()
    const sys = { claude: tmp(), codex: tmp() }
    writeFileSync(join(sys.claude, 'settings.json'), '{"model":"opus"}')
    writeFileSync(join(sys.claude, 'CLAUDE.md'), '# 내 지시')
    writeFileSync(join(sys.claude, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: FAKE } }))
    writeFileSync(join(sys.codex, 'config.toml'), 'model = "gpt-5.6"')
    const runs: { file: string; args: readonly string[]; env?: Record<string, string> }[] = []
    const changes: AccountsView[] = []
    const acc = createAccountsFeature({
      userData: ud,
      defaultDir: (p) => sys[p],
      platform: 'win32',
      onChange: (v) => changes.push(v),
      run: async (file, args, opts) => {
        runs.push({ file, args, env: opts?.env })
        // 가짜 로그인: CLI 가 그 폴더에 자격 파일을 쓴 것처럼
        const dir = opts?.env?.['CLAUDE_CONFIG_DIR'] ?? opts?.env?.['CODEX_HOME']
        if (dir) writeFileSync(join(dir, args.includes('claude') ? '.credentials.json' : 'auth.json'), '{}')
        return { code: 0, stdout: '', stderr: '', error: null }
      }
    })
    return { ud, sys, acc, runs, changes }
  }
  it('추가 = 아라 폴더(userData/accounts/<cli>/<id>), 설정 복사(자격은 복사 안 함), 원본은 그대로', () => {
    const { ud, sys, acc } = setup()
    const id = acc.add('claude', '  회사\n')
    const dir = acc.dir('claude', id)!
    expect(dir).toBe(join(ud, 'accounts', 'claude', id))
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# 내 지시')
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    expect(acc.view().claude).toEqual({ active: null, list: [{ id, label: '회사' }] })
    expect(readFileSync(join(sys.claude, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
    // 저장 → 다시 읽기
    expect(createAccountsFeature({ userData: ud, defaultDir: (p) => sys[p] }).view().claude.list).toEqual([{ id, label: '회사' }])
  })
  it('고르기 → 실행 env(CLAUDE_CONFIG_DIR·CODEX_HOME), 시스템 기본이면 env 없음, Codex 는 config.toml 을 다시 복사', () => {
    const { sys, acc, changes } = setup()
    expect(acc.launchEnv('claude')).toEqual({})
    const c = acc.add('claude', 'a')
    const x = acc.add('codex', 'b')
    acc.select('claude', c)
    acc.select('codex', x)
    acc.select('codex', 'no-such-id-0000')
    expect(acc.view().codex.active).toBe(x)
    expect(acc.launchEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: acc.dir('claude', c) })
    writeFileSync(join(sys.codex, 'config.toml'), 'model = "o9"')
    const env = acc.launchEnv('codex')
    expect(env).toEqual({ CODEX_HOME: acc.dir('codex', x) })
    expect(readFileSync(join(env['CODEX_HOME'], 'config.toml'), 'utf8')).toBe('model = "o9"')
    acc.select('claude', null)
    expect(acc.launchEnv('claude')).toEqual({})
    expect(changes.length).toBeGreaterThanOrEqual(5)
  })
  it('로그인 = 그 폴더 env 로 CLI 로그인 명령(Windows 는 cmd /d /c), 자격 파일이 생기면 ok', async () => {
    const { acc, runs } = setup()
    const c = acc.add('claude', 'a')
    const x = acc.add('codex', 'b')
    expect(await acc.login('claude', c)).toEqual({ ok: true })
    expect(runs[0].args).toEqual(['/d', '/c', 'claude', 'auth', 'login', '--claudeai'])
    expect(runs[0].env).toEqual({ CLAUDE_CONFIG_DIR: acc.dir('claude', c) })
    expect(await acc.login('codex', x)).toEqual({ ok: true })
    expect(runs[1].args).toEqual(['/d', '/c', 'codex', 'login'])
    expect(runs[1].env).toEqual({ CODEX_HOME: acc.dir('codex', x) })
    expect((await acc.login('claude', 'nope')).ok).toBe(false)
  })
  it('지우기 = 그 계정 폴더만, 고른 계정이면 시스템 기본으로, 이름 바꾸기', () => {
    const { ud, sys, acc } = setup()
    const c = acc.add('claude', 'a')
    acc.select('claude', c)
    acc.rename('claude', c, '개인')
    expect(acc.view().claude.list[0].label).toBe('개인')
    acc.remove('claude', c)
    expect(existsSync(join(ud, 'accounts', 'claude', c))).toBe(false)
    expect(acc.view().claude).toEqual({ active: null, list: [] })
    expect(existsSync(join(sys.claude, '.credentials.json'))).toBe(true)
  })
})

describe('사용량 서비스 — M13(계정·컨텍스트·Gemini)', () => {
  const res = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) })
  const setup = () => {
    const sys = tmp()
    const acct = tmp()
    writeFileSync(join(sys, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sys-token' } }))
    writeFileSync(join(acct, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'acct-token' } }))
    let active: string | null = null
    const tokens: string[] = []
    const fetch: FetchLike = async (url, init) => {
      if (url === CLAUDE_USAGE_URL) tokens.push(init.headers['Authorization'])
      return res(200, { five_hour: { utilization: tokens.length * 10 } })
    }
    const pushes: UsageState[] = []
    const svc = createUsageService({ claudeDir: () => (active ? acct : sys), codexDir: () => tmp(), fetch, push: (s) => pushes.push(s), windowActive: () => true, now: () => NOW })
    return { svc, tokens, pushes, setActive: (a: string | null) => (active = a), acct }
  }
  it('계정을 바꾸면 Claude 값을 비우고 새 계정 자격으로 다시 묻는다, 다른 계정의 실시간 값은 버린다', async () => {
    const s = setup()
    await s.svc.refresh(true)
    expect(s.tokens).toEqual(['Bearer sys-token'])
    s.svc.ingestClaudeLive({ session: { usedPercent: 77, windowMinutes: 300, resetsAt: null }, weekly: null }, 'other-acct')
    expect(s.svc.state().claude?.session?.usedPercent).toBe(10)
    s.setActive('a1')
    const accounts: AccountsView = { ...EMPTY_ACCOUNTS, claude: { active: 'a1', list: [{ id: 'a1', label: '회사' }] } }
    s.svc.setAccounts(accounts)
    expect(s.svc.state().claude?.status).toBe('fetching')
    await vi.waitFor(() => expect(s.svc.state().claude?.status).toBe('ok'))
    expect(s.tokens).toEqual(['Bearer sys-token', 'Bearer acct-token'])
    expect(s.svc.state().accounts.claude.active).toBe('a1')
    s.svc.ingestClaudeLive({ session: { usedPercent: 5, windowMinutes: 300, resetsAt: null }, weekly: null }) // 아라 채팅 = 시스템 기본 → 버림
    expect(s.svc.state().claude?.session?.usedPercent).toBe(20)
    s.svc.ingestClaudeLive({ session: { usedPercent: 33, windowMinutes: 300, resetsAt: null }, weekly: null }, 'a1')
    expect(s.svc.state().claude?.session?.usedPercent).toBe(33)
    expect(JSON.stringify(s.pushes)).not.toMatch(/sys-token|acct-token/)
  })
  it('accountUsage: 그 폴더의 자격으로 한 번 묻는다', async () => {
    const s = setup()
    const u = await s.svc.accountUsage('claude', s.acct)
    expect(s.tokens).toEqual(['Bearer acct-token'])
    expect(u.status).toBe('ok')
  })
  it('컨텍스트: 탭별, 같은 값은 다시 안 밀고, 상한을 넘으면 오래된 것부터 뺀다', () => {
    const s = setup()
    s.svc.ingestContext('p1', { usedPercent: 10, windowTokens: 200000, model: 'Opus', at: 1 })
    const n = s.pushes.length
    s.svc.ingestContext('p1', { usedPercent: 10, windowTokens: 200000, model: 'Opus', at: 2 })
    expect(s.pushes.length).toBe(n)
    for (let i = 0; i < MAX_CONTEXT_ENTRIES + 5; i++) s.svc.ingestContext(`q${i}`, { usedPercent: i, windowTokens: null, model: null, at: 10 + i })
    const keys = Object.keys(s.svc.state().context)
    expect(keys).toHaveLength(MAX_CONTEXT_ENTRIES)
    expect(keys).not.toContain('p1')
  })
  it('Gemini: 꺼져 있으면 묻지 않고, 켜면 바로 묻는다 — refreshPlan 은 넘긴 프로바이더만', async () => {
    const posts: string[] = []
    const gdir = tmp()
    writeFileSync(join(gdir, 'oauth_creds.json'), JSON.stringify({ access_token: FAKE, refresh_token: 'r', expiry_date: NOW + 3_600_000 }))
    const svc = createUsageService({
      claudeDir: () => tmp(),
      codexDir: () => tmp(),
      fetch: async () => res(200, {}),
      gemini: { dir: () => gdir, post: async (u) => (posts.push(u), { ok: true, status: 200, json: async () => (u === GEMINI_LOAD_URL ? { cloudaicompanionProject: 'p' } : []) }), bin: async () => null },
      push: () => {},
      windowActive: () => true,
      now: () => NOW
    })
    await svc.refresh(true)
    expect(posts).toEqual([])
    svc.setPrefs({ display: 'used', gemini: true })
    await svc.refresh(true)
    expect(posts).toContain(GEMINI_QUOTA_URL)
    expect(svc.state().gemini?.status).toBe('ok')
    svc.setPrefs({ display: 'remaining', gemini: false })
    expect(svc.state().gemini).toBeNull()
    expect(refreshPlan(EMPTY_USAGE, { now: NOW, checkedAt: {}, lastRetryAt: {}, streak: {} }, ['claude', 'codex', 'gemini'])).toEqual(['claude', 'codex', 'gemini'])
  })
})
