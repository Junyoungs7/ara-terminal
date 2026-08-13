// F31 통합 검색 — 목록을 **어디서 끌어오는가**와 검색·순위·커서가 이 파일의 검증 대상이다.
//
// 가장 중요한 성질: 팔레트가 자기 목록을 따로 들고 있지 않다는 것. 기능이 늘 때 두 곳을 고쳐야 하면
// 그 순간부터 "팔레트에만 없는 기능"이 생긴다 — 아래 첫 블록이 그 연결을 붙잡는다.
import { describe, it, expect } from 'vitest'
import { KEYMAP } from '../src/shared/keymap'
import { MENUBAR } from '../src/renderer/interactions/actions'
import { filterPalette, groupPalette, moveCursor, paletteItems } from '../src/renderer/store/palette'
import type { ConnectionProfile, WorkProfile } from '../src/shared/types'

const PROFILES = [
  {
    id: 'p1',
    name: '배포서버',
    type: 'ssh',
    host: '10.20.30.40',
    port: 22,
    username: 'deploy',
    auth: 'password',
    group: null
  } as unknown as ConnectionProfile
]

const WORK: WorkProfile[] = [{ id: 'w1', name: '웹 배포', profileId: 'p1', path: '/srv/web' }]

const items = paletteItems(PROFILES, WORK, false)

describe('팔레트 목록 — 기존 표에서 끌어온다(따로 관리하지 않는다)', () => {
  it('★ 배선된 단축키가 하나도 빠지지 않는다', () => {
    const wired = KEYMAP.filter((k) => k.implemented).map((k) => 'action:' + k.action)
    const got = items.filter((i) => i.kind === 'action').map((i) => i.id)
    expect(got.sort()).toEqual(wired.sort())
  })

  it('★ 눌러도 아무 일 없는 키(implemented:false)는 올리지 않는다 — 치트시트와 같은 규칙', () => {
    for (const k of KEYMAP.filter((x) => !x.implemented)) {
      expect(items.some((i) => i.id === 'action:' + k.action)).toBe(false)
    }
  })

  it('★ 단축키 없는 메뉴 명령도 전부 들어온다(메뉴를 열어 찾지 않아도 되게)', () => {
    const cmds = MENUBAR.flatMap((m) => m.items)
      .flatMap((e) => ('command' in e ? [e.command] : []))
      // 치트시트는 KEYMAP 에 같은 기능이 있어 일부러 뺀다(아래 "중복 걸러내기" 블록이 그걸 본다).
      .filter((c) => c !== 'help.cheatsheet')
    expect(cmds.length).toBeGreaterThan(0)
    for (const c of cmds) expect(items.some((i) => i.id === 'command:' + c)).toBe(true)
  })

  it('서버·즐겨찾기가 실행 가능한 항목으로 들어온다', () => {
    expect(items.find((i) => i.id === 'profile:p1')).toMatchObject({
      kind: 'profile',
      label: '배포서버',
      hint: 'deploy@10.20.30.40:22',
      run: { do: 'connect', profileId: 'p1' }
    })
    expect(items.find((i) => i.id === 'work:w1')).toMatchObject({
      kind: 'work',
      hint: '/srv/web',
      run: { do: 'work', workId: 'w1' }
    })
  })

  it('단축키 표기는 플랫폼을 따른다', () => {
    const win = paletteItems([], [], false).find((i) => i.id === 'action:session.new')
    const mac = paletteItems([], [], true).find((i) => i.id === 'action:session.new')
    expect(win?.hint).toBe('Ctrl+Shift+T')
    expect(mac?.hint).toBe('Cmd+Shift+T')
  })
})

describe('검색', () => {
  it('빈 검색어는 전부 그대로', () => {
    expect(filterPalette(items, '   ')).toHaveLength(items.length)
  })

  it('라벨로 찾는다', () => {
    expect(filterPalette(items, '새 세션').map((i) => i.id)).toContain('action:session.new')
  })

  it('★ 낱말 순서가 뒤바뀌어도 찾힌다 — 기억나는 낱말부터 치게 된다', () => {
    expect(filterPalette(items, '세션 새').map((i) => i.id)).toContain('action:session.new')
  })

  it('영문 별칭(액션 id·호스트)으로도 걸린다', () => {
    expect(filterPalette(items, 'session.new').map((i) => i.id)).toContain('action:session.new')
    expect(filterPalette(items, 'deploy').map((i) => i.id)).toContain('profile:p1')
  })

  it('★ 앞에서 일치하는 것이 위로 온다', () => {
    const ranked = filterPalette(
      [
        { id: 'a', kind: 'action', label: '이전 탭', run: { do: 'action', action: 'tab.prev' } },
        { id: 'b', kind: 'action', label: '탭 번호 이동', run: { do: 'action', action: 'tab.byNumber' } }
      ],
      '탭'
    )
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('없는 낱말은 빈 목록', () => {
    expect(filterPalette(items, '없는기능이름')).toEqual([])
  })
})

describe('묶기·커서', () => {
  it('종류 순서대로 묶고 빈 묶음은 만들지 않는다', () => {
    expect(groupPalette(items).map((g) => g.kind)).toEqual(['action', 'command', 'profile', 'work'])
    // 서버·즐겨찾기가 하나도 없으면 그 머리말도 안 나온다.
    expect(groupPalette(paletteItems([], [], false)).map((g) => g.kind)).toEqual(['action', 'command'])
  })

  it('커서는 끝에서 반대편으로 감아 돈다', () => {
    expect(moveCursor(0, -1, 3)).toBe(2)
    expect(moveCursor(2, 1, 3)).toBe(0)
    expect(moveCursor(1, 1, 3)).toBe(2)
  })

  it('빈 목록에서는 0 (없는 항목을 가리키지 않는다)', () => {
    expect(moveCursor(0, 1, 0)).toBe(0)
    expect(moveCursor(5, -1, 0)).toBe(0)
  })
})

describe('중복 걸러내기', () => {
  it('★ 같은 기능이 두 줄로 뜨지 않는다 — 라벨이 겹치면 단축키 쪽만 남긴다', () => {
    const labels = items.map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('★ 치트시트는 단축키 항목 하나뿐이다 — 메뉴에도 있지만 팔레트에는 한 줄만 올린다', () => {
    const found = items.filter((i) => i.label.includes('치트'))
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe('action:cheatsheet')
  })
})
