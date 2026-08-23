// M-5 회귀: 설정 [단축키] 섹션이 KEYMAP 의 카테고리를 빠짐없이 보여주는지 구조적으로 검사한다.
// 실제 결함: W3 가 keymap.ts 에 'ai' 카테고리를 추가했지만 SettingsDrawer.tsx 의 KEY_GROUPS 갱신을
// 빠뜨려 AI 단축키가 치트시트(?)에는 나오는데 설정 창에는 안 뜨는 불일치가 생겼다. 카테고리별 개별
// 확인 대신 "implemented 카테고리 전부가 어느 그룹에든 포함된다"를 검사해, F23의 mcp 류 새 카테고리를
// 추가할 때도 같은 부류의 누락을 여기서 구조적으로 잡는다.
import { describe, it, expect } from 'vitest'
import { KEYMAP } from '../src/shared/keymap'
import { AI_CHAT } from '../src/shared/features'
import { KEY_GROUPS } from '../src/renderer/components/SettingsDrawer'

describe('설정 [단축키] 그룹이 KEYMAP 카테고리를 빠짐없이 덮는다', () => {
  it('implemented:true 인 바인딩의 카테고리는 전부 어느 KEY_GROUPS 에 속한다', () => {
    const covered = new Set(KEY_GROUPS.flatMap((g) => g.cats))
    const missing = [...new Set(KEYMAP.filter((b) => b.implemented).map((b) => b.category))].filter(
      (c) => !covered.has(c)
    )
    expect(missing).toEqual([])
  })

  it('AI 단축키가 설정 창 [단축키]에 뜬다', () => {
    const aiGroup = KEY_GROUPS.find((g) => g.cats.includes('ai'))
    expect(aiGroup).toBeTruthy()
    const rows = KEYMAP.filter((b) => b.implemented && aiGroup!.cats.includes(b.category)).map((b) => b.action)
    // 2026-08-23: 아라 대화를 숨기면 대화용 두 키는 KEYMAP 에서 빠지고 **AI CLI 시작만 남는다**
    // (features.AI_CHAT). 그래도 이 그룹은 비면 안 된다 — 비면 설정 [단축키]에 빈 제목이 뜬다.
    expect(rows).toEqual(expect.arrayContaining(AI_CHAT ? ['ai.ask', 'ai.toggle', 'ai.cli'] : ['ai.cli']))
    expect(rows.length).toBeGreaterThan(0)
  })
})
