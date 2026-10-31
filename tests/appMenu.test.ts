// 기본 메뉴의 Ctrl+R(새로고침)이 터미널의 bash 역검색을 가로채지 않는지 — appMenu.ts 참조.
import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../src/main/appMenu'

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
