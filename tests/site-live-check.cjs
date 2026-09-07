// 배포된 사이트가 **화면에 실제로 무엇을 보여 주는지** 잰다 (offscreen · 창 안 뜬다).
//
// 왜 필요한가(2026-09-06): index.html 의 정적 본문에는 `0.1.0 · 92.1 MB · 2026-08-23` 이 그대로
// 박혀 있다. 진짜 값은 assets/release.js 의 window.ARA_RELEASE 이고 site.js 가 실행될 때
// [data-rel] 텍스트와 [data-dl] href 를 갈아 끼운다. **HTML 만 읽으면 낡은 값을 보게 된다** —
// curl 로 본문을 긁어 확인하면 0.1.0 이 나온다. 사람이 보는 것은 스크립트가 돈 뒤의 화면이다.
//
// 돌리는 법:  npx electron tests/site-live-check.cjs [주소]
//             기본 주소 http://192.168.100.56:8899/

const { app, BrowserWindow } = require('electron')

const URL = process.argv[2] && /^https?:/.test(process.argv[2]) ? process.argv[2] : 'http://192.168.100.56:8899/'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// offscreen 창은 GPU 상태를 잃으면 두 번째부터 ERR_FAILED 가 난다(tip-check.cjs 실측).
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false, // 🔴 준영님 화면 위로 창이 뜨면 그 자체가 방해다
    webPreferences: { offscreen: true, sandbox: true }
  })

  let out = { url: URL }
  try {
    await win.loadURL(URL)
    await wait(1500) // site.js 가 돌 시간
    out = await win.webContents.executeJavaScript(`(() => {
      const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null }
      const dl = [...document.querySelectorAll('[data-dl]')].map((a) => a.getAttribute('href'))
      return {
        url: location.href,
        title: document.title,
        version: txt('[data-rel="version"]'),
        size: txt('[data-rel="size"]'),
        date: txt('[data-rel="date"]'),
        file: txt('[data-rel="file"]'),
        dlHrefs: [...new Set(dl)],
        // 낡은 값이 화면 어딘가에 남아 있나 — 스크립트가 못 갈아 끼운 자리를 잡는다
        staleOnScreen: /0\\.1\\.0|92\\.1 MB|2026-08-23/.test(document.body.innerText),
        manualLink: !!document.querySelector('a[href*="manual"]')
      }
    })()`)
  } catch (e) {
    out.error = String(e && e.message ? e.message : e)
  }

  console.log(JSON.stringify(out, null, 1))

  // 판정: 화면의 버전이 release.js 와 같고, 내려받기 주소가 그 파일을 가리키고, 낡은 값이 없어야 한다
  const ok =
    !out.error &&
    out.version &&
    out.file &&
    out.dlHrefs.length > 0 &&
    out.dlHrefs.every((h) => h && h.includes(encodeURIComponent(out.file))) &&
    !out.staleOnScreen
  console.log(ok ? 'SITE OK' : 'SITE 확인 필요')

  win.destroy()
  app.exit(ok ? 0 : 1)
})
