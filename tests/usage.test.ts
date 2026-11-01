// M9 AI-10 사용량 — 응답 파싱(Orca 시험에서 옮긴 경우들), 초기화 시각, 실패 시 상태·표시 유지, 실시간 반영, 재시도 간격,
// 서비스(모의 fetch — 실제 엔드포인트·실제 자격 파일 안 씀, 가짜 토큰은 임시 폴더), statusLine 심기·스크립트 → 훅 서버.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyStalePolicy,
  classifyHttpFailure,
  failureRetryMs,
  mapClaudeWindow,
  mergeLiveClaude,
  parseClaudeOAuthUsage,
  parseClaudeStatusLine,
  parseCodexUsage,
  parseResetTimestamp,
  parseRetryAfterMs,
  refreshPlan,
  withoutResetWindows,
  EMPTY_USAGE,
  type ProviderUsage
} from '../src/shared/usage'
import { createUsageService, CLAUDE_USAGE_URL, CODEX_USAGE_URL, type FetchLike } from '../src/main/usage/service'
import { HOOK_ENV, mergeStatusLine, statusLineScript } from '../src/shared/agentHooks'
import { createHookServer, installHooks } from '../src/main/agents/hooks'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 1, 3, 0, 0)

describe('초기화 시각', () => {
  it('epoch 초·ms·숫자 문자열·ISO 를 ms 로, 못 읽으면 null', () => {
    expect(parseResetTimestamp(1_800_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('1800000000')).toBe(1_800_000_000_000)
    expect(parseResetTimestamp('2026-11-01T05:00:00Z')).toBe(Date.UTC(2026, 10, 1, 5))
    expect(parseResetTimestamp('soon')).toBeNull()
    expect(parseResetTimestamp('')).toBeNull()
    expect(parseResetTimestamp(Number.NaN)).toBeNull()
    expect(parseResetTimestamp(undefined)).toBeNull()
  })
  it('창: utilization 우선, used_percentage 도 받고, 0~100 으로 자른다', () => {
    expect(mapClaudeWindow({ utilization: 41.5, resets_at: '2026-11-01T05:00:00Z' }, 300)).toEqual({ usedPercent: 41.5, windowMinutes: 300, resetsAt: Date.UTC(2026, 10, 1, 5) })
    expect(mapClaudeWindow({ used_percentage: 130 }, 300)?.usedPercent).toBe(100)
    expect(mapClaudeWindow({ utilization: -3 }, 300)?.usedPercent).toBe(0)
    expect(mapClaudeWindow({ resets_at: 1 }, 300)).toBeNull()
    expect(mapClaudeWindow(null, 300)).toBeNull()
  })
})

describe('Claude 응답', () => {
  it('OAuth five_hour·seven_day', () => {
    const r = parseClaudeOAuthUsage({ five_hour: { utilization: 37, resets_at: '2026-11-01T05:00:00+00:00' }, seven_day: { utilization: 24, resets_at: null }, extra_usage: { is_enabled: false } })
    expect(r.session).toEqual({ usedPercent: 37, windowMinutes: 300, resetsAt: Date.UTC(2026, 10, 1, 5) })
    expect(r.weekly).toEqual({ usedPercent: 24, windowMinutes: 10080, resetsAt: null })
    expect(parseClaudeOAuthUsage(null)).toEqual({ session: null, weekly: null })
  })
  it('statusLine rate_limits(Claude ≥2.1.80) — 없으면 null, 한쪽만 와도 받는다, 스키마 흔들림(utilization·ISO) 허용', () => {
    expect(parseClaudeStatusLine({ model: {}, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 } } })).toEqual({
      session: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_800_000_000_000 },
      weekly: null
    })
    expect(parseClaudeStatusLine({ rate_limits: { seven_day: { utilization: 5, resets_at: '2026-11-03T00:00:00Z' } } })?.weekly?.resetsAt).toBe(Date.UTC(2026, 10, 3))
    expect(parseClaudeStatusLine({ model: {} })).toBeNull()
    expect(parseClaudeStatusLine({ rate_limits: { five_hour: {} } })).toBeNull()
  })
  it('HTTP 실패 분류(Orca classifyClaudeOAuthUsageError)', () => {
    expect(classifyHttpFailure(429)).toBe('rate-limited')
    expect(classifyHttpFailure(401)).toBe('stale-token')
    expect(classifyHttpFailure(403, '{"error":{"message":"missing scope user:profile"}}')).toBe('missing-scope')
    expect(classifyHttpFailure(403)).toBe('stale-token')
    expect(classifyHttpFailure(503)).toBe('server')
    expect(classifyHttpFailure(404)).toBe('usage-unavailable')
  })
  it('Retry-After: 초·HTTP 날짜, 0 이하·깨진 값 null, 24시간 상한', () => {
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000)
    expect(parseRetryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW)).toBe(60_000)
    expect(parseRetryAfterMs('0', NOW)).toBeNull()
    expect(parseRetryAfterMs('nope', NOW)).toBeNull()
    expect(parseRetryAfterMs(null, NOW)).toBeNull()
    expect(parseRetryAfterMs('999999', NOW)).toBe(24 * H)
  })
})

describe('Codex 응답(wham/usage) — Orca codex-rate-limit-window-classification.test 의 경우들', () => {
  const body = (p: unknown, s: unknown) => ({ plan_type: 'plus', rate_limit: { primary_window: p, secondary_window: s } })
  const w = (used: unknown, mins?: number, reset?: number) => ({ used_percent: used, ...(mins ? { limit_window_seconds: mins * 60 } : {}), ...(reset ? { reset_at: reset } : {}) })
  const pct = (d: unknown) => {
    const r = parseCodexUsage(d)
    return { session: r?.session?.usedPercent ?? null, weekly: r?.weekly?.usedPercent ?? null }
  }
  it.each([
    ['순서 바뀐 창', body(w(81, 10080), w(21, 300)), { session: 21, weekly: 81 }],
    ['주간만(primary)', body(w(22, 10080), null), { session: null, weekly: 22 }],
    ['5시간만(secondary)', body(null, w(31, 300)), { session: 31, weekly: null }],
    ['5시간이 둘이면 앞의 것', body(w(41, 300), w(42, 300)), { session: 41, weekly: null }],
    ['주간이 둘이면 앞의 것', body(w(51, 10080), w(52, 10080)), { session: null, weekly: 51 }],
    ['깨진 % 는 빼고', body(w(Number.NaN, 300), w(61, 10080)), { session: null, weekly: 61 }],
    ['길이 모르면 자리 규칙', body(w(71), w(72)), { session: 71, weekly: 72 }],
    ['1분 어긋남 허용', body(w(5, 301), w(6, 10079)), { session: 5, weekly: 6 }]
  ])('%s', (_n, d, expected) => expect(pct(d)).toEqual(expected))
  it('초기화 시각은 epoch 초 → ms, 요금제, plan_type 없으면 null', () => {
    const r = parseCodexUsage(body(w(12, 300, 1_800_000_000), null))
    expect(r).toEqual({ session: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_800_000_000_000 }, weekly: null, planType: 'plus' })
    expect(parseCodexUsage({ rate_limit: {} })).toBeNull()
  })
})

const win = (usedPercent: number, resetsAt: number | null, windowMinutes = 300) => ({ usedPercent, windowMinutes, resetsAt })
const okClaude = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({ provider: 'claude', session: win(40, NOW + 2 * H), weekly: win(20, NOW + 50 * H, 10080), updatedAt: NOW, status: 'ok', source: 'oauth', ...over })

describe('실패 시 상태', () => {
  const fail = (failure: ProviderUsage['failure'], at = NOW + 60_000, provider: ProviderUsage['provider'] = 'claude'): ProviderUsage => ({ provider, session: null, weekly: null, updatedAt: at, status: 'error', failure })
  it('직전 값이 30분 안이면 값은 두고 error·이번 실패로 표시', () => {
    expect(applyStalePolicy(fail('network'), okClaude(), NOW + 60_000)).toMatchObject({ status: 'error', failure: 'network', session: { usedPercent: 40 } })
    expect(applyStalePolicy(fail('network', NOW + 31 * 60_000), okClaude(), NOW + 31 * 60_000)).toMatchObject({ session: null, status: 'error' })
  })
  it('429·Claude 만료 토큰은 24시간까지 유지, Codex 만료 토큰은 30분', () => {
    expect(applyStalePolicy(fail('rate-limited', NOW + H), okClaude({ session: win(40, NOW + 5 * H) }), NOW + H).session).not.toBeNull()
    expect(applyStalePolicy(fail('stale-token', NOW + H), okClaude({ session: win(40, NOW + 5 * H) }), NOW + H).session).not.toBeNull()
    expect(applyStalePolicy(fail('stale-token', NOW + H, 'codex'), { ...okClaude({ session: win(40, NOW + 5 * H) }), provider: 'codex' }, NOW + H).session).toBeNull()
  })
  it('초기화 시각이 지난 창은 유지하지 않는다', () => {
    const prev = okClaude({ session: win(90, NOW + 1000), weekly: null })
    expect(applyStalePolicy(fail('network', NOW + 2000), prev, NOW + 2000).session).toBeNull()
    expect(withoutResetWindows(okClaude(), NOW + 3 * H)).toMatchObject({ session: null, weekly: { usedPercent: 20 } })
  })
  it('재시도 간격: 30초 × 2^(n-1), 15분 상한', () => {
    expect([1, 2, 3, 10].map(failureRetryMs)).toEqual([30_000, 60_000, 120_000, 15 * 60_000])
  })
  it('창 활성화 계획: 처음 → 묻기, ok 5분 안 → 안 묻기, 실패는 간격·Retry-After 지키기', () => {
    const ctx = (o: Partial<Parameters<typeof refreshPlan>[1]> = {}) => ({ now: NOW, checkedAt: { claude: NOW - 60_000, codex: NOW - 6 * 60_000 }, lastRetryAt: { claude: 0, codex: 0 }, streak: { claude: 0, codex: 0 }, ...o })
    expect(refreshPlan(EMPTY_USAGE, ctx())).toEqual(['claude', 'codex'])
    const s = { claude: okClaude(), codex: { ...okClaude(), provider: 'codex' as const } }
    expect(refreshPlan(s, ctx())).toEqual(['codex'])
    const failed = { claude: { ...fail('network'), retryAtMs: undefined }, codex: { ...fail('rate-limited', NOW, 'codex'), retryAtMs: NOW + 60_000 } }
    expect(refreshPlan(failed, ctx({ lastRetryAt: { claude: NOW - 40_000, codex: 0 }, streak: { claude: 1, codex: 1 } }))).toEqual(['claude'])
    expect(refreshPlan(failed, ctx({ lastRetryAt: { claude: NOW - 40_000, codex: 0 }, streak: { claude: 2, codex: 1 } }))).toEqual([])
  })
})

describe('실시간 반영(statusLine·rate_limit_event)', () => {
  it('처음 값은 받고, 같은 값이 30초 안에 또 오면 무시', () => {
    const a = mergeLiveClaude(null, { session: win(10, NOW + H), weekly: null }, NOW)
    expect(a).toMatchObject({ status: 'ok', source: 'live', session: { usedPercent: 10 }, weekly: null })
    expect(mergeLiveClaude(a, { session: win(10, NOW + H), weekly: null }, NOW + 1000)).toBeNull()
    expect(mergeLiveClaude(a, { session: win(11, NOW + H), weekly: null }, NOW + 1000)?.session?.usedPercent).toBe(11)
  })
  it('같은 창에서 더 낮은 값·더 이른 초기화는 잠든 세션의 낡은 보고 — 버린다', () => {
    const prev = okClaude()
    expect(mergeLiveClaude(prev, { session: win(30, NOW + 2 * H), weekly: null }, NOW + 1000)).toBeNull()
    expect(mergeLiveClaude(prev, { session: win(80, NOW + H), weekly: null }, NOW + 1000)).toBeNull()
  })
  it('일부 창만 오면 안 온 창은 그대로, Retry-After 는 이어받는다', () => {
    const r = mergeLiveClaude(okClaude({ retryAtMs: NOW + H }), { session: win(45, NOW + 2 * H), weekly: null }, NOW + 1000)
    expect(r).toMatchObject({ session: { usedPercent: 45 }, weekly: { usedPercent: 20 }, retryAtMs: NOW + H })
  })
})

// ── 서비스(모의 fetch) ──
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ara-usage-'))
  dirs.push(d)
  return d
}
type Call = { url: string; headers: Record<string, string> }
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body)
})

function setup(reply: (url: string) => ReturnType<typeof res> | Error) {
  const claudeDir = tmp()
  const codexDir = tmp()
  const calls: Call[] = []
  const pushes: unknown[] = []
  let now = NOW
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r = reply(url)
    if (r instanceof Error) throw r
    return r
  }
  const svc = createUsageService({ claudeDir: () => claudeDir, codexDir: () => codexDir, fetch, push: (s) => pushes.push(s), windowActive: () => true, now: () => now })
  return { svc, calls, pushes, claudeDir, codexDir, tick: (ms: number) => (now += ms) }
}
const FAKE = 'fake-token-for-test'
const claudeCreds = (dir: string, extra: Record<string, unknown> = {}) => writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: FAKE, refreshToken: 'r', ...extra } }))

describe('사용량 서비스(모의 네트워크)', () => {
  it('자격 파일이 없으면 요청하지 않고 조용히 missing-credentials', async () => {
    const s = setup(() => res(200, {}))
    const st = await s.svc.refresh(true)
    expect(s.calls).toHaveLength(0)
    expect(st.claude).toMatchObject({ status: 'error', failure: 'missing-credentials', session: null })
    expect(st.codex).toMatchObject({ status: 'error', failure: 'missing-credentials' })
  })
  it('Orca 와 같은 엔드포인트·헤더로 묻고 파싱한다 — 상태에 토큰이 남지 않는다', async () => {
    const s = setup((url) =>
      url === CLAUDE_USAGE_URL
        ? res(200, { five_hour: { utilization: 41, resets_at: '2026-11-01T05:10:00Z' }, seven_day: { utilization: 18 } })
        : res(200, { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1_800_000_000 } } })
    )
    claudeCreds(s.claudeDir)
    writeFileSync(join(s.codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: FAKE, account_id: 'acc' } }))
    const st = await s.svc.refresh(true)
    expect(s.calls.map((c) => c.url).sort()).toEqual([CLAUDE_USAGE_URL, CODEX_USAGE_URL].sort())
    const ch = s.calls.find((c) => c.url === CLAUDE_USAGE_URL)!.headers
    expect(ch).toMatchObject({ Authorization: `Bearer ${FAKE}`, 'anthropic-beta': 'oauth-2025-04-20' })
    expect(s.calls.find((c) => c.url === CODEX_USAGE_URL)!.headers).toMatchObject({ 'ChatGPT-Account-Id': 'acc', 'OpenAI-Beta': 'codex-1' })
    expect(st.claude).toMatchObject({ status: 'ok', source: 'oauth', session: { usedPercent: 41 }, weekly: { usedPercent: 18 } })
    expect(st.codex).toMatchObject({ status: 'ok', planType: 'pro', session: { usedPercent: 12, resetsAt: 1_800_000_000_000 } })
    expect(JSON.stringify(s.pushes)).not.toContain(FAKE)
  })
  it('네트워크 실패 → 직전 값 유지 + error · 429 → Retry-After 동안 자동 조회 안 함(사람의 새로 고침은 함)', async () => {
    let mode: 'ok' | 'down' | '429' = 'ok'
    const s = setup((url) =>
      url !== CLAUDE_USAGE_URL ? res(500, {}) : mode === 'ok' ? res(200, { five_hour: { utilization: 41, resets_at: '2026-11-01T05:10:00Z' } }) : mode === 'down' ? new TypeError('fetch failed') : res(429, {}, { 'retry-after': '600' })
    )
    claudeCreds(s.claudeDir)
    await s.svc.refresh(true)
    mode = 'down'
    s.tick(60_000)
    expect((await s.svc.refresh(true)).claude).toMatchObject({ status: 'error', failure: 'network', session: { usedPercent: 41 } })
    mode = '429'
    const st = await s.svc.refresh(true)
    expect(st.claude).toMatchObject({ failure: 'rate-limited', retryAtMs: NOW + 60_000 + 600_000 })
    const n = s.calls.length
    await s.svc.poll()
    await s.svc.refresh()
    expect(s.calls.filter((c) => c.url === CLAUDE_USAGE_URL).length).toBe(s.calls.slice(0, n).filter((c) => c.url === CLAUDE_USAGE_URL).length)
    await s.svc.refresh(true)
    expect(s.calls.filter((c) => c.url === CLAUDE_USAGE_URL).length).toBeGreaterThan(s.calls.slice(0, n).filter((c) => c.url === CLAUDE_USAGE_URL).length)
  })
  it('401: 갱신 토큰이 있으면 stale-token(다음 실행 때 갱신), 없으면 missing-credentials', async () => {
    const s = setup(() => res(401, { error: { message: 'expired' } }))
    claudeCreds(s.claudeDir)
    expect((await s.svc.refresh(true)).claude?.failure).toBe('stale-token')
    claudeCreds(s.claudeDir, { refreshToken: '' })
    expect((await s.svc.refresh(true)).claude?.failure).toBe('missing-credentials')
  })
  it('실시간 값이 최근이면 실패한 OAuth 가 덮지 않는다', async () => {
    const s = setup(() => new TypeError('fetch failed'))
    claudeCreds(s.claudeDir)
    s.svc.ingestClaudeLive({ session: win(55, NOW + H), weekly: null })
    const st = await s.svc.refresh(true)
    expect(st.claude).toMatchObject({ status: 'ok', source: 'live', session: { usedPercent: 55 } })
  })
  it('창이 비활성이면 15분 주기 조회를 쉰다', async () => {
    const calls: string[] = []
    const svc = createUsageService({ claudeDir: () => tmp(), codexDir: () => tmp(), fetch: async (u) => (calls.push(u), res(200, {})), push: () => {}, windowActive: () => false })
    await svc.poll()
    expect(svc.state()).toEqual(EMPTY_USAGE)
  })
})

describe('statusLine 심기(Orca statusline-install)', () => {
  it('비어 있으면 심고, 사용자 statusLine 은 손대지 않고, 지운 뒤(표식)엔 다시 안 심는다', () => {
    expect(mergeStatusLine({ a: 1 }, 'C:/h/.ara/agent-hooks/claude-statusline.cmd', false)).toEqual({ a: 1, statusLine: { type: 'command', command: 'C:/h/.ara/agent-hooks/claude-statusline.cmd' } })
    expect(mergeStatusLine({ statusLine: { type: 'command', command: 'my-line.sh' } }, 'x/.ara/agent-hooks/claude-statusline.sh', false)).toBeNull()
    expect(mergeStatusLine({}, 'x/.ara/agent-hooks/claude-statusline.sh', true)).toBeNull()
    expect(mergeStatusLine({ statusLine: { command: '/old/.ara/agent-hooks/claude-statusline.sh' } }, '/new/.ara/agent-hooks/claude-statusline.sh', true)).toMatchObject({ statusLine: { command: '/new/.ara/agent-hooks/claude-statusline.sh' } })
    expect(mergeStatusLine({ statusLine: { type: 'command', command: '/h/.ara/agent-hooks/claude-statusline.sh' } }, '/h/.ara/agent-hooks/claude-statusline.sh', true)).toBeNull()
  })
  it('installHooks(claude) 가 스크립트·표식·설정을 쓰고, 사용자 statusLine 이 있으면 그대로', () => {
    const h = tmp()
    mkdirSync(join(h, '.claude'))
    const winp = process.platform === 'win32'
    expect(installHooks(h, 'claude', winp).ok).toBe(true)
    const cfg = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))
    expect(cfg.statusLine.command).toContain('claude-statusline.')
    expect(existsSync(join(h, '.ara', 'agent-hooks', 'claude-statusline.installed'))).toBe(true)
    const u = tmp()
    mkdirSync(join(u, '.claude'))
    writeFileSync(join(u, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    expect(installHooks(u, 'claude', winp).ok).toBe(true)
    expect(JSON.parse(readFileSync(join(u, '.claude', 'settings.json'), 'utf8')).statusLine.command).toBe('mine')
  })
  it('스크립트는 아무것도 찍지 않는다(Windows: echo 없음), env 없으면 바로 나간다', () => {
    const w = statusLineScript(true).split('\r\n')
    expect(w.some((l) => /^echo /.test(l))).toBe(false)
    expect(w.findIndex((l) => l.includes(`%${HOOK_ENV.pane}%"==""`))).toBeLessThan(w.findIndex((l) => l.includes('more.com')))
    expect(statusLineScript(false)).toContain('"rate_limits"')
  })

  it('심은 statusLine 스크립트를 실제로 돌리면 훅 서버가 rate_limits 를 받는다 — 15초 안의 두 번째는 안 보낸다, 구독 아닌 입력도 안 보낸다', async () => {
    const winp = process.platform === 'win32'
    if (!winp && !existsSync('/bin/sh')) return
    const got: Record<string, unknown>[] = []
    const s = createHookServer(() => {}, null, (p) => got.push(p))
    try {
      const { port, token } = await s.ensure()
      const h = tmp()
      expect(installHooks(h, 'claude', winp).ok).toBe(true)
      const script = join(h, '.ara', 'agent-hooks', winp ? 'claude-statusline.cmd' : 'claude-statusline.sh')
      const pane = randomUUID() // 매번 새 칸 — %TEMP% 의 15초 도장이 다른 실행과 안 섞이게
      const run = (input: string, env: Record<string, string>): Promise<string> =>
        new Promise((resolve, reject) => {
          const base = { ...process.env }
          for (const k of Object.values(HOOK_ENV)) delete base[k]
          delete base['CLAUDE_JOB_DIR']
          const child = winp ? spawn('cmd.exe', ['/d', '/c', script], { env: { ...base, ...env } }) : spawn('/bin/sh', [script], { env: { ...base, ...env } })
          let out = ''
          child.stdout.on('data', (d: Buffer) => (out += d.toString()))
          child.on('error', reject)
          child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))))
          child.stdin.end(input)
        })
      const env = { [HOOK_ENV.port]: String(port), [HOOK_ENV.token]: token, [HOOK_ENV.pane]: pane }
      const payload = JSON.stringify({ model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 33, resets_at: 1_800_000_000 } } })
      expect(await run(payload, {})).toBe('')
      expect(await run(JSON.stringify({ model: { id: 'x' } }), env)).toBe('')
      expect(got).toHaveLength(0)
      expect(await run(payload, env)).toBe('')
      expect(got).toHaveLength(1)
      expect(parseClaudeStatusLine(got[0])?.session?.usedPercent).toBe(33)
      await run(payload, env)
      expect(got).toHaveLength(1)
    } finally {
      await s.stop()
    }
  }, 20_000)
})

describe('화면 쪽(store/usage)', async () => {
  const { araLimitsFromUsage, resetAtText, liveWindow } = await import('../src/renderer/store/usage')
  it('아라 채팅 상태줄 모양으로 — 반올림, 없으면 null', () => {
    expect(araLimitsFromUsage(okClaude({ session: win(40.6, 5), weekly: null }))).toEqual({ five: { pct: 41, resetsAt: 5 }, week: null })
    expect(araLimitsFromUsage(null)).toBeNull()
  })
  it('초기화 시각 글: 오늘이면 시각만, 아니면 날짜(요일) 시각', () => {
    const base = new Date(2026, 10, 1, 9, 0).getTime()
    expect(resetAtText(new Date(2026, 10, 1, 19, 5).getTime(), base)).toBe('19:05')
    expect(resetAtText(new Date(2026, 10, 7, 8, 0).getTime(), base)).toBe('11/7(토) 08:00')
  })
  it('지난 창은 뺀다', () => {
    expect(liveWindow(win(10, NOW - 1), NOW)).toBeNull()
    expect(liveWindow(win(10, null), NOW)).not.toBeNull()
  })
})
