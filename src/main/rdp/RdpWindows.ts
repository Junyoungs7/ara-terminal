// 다중 모니터 RDP 창 — 고른 모니터마다 **창이 있는 전체화면** 창을 하나씩 띄운다.
//
// 왜 별도 창인가: 탭 안의 뷰는 앱 창 안에서만 커질 수 있다. 모니터 두 장을 쓰려면 창이 두 장이어야
// 한다. EditorWindows.ts 와 같은 방식으로 **같은 렌더러 번들을 해시로 갈라** 쓴다(별도 진입점·별도
// preload 없음). 이 창은 주 모니터를 맡고, 나머지 모니터는 렌더러가 window.open 으로 하나씩 열어
// 같은 프레임버퍼를 잘라 보여 준다(renderer/store/rdpMirror.ts).
//
// **왜 테두리를 되돌렸나(2026-09-04 준영님 실기 제보).** 전에는 `frame:false` 로 작업표시줄까지
// 덮었고, 나갈 길이 없어 "마우스를 맨 위로 올리면 내려오는 막대"를 뒀다. 그런데 원격 브라우저의
// 제목 표시줄이 정확히 그 자리라 둘이 같은 픽셀을 두고 싸웠고, 테두리 없는 자식 창은 위를 잡아
// 끌면 Windows 가 크기 복원으로 읽어 창이 작아졌다. 테두리를 되돌리니 셋이 한꺼번에 풀린다 —
// 진짜 제목 표시줄이 닫기·이동·Alt+Tab 을 맡고, 원격 화면은 그 아래에서 시작한다.
//
// 그 대신 **원격에 알릴 크기를 다시 재야 한다**: 보이는 자리가 모니터보다 작아졌는데 옛 값(모니터
// 전체)으로 붙으면 화면이 잘린다. 테두리 두께는 창을 만들어 `getBounds()` 와 `getContentBounds()`
// 의 차이로 재고(짐작하지 않는다), 잰 값으로 계획을 세운 뒤 창을 띄울 때 `setContentBounds` 로
// **내용 영역을 계획값에 정확히 맞춘다** — 재기가 조금 어긋나도 원격 화면은 안 잘린다.
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { pushSend } from '../util/windowPush'
import {
  monitorByFrame,
  planSpan,
  spanOrigin,
  SPAN_HEADER_H,
  type SpanChrome,
  type SpanDisplay,
  type SpanPlan
} from '@shared/rdpSpan'

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
    // 작업표시줄을 뺀 자리. 모니터마다 다를 수 있어 OS 값을 그대로 쓴다(우리가 재지 않는다).
    workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
    scaleFactor: d.scaleFactor
  }))
}

/**
 * 제목 표시줄·테두리가 먹는 폭(DIP). 창을 하나 만들어 **재는** 값이다 — 플랫폼·테마·배율마다
 * 다르고, 틀리면 원격 화면이 그만큼 잘린다.
 */
function frameInsets(win: BrowserWindow): SpanChrome['frame'] {
  const b = win.getBounds()
  const c = win.getContentBounds()
  return {
    left: Math.max(0, c.x - b.x),
    top: Math.max(0, c.y - b.y),
    right: Math.max(0, b.x + b.width - (c.x + c.width)),
    bottom: Math.max(0, b.y + b.height - (c.y + c.height))
  }
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
  const ids = displayIds.length > 0 ? displayIds : displays.map((d) => d.id)
  // 계획보다 창이 먼저다 — 테두리를 재려면 창이 있어야 하고, 창을 놓으려면 주 모니터를 먼저 정해야 한다.
  const origin = spanOrigin(displays, ids)
  if (!origin) return { ok: false, message: '펼칠 모니터를 찾지 못했습니다.' }

  const parent = getParent()
  const win = new BrowserWindow({
    // 작업 영역에 맞춘다 — 작업표시줄은 덮지 않는다(전에는 모니터 전체를 덮었다).
    ...origin.workArea,
    // 부모를 붙이지 않는다: 부모 창을 최소화하면 자식도 함께 내려가는데, 이 창은 모니터를
    // 통째로 쓰는 독립 화면이라 앱 창과 수명을 묶으면 오히려 불편하다.
    frame: true,
    title: name,
    backgroundColor: BACKGROUND,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  const frame = frameInsets(win)
  // 제목 표시줄 두께가 0 으로 나오면 **재지 못한 것**이다(창이 아직 안 떠서 그럴 수 있다).
  // 그 값으로 내용 영역을 다시 맞추면 제목 표시줄이 화면 위로 밀려 나가 창을 잡을 수 없게 된다 —
  // 그럴 때는 자리를 안 건드린다(원격 화면이 테두리만큼 잘리는 편이 낫다).
  const measured = frame.top > 0
  const plan = planSpan(displays, ids, { frame, header: SPAN_HEADER_H })
  if (!plan) {
    // spanOrigin 이 통과했으면 여기 올 수 없다 — 그래도 창을 남기고 나가지는 않는다.
    win.destroy()
    return { ok: false, message: '펼칠 모니터를 찾지 못했습니다.' }
  }
  const host = plan.monitors.find((m) => m.primary) ?? plan.monitors[0]

  windows.set(profileId, win)
  plans.set(profileId, plan)
  // 렌더러가 연 "다른 모니터" 창들. 이 창이 닫히면 함께 걷어야 한다 — 안 그러면 세션 없는 정지
  // 화면이 모니터를 덮은 채 남는다. 전에는 렌더러의 언마운트 정리에 기대고 있었는데, 창이 OS 쪽에서
  // 닫히면(제목 표시줄 X·Alt+F4) 그 정리가 안 돌아 자식이 고아가 된다.
  const kids: BrowserWindow[] = []

  win.on('closed', () => {
    if (windows.get(profileId) === win) windows.delete(profileId)
    plans.delete(profileId)
    for (const kid of kids) if (!kid.isDestroyed()) kid.destroy()
    kids.length = 0
    // 앱 창에 "그 서버의 펼친 창이 닫혔다"를 알린다. 지금 이 push 를 듣는 곳은 없다(탭에 표시를
    // 두던 시절의 잔재다) — 채널은 preload 에 살아 있으니 필요해지면 그때 구독하면 된다.
    pushSend(parent && !parent.isDestroyed() ? parent.webContents : null, 'rdp:spanClosed', { profileId })
  })
  win.once('ready-to-show', () => {
    // **내용 영역**을 계획값에 맞춘다(바깥이 아니라). 원격 해상도가 이 값이라 여기가 어긋나면
    // 화면이 잘리거나 검은 띠가 남는다 — 잰 테두리가 조금 틀려도 여기서 바로잡힌다.
    if (measured && host) win.setContentBounds(host.content)
    win.show()
  })

  // 렌더러가 나머지 모니터를 window.open 으로 연다. 기본대로 두면 아무 데나 기본 크기로 떠
  // 모니터를 못 덮는다 — 여기서 자리를 잡아 준다. 이름이 우리 것이 아니면 막는다(원격 화면 창에서
  // 임의 창이 열리는 길을 남기지 않는다).
  //
  // **좌표는 features 문자열에서 읽지 않는다**(2026-08-17). 그렇게 짜여 있었는데 정규식이
  // 템플릿 리터럴 안에서 `\d` → `d` 로 죽어 **한 번도 매치된 적이 없었다** — 넷 다 undefined 라
  // 자식 창이 기본 크기(800×600)로 주 모니터에 떠, 이 창 뒤에 가려졌다. 준영님 눈에는
  // "다른 모니터에 새 창이 안 생긴다"로 보였다(제보 ⑨). 이제 frameName 의 모니터 id 로 계획에서 꺼낸다.
  win.webContents.setWindowOpenHandler(({ frameName }) => {
    const mon = monitorByFrame(plan, frameName)
    if (!mon) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: true,
        title: name,
        backgroundColor: BACKGROUND,
        ...mon.window,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
      }
    }
  })
  win.webContents.on('did-create-window', (child, { frameName }) => {
    const mon = monitorByFrame(plan, frameName)
    if (!mon) return
    // 호스트 창과 같은 이유로 내용 영역을 계획값에 맞춘다. 이 창의 테두리는 재 본 적이 없고
    // (모니터마다 배율이 다르면 두께도 다를 수 있다) 여기서 맞추면 그 차이가 화면에 안 남는다.
    if (measured) child.setContentBounds(mon.content)
    kids.push(child)
    // 자식 창을 닫으면 그 모니터만 검게 남는다 — 세션은 하나이므로 통째로 닫는다(mstsc 와 같다).
    // 실수로 닫아도 잃는 것은 연결뿐이다: RDP 세션은 서버에 남아 다시 붙으면 그대로 돌아온다.
    child.on('closed', () => {
      if (windows.get(profileId) === win) closeRdpSpanWindow(profileId)
    })
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
