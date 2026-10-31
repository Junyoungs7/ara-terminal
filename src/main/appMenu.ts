// 앱 메뉴. setApplicationMenu 를 안 부르면 Electron 기본 메뉴가 붙고, 창이 frame:false 라 안 보여도
// 그 가속키(Ctrl+R 새로고침·Ctrl+Shift+I·Ctrl+W·Ctrl+=/-/0 확대)는 살아 있다. Ctrl+R 은 bash 역검색이라
// 터미널에서 누르면 앱이 새로고침된다 — 그래서 Windows/Linux 는 메뉴를 아예 없앤다(null).
// macOS 는 메뉴가 없으면 Cmd+C/V/X/A·Cmd+Q 가 죽으므로 role 기반 최소 메뉴만 둔다.
// ponytail: Win/Linux 개발 빌드도 DevTools 단축키가 없다. 필요하면 before-input-event 로 개발 빌드에서만 건다.
import type { MenuItemConstructorOptions } from 'electron'

export function appMenuTemplate(platform: NodeJS.Platform, dev: boolean): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  const menu: MenuItemConstructorOptions[] = [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
  if (dev) menu.push({ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] })
  return menu
}
