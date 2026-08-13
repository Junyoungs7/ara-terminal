// W3 F16 아라 실기동 스크린샷 — ARA_AI_FAKE 배선 그대로 두고(실 AraSession 은 쓰지 않음), 세션/워크스페이스는
// 다른 screenshot 하네스와 같은 최소 배선. ai:* 는 이 파일이 직접 흉내낸다 — 실 AraSession 은 main/index.ts
// 배선(vault·safeStorage)이 필요해 하네스가 그대로 재사용하기엔 무겁고, 다른 화면(session/workspace)도
// 이미 이 패턴으로 가짜 배선한다(f5-screenshot.cjs 참고). 캔드 스트림은 100ms 간격 delta — 설계 §7 S4 의
// ARA_AI_FAKE 캔드 제너레이터와 같은 모양(코드블록 1개 포함, 조각내어 방출).
//
// 산출물: ① agent_talk/W3-panel-screenshot.png   (패널+스트리밍 답변, 코드블록 포함)
//         ② agent_talk/W3-context-screenshot.png (컨텍스트 칩 미리보기 펼침, 비밀 마스킹)
//         ③ agent_talk/W3-settings-screenshot.png (설정 [AI] 섹션)
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const pty = require('node-pty')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const shotPath = (name) => join(__dirname, '..', 'agent_talk', name)

let getWc = () => null

// ── 세션 IPC (smoke-boot.cjs 와 같은 attach/backlog 패턴 — TerminalPane 이 attach 를 기다린다) ──
const ptys = new Map()
const BACKLOG = new Map()
const backlogOf = (id) => {
  let st = BACKLOG.get(id)
  if (!st) BACKLOG.set(id, (st = { chunks: [], attached: false }))
  return st
}
function pushData(id, d) {
  const b = Buffer.from(d, 'utf8')
  const u = new Uint8Array(b.length)
  u.set(b)
  const st = backlogOf(id)
  st.chunks.push(u)
  if (!st.attached) return
  const wc = getWc()
  if (!wc || wc.isDestroyed()) return
  wc.postMessage('session:data:' + id, u)
}
function attachBacklog(id) {
  const st = backlogOf(id)
  st.attached = true
  const total = st.chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of st.chunks) { out.set(c, off); off += c.length }
  return out
}
function wireLocal() {
  ipcMain.handle('session:attach', (_e, { id }) => ({ backlog: attachBacklog(id) }))
  ipcMain.handle('session:create', () => {
    const id = 'loc-' + Math.random().toString(36).slice(2)
    const win = process.platform === 'win32'
    const opts = { name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(), env: process.env }
    if (win) { opts.useConpty = true; opts.useConptyDll = true }
    const p = pty.spawn(win ? 'powershell.exe' : '/bin/sh', win ? ['-NoLogo'] : [], opts)
    ptys.set(id, p)
    p.onData((d) => pushData(id, d))
    p.onExit(() => ptys.delete(id))
    return { id }
  })
  ipcMain.handle('session:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(cols, rows) } catch {}; return { ok: true } })
  ipcMain.handle('session:destroy', (_e, { id }) => { try { ptys.get(id)?.kill() } catch {}; ptys.delete(id); return { ok: true } })
  ipcMain.handle('session:list', () => [])
  ipcMain.handle('session:rename', () => ({ ok: true }))
  ipcMain.handle('session:autoTitle', () => ({ applied: false }))
  ipcMain.on('session:input', (_e, { id, data }) => ptys.get(id)?.write(data))
  ipcMain.on('session:pause', () => {})
  ipcMain.on('session:resume', () => {})
}

const UI = { ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, aiModel: 'claude-sonnet-5' }
function wireWorkspace() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: UI.ctxMenuStyle, font: UI.font, locale: 'ko', aiModel: UI.aiModel }
  }))
  ipcMain.handle('ui:setPrefs', (_e, prefs) => { Object.assign(UI, prefs); return { ok: true } })
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', (_e, font) => { UI.font = font; return { ok: true } })
}

// ── ai:* IPC 캔드 배선 — 실 AraSession 과 같은 전송 계약(getState/send→turnId/delta.../end). ──
// 답변에 코드블록 하나 + 앞뒤 텍스트(설계 §4.4 splitBlocks 요구사항과 같은 모양).
const ANSWER_CHUNKS = [
  '로그 디렉터리 용량을 확인하려면 아래 명령을 실행하십시오.\n\n',
  '```bash\n',
  'du -sh /var/log/*\n',
  '```\n\n',
  '결과에서 상위 항목을 정리하면 공간을 회복할 수 있습니다.'
]
let usage = { input: 0, output: 0 }
function wireAi() {
  ipcMain.handle('ai:getState', () => ({ hasKey: true, model: UI.aiModel, turns: [], streaming: false, usage }))
  ipcMain.handle('ai:setKey', () => ({ ok: true }))
  ipcMain.handle('ai:cancel', () => ({ ok: true }))
  ipcMain.handle('ai:clear', () => ({ ok: true }))
  ipcMain.handle('ai:send', () => {
    const turnId = 'w3-' + Math.random().toString(36).slice(2)
    ;(async () => {
      for (const chunk of ANSWER_CHUNKS) {
        await new Promise((r) => setTimeout(r, 100))
        const wc = getWc()
        if (wc && !wc.isDestroyed()) wc.send('ai:delta', { turnId, text: chunk })
      }
      usage = { input: usage.input + 42, output: usage.output + 96 }
      const wc = getWc()
      if (wc && !wc.isDestroyed()) wc.send('ai:end', { turnId, ok: true })
    })()
    return { turnId }
  })
}

// capturePage() 는 가끔 직전 프레임(리사이즈-리페인트가 아직 안 반영된 프레임)을 돌려준다
// (연속 캡처에서 관찰된 1스텝 지연). 직전 캡처와 바이트가 같으면 한 번 더 리페인트하고 재시도한다.
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
  let win
  getWc = safeWc(() => win)
  wireLocal()
  wireWorkspace()
  wireAi()

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await new Promise((r) => setTimeout(r, 700))

  // 로컬 세션 생성(＋ → 로컬 셸) — 컨텍스트 첨부 대상 + [터미널로 보내기] 목적지.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.tterm-add')?.click(); await wait(200)
    document.querySelector('.ctx-menu .ctx-item[data-action="local.new"]')?.click(); await wait(700)
    return true
  })()`)
  // 셀렉트 대상 없는 비밀 값을 셀에 찍어 둔다 — 컨텍스트 첨부 시 maskSecrets() 마스킹을 스크린샷으로 실증.
  for (const [, p] of ptys) {
    try {
      p.write('echo "환경변수 확인: export TOKEN=abc123 (배포용)"\r')
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1000))

  // 1) 아라 패널 열기 → 질문 전송 → 스트리밍 완료 대기(코드블록 포함 답변) → 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.titlebar .tb-ai')?.click(); await wait(400)
    const ta = document.querySelector('.ai-panel .ai-input')
    if (ta) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, '/var/log 용량이 큰데 어떻게 확인하나요')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.querySelector('.ai-panel [data-action="ai.send"]')?.click()
    await wait(1200)
    return document.querySelectorAll('.ai-panel .ai-code').length
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await capture(win, 'W3-panel-screenshot.png')

  // 2) 컨텍스트 칩 on → 미리보기 펼침(비밀 마스킹된 전문 표시) → 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.ai-panel [data-action="ai.ctxToggle"]')?.click(); await wait(500)
    return document.querySelector('.ai-panel .ai-ctx-full.compose')?.textContent || ''
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await capture(win, 'W3-context-screenshot.png')

  // 3) 설정 [AI] 섹션 캡처.
  await win.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    document.querySelector('.titlebar .tb-ai')?.click(); await wait(400) // 패널 닫기(겹치지 않게)
    document.querySelector('.titlebar .tb-gear')?.click(); await wait(600)
    document.querySelector('.drawer.open .set-nav span[data-section="ai"]')?.click(); await wait(400)
    return !!document.querySelector('.drawer.open')
  })()`)
  await new Promise((r) => setTimeout(r, 600))
  await capture(win, 'W3-settings-screenshot.png')

  console.log('W3 screenshots done (panel / context / settings)')
  for (const p of ptys.values()) { try { p.kill() } catch {} }
  app.exit(0)
})

setTimeout(() => { console.log('screenshot timeout'); app.exit(1) }, 30000)
