// 다중 모니터 RDP 창 — 고른 모니터들을 감싸는 자리에 테두리 없는 창을 하나 띄운다.
//
// 왜 별도 창인가: 탭 안의 뷰는 앱 창 안에서만 커질 수 있다. 모니터 두 장에 걸치려면 창 자체가
// 두 장에 걸쳐야 한다. EditorWindows.ts 와 같은 방식으로 **같은 렌더러 번들을 해시로 갈라** 쓴다
// (별도 진입점·별도 preload 없음).
//
// 왜 fullscreen 이 아닌가: fullscreen 은 모니터 하나에만 걸린다(OS 개념이 그렇다). 그냥 큰
// 테두리 없는 창이어야 여러 장을 덮는다. 그리고 kiosk 를 쓰지 않으므로 **Alt+Tab 으로 언제든
// 빠져나올 수 있다** — 화면을 통째로 덮는 창에서 이 탈출구는 필수다(창 안에도 마우스를 위로
// 올리면 나오는 막대를 둔다).
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { pushSend } from '../util/windowPush'
import { monitorWindowBox, planSpan, type SpanDisplay, type SpanPlan } from '@shared/rdpSpan'

const BACKGROUND = '#000000'

// 프로필당 창 하나. 같은 서버를 두 번 펼치면 새로 만들지 않고 있던 창을 앞으로 가져온다 —
// 같은 계정으로 RDP 를 두 번 붙으면 서버가 앞의 세션을 끊는다(연결이 서로를 걷어찬다).
const windows = new Map<string, BrowserWindow>()
// 창이 뜬 뒤 자기 계획(모니터별 좌표)을 물어본다 — 해시에 JSON 을 밀어 넣으면 URL 이 지저분해지고
// 인코딩 사고가 난다.
const plans = new Map<string, SpanPlan>()

export function rdpSpanPlan(profileId: string): SpanPlan | null {
  return plans.get(profileId) ?? null
}

export function listDisplays(): SpanDisplay[] {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor
  }))
}

export type OpenSpanResult = { ok: true; plan: SpanPlan } | { ok: false; message: string }

export function openRdpSpanWindow(
  profileId: string,
  name: string,
  displayIds: number[],
  getParent: () => BrowserWindow | null
): OpenSpanResult {
  const existing = windows.get(profileId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return { ok: false, message: '이미 이 서버를 다중 모니터로 열어 두었습니다.' }
  }

  const displays = listDisplays()
  const plan = planSpan(displays, displayIds.length > 0 ? displayIds : displays.map((d) => d.id))
  if (!plan) return { ok: false, message: '펼칠 모니터를 찾지 못했습니다.' }

  // 이 창은 **주 모니터 한 장만** 덮는다. 나머지 모니터는 렌더러가 window.open 으로 창을 하나씩
  // 열어 같은 프레임버퍼를 잘라 보여 준다(renderer/store/rdpMirror.ts). 큰 창 하나로 걸치면
  // 로컬에서도 창이 하나라 Alt+Tab·최소화가 모니터별로 안 된다 — 준영님이 창 분리를 고른 이유다.
  const hostBox = (plan.monitors.find((m) => m.primary) ?? plan.monitors[0])?.window ?? plan.bounds

  const parent = getParent()
  const win = new BrowserWindow({
    ...hostBox,
    // 부모를 붙이지 않는다: 부모 창을 최소화하면 자식도 함께 내려가는데, 이 창은 모니터를
    // 통째로 쓰는 독립 화면이라 앱 창과 수명을 묶으면 오히려 불편하다.
    frame: false,
    title: name,
    backgroundColor: BACKGROUND,
    show: false,
    // 화면을 꽉 채우는 창이라 그림자·둥근 모서리가 의미 없고, 일부 드라이버에서 경계에 틈이 생긴다.
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  windows.set(profileId, win)
  plans.set(profileId, plan)
  win.on('closed', () => {
    if (windows.get(profileId) === win) windows.delete(profileId)
    plans.delete(profileId)
    // 앱 창의 탭이 "다른 창에서 보는 중" 표시를 걷을 수 있게 알린다.
    pushSend(parent && !parent.isDestroyed() ? parent.webContents : null, 'rdp:spanClosed', { profileId })
  })
  win.once('ready-to-show', () => {
    // setBounds 를 한 번 더 준다 — 생성자 bounds 는 작업 영역으로 잘리는 플랫폼이 있는데(실측:
    // 949 요청이 901 로 깎였다, 작업표시줄 48px) 우리는 작업표시줄까지 덮어야 한다.
    win.setBounds(hostBox)
    win.show()
  })

  // 렌더러가 나머지 모니터를 window.open 으로 연다. 기본대로 두면 테두리 있는 보통 창이 떠
  // 모니터를 다 못 덮는다 — 여기서 테두리를 걷고 자리를 잡아 준다. 이름이 우리 것이 아니면 막는다
  // (원격 화면 창에서 임의 창이 열리는 길을 남기지 않는다).
  //
  // **좌표는 features 문자열에서 읽지 않는다**(2026-08-17). 그렇게 짜여 있었는데 정규식이
  // 템플릿 리터럴 안에서 `\d` → `d` 로 죽어 **한 번도 매치된 적이 없었다** — 넷 다 undefined 라
  // 자식 창이 기본 크기(800×600)로 주 모니터에 떠, 이 창 뒤에 가려졌다. 준영님 눈에는
  // "다른 모니터에 새 창이 안 생긴다"로 보였다(제보 ⑨).
  //
  // 고치는 김에 경로를 짧게 했다: 좌표의 출처는 **우리가 방금 만든 plan** 이다. 렌더러가 그 값을
  // 문자열로 되돌려주는 것을 다시 파싱할 이유가 없다 — frameName 의 모니터 id 로 plan 에서 꺼낸다.
  // 그러면 파싱 자체가 사라지고, 모르는 id 는 열리지 않는다.
  win.webContents.setWindowOpenHandler(({ frameName }) => {
    const box = monitorWindowBox(plan, frameName)
    if (!box) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: false,
        hasShadow: false,
        backgroundColor: BACKGROUND,
        ...box,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
      }
    }
  })

  const hash =
    '#rdpwin?profile=' +
    encodeURIComponent(profileId) +
    '&name=' +
    encodeURIComponent(name) +
    '&w=' +
    plan.remote.width +
    '&h=' +
    plan.remote.height +
    '&monitors=' +
    plan.count
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl + hash)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
  return { ok: true, plan }
}

export function closeRdpSpanWindow(profileId: string): void {
  const win = windows.get(profileId)
  if (win && !win.isDestroyed()) win.close()
  windows.delete(profileId)
}

/** 앱을 끝낼 때 남은 창을 정리한다(릴레이도 함께 닫힌다 — 렌더러 언마운트가 relayStop 을 부른다). */
export function closeAllRdpSpanWindows(): void {
  for (const win of windows.values()) if (!win.isDestroyed()) win.destroy()
  windows.clear()
}
