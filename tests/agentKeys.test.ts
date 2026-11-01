import { describe, it, expect } from 'vitest'
import { KEYMAP, matchBinding } from '../src/shared/keymap'
import { AGENT_IDS } from '../src/shared/agents'

// M3 S1(제거 A8): 옛 터미널 AI 실행 키(Ctrl+Shift+L · Alt+1·2·3)를 AI 작업 공간 "에이전트 시작"에 다시 걸었다.
const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent

describe('에이전트 시작 단축키', () => {
  it('★ Alt+1·2·3 = AGENT_IDS 순서(Claude Code · Codex · Gemini CLI), Ctrl+Shift+L = 피커', () => {
    expect(AGENT_IDS.map((id) => KEYMAP.find((k) => k.action === `agent.start.${id}`)?.win)).toEqual(['Alt+1', 'Alt+2', 'Alt+3'])
    expect(KEYMAP.find((k) => k.action === 'agent.start')?.win).toBe('Ctrl+Shift+L')
    expect(matchBinding(ev({ altKey: true, key: '2' }), 'agent.start.codex')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, shiftKey: true, key: 'L' }), 'agent.start')).toBe(true)
    // 수식키가 다르면 안 맞는다(공간 Ctrl+Alt+1 · 탭 Ctrl+1)
    expect(matchBinding(ev({ ctrlKey: true, altKey: true, key: '1' }), 'agent.start.claude')).toBe(false)
    expect(matchBinding(ev({ ctrlKey: true, key: '1' }), 'agent.start.claude')).toBe(false)
  })

  it('★ 충돌 없음 — 같은 조합을 쓰는 다른 줄이 없고, 옛 터미널 AI 액션은 표에서 사라졌다', () => {
    const mine = KEYMAP.filter((k) => k.action.startsWith('agent.start'))
    for (const k of mine) expect(KEYMAP.filter((x) => x.win === k.win).map((x) => x.action)).toEqual([k.action])
    expect(KEYMAP.some((k) => k.action === ('ai.cli' as string) || k.action.startsWith('aicli'))).toBe(false)
  })
})
