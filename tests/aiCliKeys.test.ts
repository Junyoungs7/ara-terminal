// R14 — AI CLI 실행 단축키 Alt+1·2·3 (준영님 확정: Claude · Codex · Gemini).
//
// 🔴 순서의 진실은 actions.tsx 의 AI_CLIS 표다. KEYMAP 이 표와 따로 놀면 메뉴에는 "Claude" 옆에
//    Alt+1 이 찍히는데 누르면 Codex 가 뜬다 — 여기서 둘을 맞춰 본다.
// ⚠️ 떼어낸 창에서 "아무 일도 없다"는 MainArea 소스에 판정 한 줄이 있는지만 본다(화면을 안 띄운다).
//    실제로 눌러 보는 것은 실기 확인이다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEYMAP, isAppShortcut } from '../src/shared/keymap'
import { AI_CLIS, aiCliRunOfKey, terminalMenu } from '../src/renderer/interactions/actions'

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent

describe('AI CLI 단축키', () => {
  it('★ AI_CLIS 표 순서대로 Alt+1·2·3 이다', () => {
    const keys = AI_CLIS.map((c) => KEYMAP.find((k) => k.action === `aicli.run.${c.id}`)?.win)
    expect(keys).toEqual(['Alt+1', 'Alt+2', 'Alt+3'])
    expect(AI_CLIS.map((c) => c.id)).toEqual(['claude', 'codex', 'gemini'])
  })

  it('눌린 키 → 메뉴 id. 다른 조합은 안 문다', () => {
    expect(aiCliRunOfKey(ev({ altKey: true, key: '1' }))).toBe('aicli.run.claude')
    expect(aiCliRunOfKey(ev({ altKey: true, key: '2' }))).toBe('aicli.run.codex')
    expect(aiCliRunOfKey(ev({ altKey: true, key: '3' }))).toBe('aicli.run.gemini')
    expect(aiCliRunOfKey(ev({ altKey: true, key: '4' }))).toBeNull()
    expect(aiCliRunOfKey(ev({ key: '1' }))).toBeNull()
    // Ctrl+1 은 탭 번호 이동이다 — 여기서 먹으면 안 된다.
    expect(aiCliRunOfKey(ev({ ctrlKey: true, key: '1' }))).toBeNull()
    expect(aiCliRunOfKey(ev({ ctrlKey: true, altKey: true, key: '1' }))).toBeNull()
  })

  it('터미널이 셸로 흘리지 않는다(isAppShortcut)', () => {
    expect(isAppShortcut(ev({ altKey: true, key: '1' }))).toBe(true)
    expect(isAppShortcut(ev({ altKey: true, key: '4' }))).toBe(false)
  })

  it('우클릭 [AI 실행 ▸ …] 에 힌트가 붙는다', () => {
    const sub = terminalMenu().find((m) => m.id === 'aicli.run')?.submenu ?? []
    expect(sub.map((s) => s.hint)).toEqual(['Alt 1', 'Alt 2', 'Alt 3'])
  })

  it('★ 떼어낸 창(onRunAiCli 없음)에선 키가 아무 일도 안 한다 — 메뉴를 감추는 판정과 같다', () => {
    const main = readFileSync(join(__dirname, '..', 'src/renderer/components/MainArea.tsx'), 'utf8')
    expect(main).toMatch(/const run = onRunAiCli \? aiCliRunOfKey\(e\) : null/)
    expect(terminalMenu(undefined, { runAiCli: false }).some((m) => m.id === 'aicli.run')).toBe(false)
  })
})
