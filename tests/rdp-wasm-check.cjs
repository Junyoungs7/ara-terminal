// RDP wasm 초기화 실기동 검사 — 렌더러의 실제 CSP 아래에서 클라이언트가 인스턴스화되는지.
//
// 왜 따로 필요한가: e2e(RDP-6)는 RdpView 가 뜨는 것까지만 본다. wasm 은 **비밀번호가 확보된 뒤에야**
// 불러오므로 실서버 없이는 그 경로를 안 지난다 — 즉 패키지를 갈아타거나 CSP 를 조이면 조용히 깨진 채
// 통과한다. 공식 패키지(@devolutions/iron-remote-desktop-rdp)는 wasm 을 base64 data: URL 로 내장해
// fetch 로 읽는데, 그게 connect-src 에 걸리면 여기서만 잡힌다.
//
// 실제 접속은 하지 않는다(서버가 필요하다). import → init → Backend 클래스 생성까지만 확인한다.
const { app, BrowserWindow } = require('electron')
require('./_harnessGuard.cjs')
const { mkdtempSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
app.setPath('userData', mkdtempSync(join(tmpdir(), 'ofa-rdpwasm-')))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function finish(code, lines) {
  for (const l of lines) console.log(l)
  await wait(200)
  app.exit(code)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false }
  })
  // 프로덕션 번들을 그대로 띄운다 — CSP(meta 태그)와 청크 분할이 실제와 같아야 의미가 있다.
  await win.loadFile(join(__dirname, '..', 'out', 'renderer', 'index.html'))
  await wait(1500)

  // 번들러가 만든 실제 청크를 직접 불러온다. 페이지 안에서 베어 스펙파이어('@devolutions/…')는
  // 해석되지 않는다(빌드 시점에 청크로 치환되므로) — 산출물 파일명을 찾아 상대 경로로 import 한다.
  const assets = join(__dirname, '..', 'out', 'renderer', 'assets')
  const chunk = readdirSync(assets).find((f) => f.startsWith('iron-remote-desktop-rdp-') && f.endsWith('.js'))
  if (!chunk) return finish(1, ['FAIL RDP 청크가 빌드 산출물에 없다 — npm run build 먼저'])

  const res = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const mod = await import('./assets/${chunk}')
        if (typeof mod.init !== 'function') return { ok: false, at: 'init 없음' }
        await mod.init('error')
        // Backend 클래스가 실제로 만들어지는지(= wasm 이 살아 있는지) 확인한다.
        const size = new mod.Backend.DesktopSize(1920, 1080)
        const tx = new mod.Backend.InputTransaction()
        tx.addEvent(mod.Backend.DeviceEvent.keyPressed(0x1e))
        const clip = new mod.Backend.ClipboardData()
        clip.addText('text/plain', 'ara')
        const ext = [typeof mod.enableCredssp, typeof mod.displayControl].join(',')
        // 파일 전송 provider — 확장 목록까지 실제로 만들어지는지(연결 없이 확인 가능한 지점).
        let xfer = 'no'
        if (typeof mod.RdpFileTransferProvider === 'function') {
          const p = new mod.RdpFileTransferProvider({ chunkSize: 64 * 1024 })
          const exts = p.getBuilderExtensions()
          xfer = Array.isArray(exts) && exts.length > 0 ? 'ok:' + exts.length : 'empty'
          p.dispose()
        }
        // 다중 모니터 경계(우리 포크에만 있다 — vendor/README.md). 확장 객체가 나오면 배선이 산 것이다.
        let mon = 'no'
        if (typeof mod.monitorLayout === 'function') {
          const e = mod.monitorLayout([
            { left: 0, top: 0, right: 1919, bottom: 1079, primary: true },
            { left: 1920, top: 0, right: 3839, bottom: 1079 }
          ])
          mon = e && typeof e === 'object' ? 'ok' : 'empty'
        }
        return { ok: true, w: size.width, h: size.height, clipEmpty: clip.isEmpty(), ext, xfer, mon }
      } catch (e) {
        return { ok: false, at: String(e && e.message ? e.message : e) }
      }
    })()
  `)

  const checks = [
    ['wasm import + init 성공', res.ok === true, res.ok ? '' : res.at],
    ['DesktopSize 생성(1920x1080)', res.w === 1920 && res.h === 1080],
    ['InputTransaction + DeviceEvent 생성', res.ok === true],
    ['ClipboardData.addText 반영', res.clipEmpty === false],
    ['확장 팩토리 존재(enableCredssp·displayControl)', res.ext === 'function,function'],
    ['파일 전송 provider 생성 + 확장 목록', typeof res.xfer === 'string' && res.xfer.startsWith('ok:'), res.xfer],
    // 이게 FAIL 이면 vendor 포크가 아니라 업스트림 패키지를 물고 있는 것이다(package.json 의 file: 참조 확인).
    ['다중 모니터 경계 확장(포크 전용)', res.mon === 'ok', res.mon]
  ]
  const lines = checks.map(([name, pass, extra]) => `${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
  const failed = checks.filter(([, p]) => !p).length
  lines.push(`--- ${failed === 0 ? 'PASS' : 'FAIL'} ${checks.length - failed}/${checks.length}`)
  await finish(failed === 0 ? 0 : 1, lines)
})
