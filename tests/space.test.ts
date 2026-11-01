import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spaceOf } from '../src/shared/space'
import { prefsFrom } from '../src/renderer/terminal/termPrefs'
import { WorkspaceStore } from '../src/main/workspace/WorkspaceStore'
import { KEYMAP, isAppShortcut, matchBinding, matchNumber } from '../src/shared/keymap'
import { MENUBAR, SPACE_ACTIONS, menuEntryId } from '../src/shared/menubar'
import type { UiState } from '../src/shared/types'

// M1 라운드 2 — 공간 전환 [터미널 | AI 작업]. M3 부터 AI 작업 공간은 기본 공개(옛 실험 기능 게이트 없음).

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent

describe('공간 판정', () => {
  it('모르는 값은 터미널로 내린다(손상·옛 스냅샷)', () => {
    expect(spaceOf('ai')).toBe('ai')
    for (const bad of [undefined, null, 'AI', 1, {}, 'term']) expect(spaceOf(bad)).toBe('term')
  })

  it('★ 옛 스냅샷(필드 없음) = 터미널. 옛 실험 기능 토글(ui.aiSpace)은 읽지 않는다 — 저장값이 곧 그릴 공간', () => {
    expect(prefsFrom({} as UiState).space).toBe('term')
    const p = prefsFrom({ aiSpace: false, space: 'ai' } as unknown as UiState)
    expect(p.space).toBe('ai')
    expect(p).not.toHaveProperty('aiSpace')
  })
})

describe('공간 저장 — 재시작 후 유지', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('ui:setPrefs 로 저장한 공간을 새 store 가 그대로 읽는다', () => {
    dir = mkdtempSync(join(tmpdir(), 'ara-space-'))
    const file = join(dir, 'workspace.json')
    const a = new WorkspaceStore(file, '0.1.0')
    a.setPrefs({ ...prefsFrom({} as UiState), space: 'ai' })
    a.flush()
    const back = prefsFrom(new WorkspaceStore(file, '0.1.0').get().ui)
    expect(back.space).toBe('ai')
  })
})

describe('공간 단축키 Ctrl+Alt+1·2', () => {
  it('공간 키로 맞고, 탭 번호(Ctrl+1-9)·에이전트 시작(Alt+1-3)과 안 겹친다', () => {
    expect(matchBinding(ev({ ctrlKey: true, altKey: true, key: '1' }), 'space.term')).toBe(true)
    expect(matchBinding(ev({ ctrlKey: true, altKey: true, key: '2' }), 'space.ai')).toBe(true)
    // 같은 키가 다른 액션에 안 걸린다
    expect(matchNumber(ev({ ctrlKey: true, altKey: true, key: '1' }), 'tab.byNumber')).toBeNull()
    expect(matchBinding(ev({ ctrlKey: true, altKey: true, key: '1' }), 'agent.start.claude')).toBe(false)
    // 반대로 옛 키는 공간으로 안 간다
    expect(matchBinding(ev({ ctrlKey: true, key: '1' }), 'space.term')).toBe(false)
    expect(matchBinding(ev({ altKey: true, key: '2' }), 'space.ai')).toBe(false)
    // AltGr 배열(Ctrl+Alt 로 온다)에서 숫자 자리가 기호를 내면 안 맞는다
    expect(matchBinding(ev({ ctrlKey: true, altKey: true, key: '²' }), 'space.ai')).toBe(false)
    expect(isAppShortcut(ev({ ctrlKey: true, altKey: true, key: '2' }))).toBe(true)
  })

  it('≡ [보기] 에 공간 두 줄이 있고, 스위치 없는 창이 거르는 목록과 같다', () => {
    const view = MENUBAR.find((m) => m.title === '보기')!.items.map(menuEntryId)
    expect(view).toEqual(expect.arrayContaining(['space.term', 'space.ai']))
    expect([...SPACE_ACTIONS].sort()).toEqual(['space.ai', 'space.term'])
    expect(KEYMAP.filter((k) => SPACE_ACTIONS.has(k.action)).map((k) => k.labelKo)).toEqual(['공간: 터미널', '공간: AI 작업'])
  })
})
