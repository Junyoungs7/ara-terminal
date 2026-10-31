// 기본 메뉴의 Ctrl+R(새로고침)이 터미널의 bash 역검색을 가로채지 않는지 — appMenu.ts 참조.
import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../src/main/appMenu'
import { MENUBAR, menuBarItems } from '../src/renderer/interactions/actions'

const roles = (m: MenuItemConstructorOptions[] | null): string[] =>
  (m ?? []).flatMap((i) => [i.role ?? '', ...roles(Array.isArray(i.submenu) ? i.submenu : null)])

describe('appMenuTemplate', () => {
  it('Windows/Linux 는 메뉴가 없다(가속키도 없다)', () => {
    expect(appMenuTemplate('win32', false)).toBeNull()
    expect(appMenuTemplate('linux', false)).toBeNull()
    expect(appMenuTemplate('win32', true)).toBeNull()
  })

  it('macOS 배포판은 편집·창 메뉴만 있고 reload·DevTools 는 없다', () => {
    const r = roles(appMenuTemplate('darwin', false))
    expect(r).toEqual(expect.arrayContaining(['appMenu', 'editMenu', 'windowMenu']))
    expect(r).not.toContain('reload')
    expect(r).not.toContain('forceReload')
    expect(r).not.toContain('toggleDevTools')
    expect(r).not.toContain('viewMenu') // 기본 viewMenu 에 reload 가 들어 있다
  })

  it('macOS 개발 빌드에만 reload·DevTools 가 있다', () => {
    expect(roles(appMenuTemplate('darwin', true))).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']))
  })
})

// M0 0-9: ≡ 팝업과 mac 메뉴 막대가 한 표(shared/menubar.ts)에서 나오는지.
describe('mac 메뉴 막대 = ≡ 메뉴', () => {
  const tpl = appMenuTemplate('darwin', false) ?? []
  const appMenus = tpl.filter((m) => !m.role)

  it('제목·순서·항목 id·라벨이 ≡ 와 같다', () => {
    expect(appMenus.map((m) => m.label)).toEqual(MENUBAR.map((m) => m.title))
    MENUBAR.forEach((_, i) => {
      const sub = appMenus[i].submenu as MenuItemConstructorOptions[]
      expect(sub.map((s) => [s.id, s.label])).toEqual(menuBarItems(i).map((it) => [it.id, it.label]))
    })
  })

  it('단축키는 표시만 한다(렌더러 keydown 과 두 번 실행되지 않게)', () => {
    const items = appMenus.flatMap((m) => m.submenu as MenuItemConstructorOptions[])
    expect(items.some((s) => s.accelerator)).toBe(true)
    for (const s of items) if (s.accelerator) expect(s.registerAccelerator).toBe(false)
  })

  it('누르면 그 창에 menu:pick(id) 을 보낸다', () => {
    const item = (appMenus[0].submenu as MenuItemConstructorOptions[])[0]
    const sent: unknown[] = []
    const win = { webContents: { send: (...a: unknown[]) => sent.push(a) } }
    ;(item.click as (...a: unknown[]) => void)(item, win, {})
    expect(sent).toEqual([['menu:pick', item.id]])
  })
})
