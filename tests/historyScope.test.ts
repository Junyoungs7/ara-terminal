// 🔴 **AI CLI 에 친 문장이 디스크로 가지 않는가** (#204-1, 2026-09-21 — M4 S3 부터는 AI 작업 공간 에이전트 탭).
//
// 왜 이 시험이 있나: AI CLI 세션도 `type: 'local'` 이라 히스토리 scope 가 `'local'` 이었다.
// 그래서 Claude·Codex 에 친 **모든 문장**이 셸 명령과 같은 통에 쌓여 `history.json` 으로 갔다
// (준영님 실측: 한글 프롬프트 22건). 명령줄 마스킹(maskSecrets)은 그 글을 알아볼 수 없다 —
// `mysql -pSECRET` 은 모양이 있지만 "비번은 xxxx 야" 는 없다.
//
// ⚠️ 이 시험은 **IPC 를 안 부르는가**만 본다. 그 한 줄이 이 라운드의 전부라서 그렇다.
//    실제 파일이 안 커지는 것은 실기 확인 항목이다(#204 점검 목록).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_SCOPE,
  historyScope,
  isEphemeralScope,
  appendHistory,
  cachedHistory,
  loadHistory,
  forgetCachedScope,
  resetHistoryCache
} from '../src/renderer/store/history'

describe('historyScope — 통을 고르는 규칙은 한 곳에만 있다', () => {
  it('AI 작업 공간 에이전트 탭은 자기 통으로 간다', () => {
    expect(historyScope({ local: true, serverKey: 'localhost', agent: true })).toBe(AGENT_SCOPE)
  })

  it('로컬 셸은 local', () => {
    expect(historyScope({ local: true, serverKey: 'local' })).toBe('local')
  })

  it('SSH 는 서버별', () => {
    expect(historyScope({ local: false, serverKey: '결제서버' })).toBe('결제서버')
  })
})

describe('isEphemeralScope — 에이전트 통만 메모리 전용이다', () => {
  it('에이전트 통은 true', () => {
    expect(isEphemeralScope(AGENT_SCOPE)).toBe(true)
  })

  it('나머지는 전부 false — 서버 통 이름은 프로필 이름이라 무엇이든 될 수 있다', () => {
    expect(isEphemeralScope('local')).toBe(false)
    expect(isEphemeralScope('결제서버')).toBe(false)
    // 프로필 이름이 agent 여도 그 서버 기록은 디스크로 간다(에이전트 통은 NUL 로 시작한다).
    expect(isEphemeralScope('agent')).toBe(false)
    // M4 S3: 옛 터미널 AI 통은 더 없다.
    expect(isEphemeralScope('ai:claude')).toBe(false)
  })
})

describe('🔴 에이전트 통은 IPC 를 부르지 않는다 — 이 시험이 이 라운드의 본체다', () => {
  const appended: { scope: string; command: string }[] = []
  const loaded: string[] = []

  beforeEach(() => {
    resetHistoryCache()
    appended.length = 0
    loaded.length = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      ev: {
        history: {
          load: (scope: string) => {
            loaded.push(scope)
            return Promise.resolve(['이미 디스크에 있던 줄'])
          },
          append: (scope: string, command: string) => {
            appended.push({ scope, command })
            return Promise.resolve({ ok: true })
          }
        }
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('appendHistory(AGENT_SCOPE) 는 window.ev.history.append 를 부르지 않는다', () => {
    appendHistory(AGENT_SCOPE, '우선 1~7을 먼저 작업해줘')
    expect(appended).toHaveLength(0)
    // 그래도 캐시에는 남는다 — 그 세션 안에서 고스트 자동완성은 계속 동작해야 한다.
    expect(cachedHistory(AGENT_SCOPE)).toEqual(['우선 1~7을 먼저 작업해줘'])
  })

  /**
   * **양성 대조.** 위 시험만 두면 "아무것도 안 부름"(가짜 window 배선이 틀렸다·함수가 죽었다)
   * 으로도 통과한다. 0 은 "없다"와 "내 검사가 못 찾는다" 둘 다다.
   */
  it('appendHistory("local") 은 **부른다** — 안 그러면 위 시험이 공허하다', () => {
    appendHistory('local', 'npm run build')
    expect(appended).toEqual([{ scope: 'local', command: 'npm run build' }])
  })

  it('loadHistory(AGENT_SCOPE) 도 IPC 를 안 부르고 빈 목록에서 시작한다', async () => {
    expect(await loadHistory(AGENT_SCOPE)).toEqual([])
    expect(loaded).toHaveLength(0)
  })

  it('loadHistory("local") 은 **부른다**(양성 대조)', async () => {
    expect(await loadHistory('local')).toEqual(['이미 디스크에 있던 줄'])
    expect(loaded).toEqual(['local'])
  })
})

describe('forgetCachedScope — 지운 뒤 캐시가 되살리지 못하게 한다', () => {
  const appended: { scope: string; command: string }[] = []

  beforeEach(() => {
    resetHistoryCache()
    appended.length = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      ev: {
        history: {
          load: () => Promise.resolve(['옛 줄']),
          append: (scope: string, command: string) => {
            appended.push({ scope, command })
            return Promise.resolve({ ok: true })
          }
        }
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('통 하나만 버린다', async () => {
    await loadHistory('local')
    await loadHistory('결제서버')
    forgetCachedScope('local')
    expect(cachedHistory('local')).toEqual([])
    expect(cachedHistory('결제서버')).toEqual(['옛 줄'])
  })

  it('scope 를 안 주면 전부 버린다', async () => {
    await loadHistory('local')
    await loadHistory('결제서버')
    forgetCachedScope()
    expect(cachedHistory('local')).toEqual([])
    expect(cachedHistory('결제서버')).toEqual([])
  })

  /**
   * 🔴 **되살아남 방지.** 캐시를 안 버리면 다음 한 줄이 옛 줄들을 디스크로 도로 보낸다 —
   * 지웠다고 믿는데 안 지워진 것이 이 기능의 최악이다.
   */
  it('버린 뒤 다음 명령은 옛 줄을 데려오지 않는다', async () => {
    await loadHistory('local')
    expect(cachedHistory('local')).toEqual(['옛 줄'])
    forgetCachedScope('local')
    appendHistory('local', 'pwd')
    expect(cachedHistory('local')).toEqual(['pwd'])
    expect(appended).toEqual([{ scope: 'local', command: 'pwd' }])
  })

  it('다시 load 하면 그때는 디스크에서 새로 읽는다(캐시만 버린 것이지 못 읽게 한 게 아니다)', async () => {
    await loadHistory('local')
    forgetCachedScope('local')
    expect(await loadHistory('local')).toEqual(['옛 줄'])
  })
})

// ── 소스 검사 ──
// `sftpOverwrite.test.ts` 가 증명한 부류: 함수가 맞는 것과 **그 함수를 쓰는 것**은 다른 사실이다.
// 위 시험은 전부 `historyScope` 를 직접 부르므로, TerminalPane 이 옛 삼항식을 그대로 들고 있어도
// 한 건도 안 깨진다 — 그 결함이 이 라운드의 본체인데 말이다.
describe('🔴 화면이 그 판정을 **실제로 쓰는가**', () => {
  const read = (p: string): string => readFileSync(join(__dirname, '..', p), 'utf8')
  const pane = read('src/renderer/terminal/TerminalPane.tsx')
  const agentPane = read('src/renderer/features/aiws/AgentPane.tsx')
  const drawer = read('src/renderer/components/SettingsPage.tsx')

  it('TerminalPane 이 historyScope 를 지난다', () => {
    expect(pane).toMatch(/const scope = historyScope\(\{ local, serverKey, agent \}\)/)
  })

  it('옛 삼항식이 남아 있지 않다 — 남아 있으면 AI 세션이 조용히 local 통으로 돌아간다', () => {
    expect(pane).not.toMatch(/local \? 'local' : serverKey/)
  })

  it('에이전트 칸(AgentPane)이 agent 를 넘긴다 — 안 넘기면 에이전트에 친 글이 디스크로 간다', () => {
    expect(agentPane).toMatch(/<TerminalPane [^>]* agent[ />]/)
    expect(agentPane).not.toMatch(/aiCli=/)
  })

  it('effect deps 에 agent 가 있다(첫 마운트에 prop 이 늦게 오는 경우)', () => {
    expect(pane).toMatch(/\[sessionId, local, serverKey, agent\]/)
  })

  it('🔴 SettingsPage 가 history.clear 뒤에 forgetCachedScope 를 부른다', () => {
    expect(drawer).toMatch(/history\?\.clear\(scope\)[\s\S]{0,200}?forgetCachedScope\(scope\)/)
  })
})
