import { pushSend } from './util/windowPush'
// 앱 메뉴. setApplicationMenu 를 안 부르면 Electron 기본 메뉴가 붙고, 창이 frame:false 라 안 보여도
// 그 가속키(Ctrl+R 새로고침·Ctrl+Shift+I·Ctrl+W·Ctrl+=/-/0 확대)는 살아 있다. Ctrl+R 은 bash 역검색이라
// 터미널에서 누르면 앱이 새로고침된다 — 그래서 Windows/Linux 는 메뉴를 아예 없앤다(null).
// macOS 는 메뉴가 없으면 Cmd+C/V/X/A·Cmd+Q 가 죽으므로 role 메뉴(앱·편집·창)를 둔다.
// M0 0-9: 그 사이에 ≡ 메뉴와 **같은 표(shared/menubar.ts MENUBAR)** 의 항목을 끼운다. 누르면 그 창에
// 'menu:pick'(id) 을 보내고, 렌더러(TitleBar)가 ≡ 클릭과 같은 길로 실행한다 — 메뉴 막대 전용 배선 없음.
// 단축키는 표시만 한다(registerAccelerator:false) — 실제 키는 렌더러 keydown 이 이미 받으므로 두 번 실행되지 않게.
// ponytail: Win/Linux 개발 빌드도 DevTools 단축키가 없다. 필요하면 before-input-event 로 개발 빌드에서만 건다.
// ponytail: 설정 › 기능에서 끈 항목도 mac 메뉴 막대엔 남는다(main 은 그 값을 모른다) — M1 재구성 때 IPC 로 받는다.
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { KEYMAP } from '../shared/keymap'
import { MENUBAR, menuEntryId, menuEntryLabel, menuGroups, type MenuEntry } from '../shared/menubar'
import ko from '../renderer/i18n/ko.json'

export const MENU_PICK = 'menu:pick'
const t = (key: string): string => (ko as Record<string, string>)[key] ?? key

export function appMenuTemplate(platform: NodeJS.Platform, dev: boolean): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  const leaf = (e: MenuEntry): MenuItemConstructorOptions => {
    const id = menuEntryId(e)
    const mac = 'action' in e ? KEYMAP.find((k) => k.action === e.action)?.mac : undefined
    // 'Cmd+1-9'·'Opt+Arrow' 같은 묶음 표기는 Electron 가속키가 아니다 — 힌트를 뺀다.
    const accel = mac && !/1-9|Arrow/.test(mac) ? mac.replace(/Opt/g, 'Alt') : undefined
    return {
      id,
      label: menuEntryLabel(e, t),
      ...(accel ? { accelerator: accel, registerAccelerator: false } : {}),
      click: (_i, w) => pushSend((w as BrowserWindow | undefined)?.webContents, MENU_PICK, id)
    }
  }
  // ≡ 의 menuBarItems 와 같은 모양: ▸ 묶음은 sub.<id>, 빈 자리(AI 작업)는 비활성 "곧" 한 줄.
  const app: MenuItemConstructorOptions[] = MENUBAR.map((m) => ({
    label: m.title,
    submenu: m.soon
      ? [{ id: 'menu.soon', label: t('menu.soon'), enabled: false }]
      : menuGroups(m.items).map((g) =>
          'items' in g ? { id: 'sub.' + g.sub, label: t('menu.sub.' + g.sub), submenu: g.items.map(leaf) } : leaf(g)
        )
  }))
  const menu: MenuItemConstructorOptions[] = [{ role: 'appMenu' }, { role: 'editMenu' }, ...app, { role: 'windowMenu' }]
  if (dev) menu.push({ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] })
  return menu
}
