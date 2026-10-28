import { describe, it, expect } from 'vitest'
import { FEATURES, featureOf, featuresOf } from '../src/shared/features'
import { KEYMAP } from '../src/shared/keymap'
import { MENUBAR, menuBarItems } from '../src/renderer/interactions/actions'

// 2.0 3단계 — 설정 › 기능. 진입점(메뉴)만 막고, 표의 열쇠(key·menu)는 실제로 있는 것이어야 한다.
describe('기능 표시', () => {
  it('기본 숨김은 쿠버네티스·서버 로그·서버 콘솔 셋, 나머지는 보인다', () => {
    const d = featuresOf(undefined)
    expect(FEATURES.filter((f) => !d[f.id]).map((f) => f.id)).toEqual(['k8s', 'applog', 'console'])
  })

  it('저장값은 boolean 만 받고 모르는 값은 기본으로', () => {
    const d = featuresOf({ k8s: true, monitor: false, ps: 'x', nope: true })
    expect(d.k8s).toBe(true)
    expect(d.monitor).toBe(false)
    expect(d.ps).toBe(true)
    expect('nope' in d).toBe(false)
  })

  it('표의 단축키는 KEYMAP 에, 메뉴 명령은 MENUBAR 에 있다', () => {
    const entries = MENUBAR.flatMap((m) => m.items.map((e) => ('action' in e ? e.action : e.command)))
    for (const f of FEATURES) {
      if (f.key) expect(KEYMAP.some((k) => k.action === f.key), f.id).toBe(true)
      if (f.menu) expect(entries, f.id).toContain(f.menu)
      expect(featureOf(f.key ?? f.menu ?? '')?.id).toBe(f.id)
    }
  })

  it('기본 숨김 셋은 Ctrl+Alt+문자 — 다른 키와 안 겹치고 bash·zsh 기본 M-C- 키를 피한다', () => {
    const combos = KEYMAP.map((k) => k.win)
    expect(new Set(combos).size).toBe(combos.length)
    for (const f of FEATURES.filter((x) => x.hidden)) {
      const win = KEYMAP.find((k) => k.action === f.key)?.win ?? ''
      expect(win, f.id).toMatch(/^Ctrl\+Alt\+[A-Z]$/)
      // bash 5.x 리드라인 M-C-e·g·h·i·j·l·r·y (+ b·d·f 는 판본에 따라) · zsh ^[^D·G·H·L
      expect('BDEFGHIJLRY', f.id).not.toContain(win.slice(-1))
    }
  })

  it('끈 기능은 메뉴에서 빠지고 켜면 돌아온다', () => {
    const view = MENUBAR.findIndex((m) => m.title === '보기')
    const ids = (shown = featuresOf(undefined)) => menuBarItems(view, shown).map((i) => i.id)
    expect(ids()).not.toContain('panel.k8s')
    expect(ids()).toContain('panel.ports')
    expect(ids({ ...featuresOf(undefined), k8s: true, monitor: false })).toEqual(
      expect.arrayContaining(['panel.k8s'])
    )
    expect(ids({ ...featuresOf(undefined), monitor: false })).not.toContain('panel.ports')
  })
})

describe('통합 검색 — 꺼진 기능', () => {
  it('목록에서 빠지지 않고 배지(off)가 붙는다, 기본 숨김은 byDefault', async () => {
    const { paletteItems } = await import('../src/renderer/store/palette')
    const shown = { ...featuresOf(undefined), monitor: false }
    const items = paletteItems([], [], false, shown)
    expect(items.find((i) => i.id === 'action:panel.k8s')?.off).toEqual({ id: 'k8s', byDefault: true })
    expect(items.find((i) => i.id === 'action:panel.ports')?.off).toEqual({ id: 'monitor', byDefault: false })
    expect(items.find((i) => i.id === 'command:panel.sysmon')?.off).toBeUndefined()
  })
})
