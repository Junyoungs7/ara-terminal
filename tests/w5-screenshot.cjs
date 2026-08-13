// W5 아라 멀티 프로바이더 실기동 스크린샷 — 설정 [AI] 섹션만 본다(세션/PTY 배선 불필요).
// ai:*/workspace:* 는 이 파일이 직접 흉내낸다(w3-screenshot.cjs 와 같은 이유·같은 패턴).
//
// 산출물: ① agent_talk/W5-provider-screenshot.png   (프로바이더 선택 + 키 입력 상태)
//         ② agent_talk/W5-compatible-screenshot.png (compatible base URL 입력 + 호스트 표시)
const { app, BrowserWindow, ipcMain } = require('electron')
require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

const UI = {
  ctxMenuStyle: 'list',
  font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 },
  aiProvider: 'anthropic',
  aiModels: { anthropic: 'claude-sonnet-5', openai: 'gpt-5.1', google: 'gemini-2.5-pro', compatible: '' },
  aiCompatibleBaseUrl: ''
}
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 5, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko',
      aiProvider: UI.aiProvider, aiModels: UI.aiModels, aiCompatibleBaseUrl: UI.aiCompatibleBaseUrl }
  }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
}

// hasKey 는 provider 별로 분리 저장되는 실제 동작을 흉내낸다(설계 W5 §구조결정 3).
const KEYED = new Set()
function wireAi() {
  ipcMain.handle('ai:getState', () => ({
    hasKey: KEYED.has(UI.aiProvider),
    provider: UI.aiProvider,
    model: UI.aiModels[UI.aiProvider] ?? '',
    turns: [],
    streaming: false,
    usage: { input: 0, output: 0 }
  }))
  ipcMain.handle('ai:setKey', (_e, { key }) => {
    if (key) KEYED.add(UI.aiProvider)
    else KEYED.delete(UI.aiProvider)
    return { ok: true }
  })
  ipcMain.handle('ai:cancel', () => ({ ok: true }))
  ipcMain.handle('ai:clear', () => ({ ok: true }))
  ipcMain.handle('ai:send', () => ({ turnId: 'x' }))
}

let lastBytes = -1
async function capture(win, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [w, h] = win.getSize()
    win.setSize(w - 1, h)
    await new Promise((r) => setTimeout(r, 300))
    win.setSize(w, h)
    await new Promise((r) => setTimeout(r, 500))
    let img = await win.webContents.capturePage()
    let png = img.toPNG()
    if (png.length === 0) { await new Promise((r) => setTimeout(r, 800)); img = await win.webContents.capturePage(); png = img.toPNG() }
    if (png.length !== lastBytes || attempt === 2) {
      lastBytes = png.length
      writeFileSync(shotPath(name), png)
      console.log('SCREENSHOT ' + name + ' bytes=' + png.length + (attempt > 0 ? ' (attempt ' + (attempt + 1) + ')' : ''))
      return
    }
  }
}

app.whenReady().then(async () => {
  wireWorkspace()
  wireAi()

  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  // 1) 설정 [AI] 열기 → 프로바이더 Seg(4종) 노출 + 키 입력(저장 전, 화면에 password dots) → 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.titlebar .tb-gear')?.click(); await wait(500)
    document.querySelector('.drawer.open .set-nav span[data-section="ai"]')?.click(); await wait(300)
    const keyInput = document.querySelector('.drawer.open input[data-field="ai.key"]')
    if (keyInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(keyInput, 'sk-ant-demo0001')
      keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  await capture(win, 'W5-provider-screenshot.png')

  // 2) compatible 로 전환 → base URL 입력 → 호스트 표시(반출 고지 문구에 실제 호스트) → 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.drawer.open .set-row .seg-ctl button[data-value="compatible"]')?.click(); await wait(300)
    const urlInput = document.querySelector('.drawer.open input[data-field="ai.baseUrl"]')
    if (urlInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(urlInput, 'https://openrouter.ai/api/v1')
      urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(300)
    return document.querySelector('.drawer.open [data-note="ai.export"]')?.textContent || ''
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await capture(win, 'W5-compatible-screenshot.png')

  console.log('W5 screenshots done (provider / compatible)')
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 30000)
