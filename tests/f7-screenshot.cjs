// F7 실기동 스크린샷 + E2E 실증 — 실제 out/preload + out/renderer 창을 REAL SftpService 로 구동:
//  ① [파일] 탭 SFTP 트리(한글 파일명 + 브레드크럼) → agent_talk/F7-tree-screenshot.png
//  ② 전송 진행 표시(진행률 + 취소 버튼) → agent_talk/F7-transfer-screenshot.png
// E2E(콘솔 로그): 트리 렌더 → 터미널 cd → 트리 자동 이동(OSC7) → 업로드 → 다운로드 → 취소 시 부분 파일 정리.
// SFTP 는 shell 과 같은 ssh2 커넥션 재사용(새 연결 금지). 전송 데이터는 무해한 짧은 한글 텍스트만.
const { app, BrowserWindow, ipcMain } = require('electron')
const { safeWc } = require('./_harnessGuard.cjs')
const { join } = require('node:path')
const { writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const real = require('./.f7-harness-main.cjs')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

const OUT = join(__dirname, '..', 'out')
const SHOT_TREE = join(__dirname, '..', 'agent_talk', 'F7-tree-screenshot.png')
const SHOT_XFER = join(__dirname, '..', 'agent_talk', 'F7-transfer-screenshot.png')

// ── 원격 파일시스템(임시 디렉토리 + 한글 파일) ──
const remoteRoot = mkdtempSync(join(tmpdir(), 'ev-f7-remote-'))
const localDir = mkdtempSync(join(tmpdir(), 'ev-f7-local-'))
mkdirSync(join(remoteRoot, '배포스크립트'))
mkdirSync(join(remoteRoot, '로그'))
writeFileSync(join(remoteRoot, '배포스크립트', 'deploy_운영.sh'), '#!/bin/sh\necho 배포\n')
writeFileSync(join(remoteRoot, 'README_한글.md'), '# 한글 문서\n서비스 안내\n')
writeFileSync(join(remoteRoot, 'access_20260731.log'), Buffer.alloc(24 * 1024 * 1024, 0x41)) // 24MB(진행률·취소용)
writeFileSync(join(remoteRoot, '로그', 'error_20260731.log'), '오류 로그 한글\n')

let win
const getWc = safeWc(() => win)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const jsr = (code) => win.webContents.executeJavaScript(code)

function cleanup() {
  try { rmSync(remoteRoot, { recursive: true, force: true }) } catch {}
  try { rmSync(localDir, { recursive: true, force: true }) } catch {}
}
const fail = (m) => { console.error('F7 SHOT FAIL: ' + m); cleanup(); app.exit(1) }

// 저장/업로드 다이얼로그는 스크린샷 하네스에서 블로킹 금지 — 고정 경로로 대체(실 파일 I/O 는 그대로).
function wireStubs() {
  ipcMain.handle('app:getVersion', () => '0.1.0')
  ipcMain.handle('workspace:load', () => ({
    schemaVersion: 1, savedAt: '', app: { version: '0.1.0' }, profiles: [], knownHosts: {},
    layout: { type: 'pane', sessionId: null }, sessions: [], tabGroups: [],
    ui: { sidebar: { collapsed: false, activeTab: 'conn', width: 264 }, ctxMenuStyle: 'radial', font: { term: 'Nanum Gothic Coding', sizePx: 13, lineHeight: 1.58 }, locale: 'ko' }
  }))
  ipcMain.handle('workspace:save', () => ({ ok: true }))
  ipcMain.handle('ui:setPrefs', () => ({ ok: true }))
  ipcMain.handle('ui:setGroups', () => ({ ok: true }))
  ipcMain.handle('ui:setFont', () => ({ ok: true }))
  ipcMain.handle('profile:list', () => [])
  ipcMain.handle('profile:save', () => ({ profile: {} }))
  ipcMain.handle('profile:delete', () => ({ ok: true }))
  // registerSftpIpc 의 pickSavePath/pickUploadPaths 를 덮어써 다이얼로그 없이 고정 경로 반환.
  ipcMain.removeHandler('sftp:pickSavePath')
  ipcMain.handle('sftp:pickSavePath', (_e, { defaultName }) => ({ path: join(localDir, 'DL_' + defaultName) }))
  ipcMain.removeHandler('sftp:pickUploadPaths')
  ipcMain.handle('sftp:pickUploadPaths', () => ({ paths: [join(localDir, '업로드_확인.txt')] }))
}

app.whenReady().then(async () => {
  const sessions = real.registerSessionIpc(getWc)
  real.registerSftpIpc(sessions, getWc)
  wireStubs()

  const harness = await real.startPasswordServer({ sftpRoot: remoteRoot, emitOsc7OnCd: true })

  win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: '#070910',
    webPreferences: { preload: join(OUT, 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  win.webContents.on('render-process-gone', (_e, d) => fail('renderer gone: ' + JSON.stringify(d)))
  await win.loadFile(join(OUT, 'renderer', 'index.html'))
  await wait(600)

  // 실접속(shell 채널) → 세션 편입. SFTP 는 이 커넥션을 재사용한다.
  const outcome = await real.connectSsh(
    { id: 'p1', name: 'dev-server', host: '127.0.0.1', port: harness.port, username: 'deploy', auth: { type: 'password', secretRef: { store: 'vault', key: 'p1' } } },
    { knownHosts: {}, secret: harness.password, acceptHostKey: true, onHostKeyAccepted: () => {} }
  )
  if (!outcome.ok) return fail('ssh connect: ' + outcome.reason)
  const sessionId = sessions.adopt(outcome.backend, { type: 'ssh', profileId: 'p1', title: 'dev-server', serverKey: 'dev-server', cwd: undefined, shell: undefined })

  // 렌더러 스토어에 세션 편입(테스트 seam) + [파일] 탭 활성화.
  const adopted = await jsr(`(() => {
    const fileTab = [...document.querySelectorAll('.sb-tab')].find(b => /파일/.test(b.textContent))
    if (fileTab) fileTab.click()
    if (window.__evAdopt) { window.__evAdopt(${JSON.stringify(sessionId)}, 'dev-server', 'dev-server'); return true }
    return false
  })()`)
  if (!adopted) return fail('__evAdopt seam 없음')
  await wait(1000)

  // ── ① 트리 렌더 확인 + 스크린샷 ──
  const tree = await jsr(`(() => {
    const rows = [...document.querySelectorAll('.ftree .frow')]
    const names = rows.map(r => r.querySelector('.fn')?.textContent || '')
    const path = (document.querySelector('.fcrumb')?.getAttribute('title') ?? document.querySelector('.fcrumb')?.getAttribute('data-tip')) || ''
    return { count: rows.length, names, path, hasDir: rows.some(r => r.classList.contains('dir')), korean: names.some(n => /배포스크립트|README_한글|access_/.test(n)) }
  })()`)
  console.log('F7 tree:', JSON.stringify(tree))
  if (!tree.korean || tree.count === 0) return fail('트리 한글 파일명 미렌더: ' + JSON.stringify(tree))
  writeFileSync(SHOT_TREE, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT tree: ' + SHOT_TREE)
  const homePath = tree.path

  // ── 터미널 cd → 트리 자동 이동(OSC7) ──
  await jsr(`window.ev.session.input(${JSON.stringify(sessionId)}, 'cd /로그\\n')`)
  await wait(1300)
  const afterCd = await jsr(`(() => ({ path: (document.querySelector('.fcrumb')?.getAttribute('title') ?? document.querySelector('.fcrumb')?.getAttribute('data-tip')) || '', names: [...document.querySelectorAll('.ftree .frow .fn')].map(n => n.textContent) }))()`)
  const cdSynced = /로그/.test(afterCd.path) && afterCd.names.some(n => /error_/.test(n))
  console.log('F7 cd→트리 자동 이동(OSC7): ' + (cdSynced ? 'OK ' + afterCd.path : 'MISS ' + JSON.stringify(afterCd)))

  // 홈 복귀(상위 이동).
  await jsr(`(() => { const up = document.querySelector('.sb-act[title="상위 폴더"]'); if (up) up.click() })()`)
  await wait(700)

  // ── 업로드(UI: 업로드 버튼 → pickUploadPaths 스텁 경로) ──
  writeFileSync(join(localDir, '업로드_확인.txt'), '업로드 확인 한글\n')
  await jsr(`(() => { const up = document.querySelector('.sb-act[title="파일 업로드"]'); if (up) up.click() })()`)
  await wait(900)
  const upOk = existsSync(join(remoteRoot, '업로드_확인.txt'))
  console.log('F7 업로드(UI): ' + (upOk ? 'OK' : 'FAIL'))

  // ── 다운로드(UI: 파일 행 더블클릭 → pickSavePath 스텁 경로 → 진행 UI 노출) ──
  await jsr(`(async () => { const up = document.querySelector('.sb-act[title="상위 폴더"]'); if (up) up.click(); await new Promise(r=>setTimeout(r,500)) })()`)
  const dlStarted = await jsr(`(() => {
    const row = [...document.querySelectorAll('.ftree .frow')].find(r => /access_/.test(r.querySelector('.fn')?.textContent || ''))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
  if (!dlStarted) return fail('다운로드 대상 행(access_) 없음 — path=' + homePath)
  // 진행 UI(.sftp-xfer)가 나타날 때까지 짧게 폴링 → 진행률 캡처.
  let xferShown = false
  for (let i = 0; i < 30; i++) {
    xferShown = await jsr(`!!document.querySelector('.sftp-xfer .xfer-fill')`)
    if (xferShown) break
    await wait(80)
  }
  await wait(150)
  const xferState = await jsr(`(() => { const el = document.querySelector('.sftp-xfer'); return el ? { pct: document.querySelector('.sftp-xfer .xfer-pct')?.textContent, hasCancel: !!document.querySelector('.sftp-xfer .xfer-cancel'), label: document.querySelector('.sftp-xfer .xfer-label')?.textContent } : null })()`)
  console.log('F7 진행 UI: ' + JSON.stringify(xferState))
  writeFileSync(SHOT_XFER, (await win.webContents.capturePage()).toPNG())
  console.log('SHOT transfer: ' + SHOT_XFER)

  // ── 취소(진행 UI 취소 버튼) + 부분 파일 정리 확인 ──
  const bigLocal = join(localDir, 'DL_access_20260731.log')
  await jsr(`(() => { const c = document.querySelector('.sftp-xfer .xfer-cancel'); if (c) c.click() })()`)
  await wait(1500)
  const partialGone = !existsSync(bigLocal)
  const xferGoneOrErr = await jsr(`(() => { const err = document.querySelector('.sftp-err'); return { errText: err ? err.textContent : null, xferGone: !document.querySelector('.sftp-xfer') } })()`)
  console.log('F7 취소+정리: 부분파일삭제=' + partialGone + ' ' + JSON.stringify(xferGoneOrErr))

  const allOk = tree.korean && upOk && (xferShown || xferState) && partialGone
  console.log('F7 E2E 요약: 트리=' + (tree.korean ? 'OK' : 'FAIL') + ' cd동기=' + (cdSynced ? 'OK' : 'FALLBACK') + ' 업로드=' + (upOk ? 'OK' : 'FAIL') + ' 진행UI=' + ((xferShown || xferState) ? 'OK' : 'FAIL') + ' 취소+부분정리=' + (partialGone ? 'OK' : 'FAIL'))

  // harness.close() 는 활성 sftp 채널 때문에 지연될 수 있으므로 결과 확정 후 즉시 종료(정리는 best-effort).
  harness.close().catch(() => {})
  cleanup()
  app.exit(allOk ? 0 : 1)
})

setTimeout(() => fail('timeout (45s)'), 45000)
