// AI-05 턴 끝 판정 — herdr 화면 매니페스트(agentManifests.json) + 엔진(agentScreen.ts).
// 픽스처는 세 CLI 의 실제 화면 모양을 손으로 옮긴 것(herdr 저장소엔 화면 픽스처가 없다). 각 3상태 + 일부러 틀린 화면 대조.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectScreen, manifestIds, MANIFEST_SOURCE, rustRegex } from '../src/shared/agentScreen'
import manifestsJson from '../src/shared/agentManifests.json'
import { parseManifestToml } from '../scripts/herdr-manifests.mjs'

const RULE = '─'.repeat(60)
const s = (...ls: string[]): string => ls.join('\n')

const CLAUDE = {
  working: s('> fix the login bug', '', '● Read(src/login.ts)', '  ⎿  Read 120 lines', '', '✻ Thinking… (12s · ↓ 340 tokens · esc to interrupt)', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'),
  idle: s('> fix the login bug', '', '● Fixed the null check in src/login.ts.', '', RULE, '❯ ', RULE, '  ? for shortcuts'),
  blocked: s(
    '● Bash(rm -rf build)',
    '',
    RULE,
    ' Bash command',
    '',
    '   rm -rf build',
    '   Remove the build folder',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm commands in C:\\work",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain'
  )
}

const CODEX = {
  working: s('› fix the login bug', '', '• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  100% context left · ? for shortcuts'),
  // codex 의 쉬는 판정은 창 제목(osc_title_idle)으로 온다 — 화면만으로는 fallback idle.
  idle: s('› fix the login bug', '', '• Fixed the null check in src/login.ts.', '', '› Ask Codex to do anything', '', '  100% context left · ? for shortcuts'),
  blocked: s(
    '› run the tests',
    '',
    '  Would you like to run the following command?',
    '',
    '  $ npm test',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for this command (p)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel'
  )
}

const GEMINI = {
  working: s(' > fix the login bug', '', '⠏ Reading the login module (esc to cancel, 4s)', '', '╭──────────────────────────────╮', '│ >   Type your message        │', '╰──────────────────────────────╯'),
  idle: s(' > fix the login bug', '', '✦ Fixed the null check in src/login.ts.', '', '╭──────────────────────────────╮', '│ >   Type your message        │', '╰──────────────────────────────╯'),
  blocked: s(
    '╭──────────────────────────────────────────╮',
    '│ ?  Shell npm test                        │',
    '│                                          │',
    '│ Allow execution of: npm?                 │',
    '│                                          │',
    '│ ● 1. Allow once                          │',
    '│   2. Allow always                        │',
    '│   3. No, suggest changes (esc)           │',
    '╰──────────────────────────────────────────╯'
  )
}

describe('매니페스트 데이터', () => {
  it('herdr 22종이 다 실리고 출처(Apache-2.0·커밋)가 붙어 있다', () => {
    expect(manifestIds()).toHaveLength(22)
    expect(manifestIds()).toEqual(expect.arrayContaining(['claude', 'codex', 'gemini']))
    expect(MANIFEST_SOURCE).toMatch(/^herdrdev\/herdr .*@[0-9a-f]{40} \(Apache-2\.0\)$/)
  })
  it('22종의 정규식이 전부 JS 로 옮겨진다(Rust 문법 \\x{…}·\\A·\\z·인라인 플래그)', () => {
    const all: string[] = []
    const walk = (g: Record<string, unknown>): void => {
      for (const k of ['regex', 'line_regex']) for (const p of (g[k] as string[] | undefined) ?? []) all.push(p)
      for (const k of ['all', 'any', 'not']) for (const n of (g[k] as Record<string, unknown>[] | undefined) ?? []) walk(n)
    }
    for (const m of Object.values((manifestsJson as { manifests: Record<string, { rules: Record<string, unknown>[] }> }).manifests)) m.rules.forEach(walk)
    expect(all.length).toBeGreaterThan(50)
    for (const p of all) expect(() => rustRegex(p), p).not.toThrow()
  })
  it('Rust 문법 옮기기', () => {
    expect(rustRegex('^[\\x{2800}-\\x{28FF}] ').test('⠋ x')).toBe(true)
    expect(rustRegex('(?i)^yes\\b').test('YES')).toBe(true)
    expect(rustRegex('(?m)^b\\z').test('a\nb')).toBe(true)
    expect(rustRegex('(?m)^a\\z').test('a\nb')).toBe(false)
    expect(rustRegex('\\A> x').test('> x')).toBe(true)
    expect(rustRegex('\\A> x').test('y\n> x')).toBe(false)
  })
  it('변환 스크립트의 TOML 파서 — 매니페스트가 쓰는 문법', () => {
    const toml = [
      'id = "x"',
      'min_engine_version = 2',
      'aliases = ["x-cli"]',
      '# 주석',
      '[[rules]]',
      'id = "r"',
      'state = "working"',
      'visible_working = true',
      "regex = ['^\\s*[⠋] # 이건 주석 아님']",
      'any = [',
      '  { contains = ["a", "b"], any = [{ contains = ["c"] }] }, # 끝 주석',
      ']'
    ].join('\n')
    expect(parseManifestToml(toml)).toEqual({
      id: 'x',
      min_engine_version: 2,
      aliases: ['x-cli'],
      rules: [{ id: 'r', state: 'working', visible_working: true, regex: ['^\\s*[⠋] # 이건 주석 아님'], any: [{ contains: ['a', 'b'], any: [{ contains: ['c'] }] }] }]
    })
    expect(() => parseManifestToml("x = '''a'''")).toThrow()
    expect(() => parseManifestToml('[table]')).toThrow()
  })
  it('실린 JSON 이 herdr 원본 TOML 과 같다(원본이 이 PC 에 있을 때만)', () => {
    let toml: string
    try {
      toml = readFileSync('D:/herdr-src/herdr/src/detect/manifests/claude.toml', 'utf8')
    } catch {
      return
    }
    expect((manifestsJson as { manifests: Record<string, unknown> }).manifests['claude']).toEqual(parseManifestToml(toml))
  })
})

describe.each([
  ['claude', CLAUDE],
  ['codex', CODEX],
  ['gemini', GEMINI]
] as const)('%s 화면 3상태', (agent, fx) => {
  it('일하는 중 → working', () => expect(detectScreen(agent, { screen: fx.working }).state).toBe('working'))
  it('막힘(승인) → blocked + 살아 있는 막힘 표시', () => {
    const d = detectScreen(agent, { screen: fx.blocked })
    expect(d.state).toBe('blocked')
    expect(d.visibleBlocker).toBe(true)
  })
  it('쉬는 중 → idle', () => expect(detectScreen(agent, { screen: fx.idle }).state).toBe('idle'))
})

describe('규칙이 고른 근거', () => {
  it('claude: 프롬프트 상자가 보이면 살아 있는 쉼(live_prompt_box), 일하는 줄이 있으면 그게 이긴다(우선순위)', () => {
    expect(detectScreen('claude', { screen: CLAUDE.idle })).toMatchObject({ rule: 'live_prompt_box', visibleIdle: true })
    expect(detectScreen('claude', { screen: CLAUDE.working }).rule).toBe('live_turn_working')
  })
  it('codex: 창 제목 스피너 = working, 스피너 없는 제목 = idle, Action Required = blocked', () => {
    expect(detectScreen('codex', { screen: CODEX.idle, oscTitle: '⠙ myproj' }).state).toBe('working')
    expect(detectScreen('codex', { screen: CODEX.idle, oscTitle: 'myproj' })).toMatchObject({ state: 'idle', visibleIdle: true })
    expect(detectScreen('codex', { screen: CODEX.idle, oscTitle: 'Action Required' }).state).toBe('blocked')
  })
  it('claude: 대화 기록 보기 화면은 판정을 건너뛴다(skip)', () => {
    const d = detectScreen('claude', { screen: s('… transcript …', 'Showing detailed transcript · ctrl+o to toggle') })
    expect(d.skip).toBe(true)
  })
})

describe('일부러 틀린 화면 — 추정에 걸리면 안 된다', () => {
  it('사용자가 프롬프트 상자에 "esc to interrupt" 를 써도 working 이 아니다(claude)', () => {
    const screen = s('● Done.', '', RULE, '❯ please add an esc to interrupt hint…', RULE, '  ? for shortcuts')
    expect(detectScreen('claude', { screen }).state).toBe('idle')
  })
  it('지난 승인 질문이 위로 지나가고 새 입력 줄이 생기면 codex 는 막힘이 아니다', () => {
    const screen = s(CODEX.blocked.replace('Press enter to confirm or esc to cancel', ''), '', '• Ran npm test', '', '› Ask Codex to do anything')
    expect(detectScreen('codex', { screen }).state).not.toBe('blocked')
  })
  it('셸 화면에 남은 글자("esc to interrupt")만으로는 claude working 이 아니다', () => {
    const screen = s('PS C:\\work> echo "esc to interrupt"', 'esc to interrupt', 'PS C:\\work> ')
    expect(detectScreen('claude', { screen }).state).toBe('idle')
  })
  it('gemini 승인 문구가 없는 일반 출력은 blocked 가 아니다', () => {
    expect(detectScreen('gemini', { screen: s('$ cat notes.txt', 'apply this change later', 'allow execution next week') }).state).toBe('idle')
  })
  it('모르는 에이전트는 unknown(판정 안 함)', () => {
    expect(detectScreen('nope', { screen: CLAUDE.working }).state).toBe('unknown')
  })
})
