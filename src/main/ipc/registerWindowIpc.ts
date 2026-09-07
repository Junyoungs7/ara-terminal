// window 도메인 IPC 핸들러 (R2.6). 프레임리스 타이틀바의 신호등 버튼이 여기로 온다.
// 창은 재생성될 수 있으므로 getter 로 지연 평가하고, 파괴된 창은 조용히 무시한다
// (FIX-window-destroyed 패턴 — isDestroyed 접근 자체도 try 로 감싼다).
import { app, BrowserWindow, clipboard, shell, type IpcMainInvokeEvent } from 'electron'
import { openPortWindow } from '../windows/PortWindow'
import { handle } from './handle'
import { isSafeExternal } from '../util/safeExternal'
import { clipboardFilePaths } from '../util/clipboardFiles'

export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  const live = (): BrowserWindow | null => {
    try {
      const w = getWindow()
      return w && !w.isDestroyed() ? w : null
    } catch {
      return null
    }
  }

  // 포트 모니터 독립 창(2026-08-21). 창은 하나 — 두 번째 호출은 있는 창을 앞으로 가져온다.
  handle('portwin:open', () => {
    openPortWindow(getWindow)
    return { ok: true } as const
  })
  /**
   * 보낸 창을 대상으로 한다(window:close 와 같은 이유 — 2026-08-23 에 세션 창이 프레임리스가
   * 되면서 **그 창에도 신호등이 생겼다**. 본창만 조작하면 떼어낸 창의 최소화 버튼이 본창을 내린다).
   */
  const sender = (e: IpcMainInvokeEvent): BrowserWindow | null => {
    try {
      const w = BrowserWindow.fromWebContents(e.sender)
      return w && !w.isDestroyed() ? w : live()
    } catch {
      return live()
    }
  }

  handle('window:minimize', (_req, e) => {
    sender(e)?.minimize()
    return { ok: true } as const
  })

  // 최대화 토글 — 현재 상태에 따라 복원/최대화. 창 크기 저장(F6)은 최대화 중엔 건너뛰므로
  // 최대화 상태로 종료해도 복원용 bounds 는 마지막 일반 크기가 남는다.
  handle('window:toggleMaximize', (_req, e) => {
    const w = sender(e)
    if (!w) return { maximized: false }
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return { maximized: w.isMaximized() }
  })

  /**
   * **부른 창을 닫는다.** 예전엔 무조건 본창을 닫았다 — 창이 본창 하나였을 때는 같은 말이었지만
   * F32 로 떼어낸 창이 생기면서 갈라졌다: 그 창의 마지막 세션이 본창으로 돌아가면 빈 창이
   * 스스로 닫으려고 이 채널을 부르는데(SessionWindow.tsx), 그게 **본창을 닫아 앱을 끝냈다.**
   * 보낸 쪽을 못 찾을 때만 본창으로 떨어뜨린다(계약을 바꾸지 않는 폴백).
   */
  handle('window:close', (_req, e) => {
    sender(e)?.close()
    return { ok: true } as const
  })

  // R3.3: 터미널 안 URL 을 기본 브라우저로. 스킴 화이트리스트는 util/safeExternal(순수 함수).
  handle('app:openExternal', ({ url }) => {
    if (!isSafeExternal(url)) return { ok: false }
    void shell.openExternal(url).catch(() => {})
    return { ok: true }
  })

  /**
   * #190 GPU 상태. app:openExternal·clipboard:readFiles 와 같은 **"렌더러가 못 아는 것을 main 이
   * 대신 답한다"** 자리다.
   *
   * 렌더러는 `WEBGL_debug_renderer_info` 로 GPU 이름을 물을 수밖에 없는데 그 확장은 정책으로
   * 막히고, 막히면 우리 판정이 "모른다"를 "멀쩡하다"로 읽는다(webglChoice.ts 의 🔴 주석).
   * 이쪽은 Chromium 이 실제로 무엇을 켰는지 그대로 답한다 — 사내 제보(타이핑 딜레이·스크롤
   * 깜빡임)를 가를 자료가 이것이다. 키·값을 우리가 손보지 않는다: 모르는 항목이 생기면
   * 그것까지 보여야 진단이 된다.
   */
  handle('app:gpuInfo', async () => {
    // ⚠️ **순서가 답을 바꾼다.** GPU 프로세스가 보고하기 전에 `getGPUFeatureStatus()` 를 읽으면
    // 전부 `disabled_*` 인 **자리값**이 온다 — 2026-09-07 이 PC 실측: 같은 실행 안에서 webgl 이
    // `disabled_off` → (아래 getGPUInfo 호출) → `enabled` 로 바뀐다. 그 자리값을 제보로 받으면
    // "이 PC 는 WebGL 이 꺼져 있다"는 거짓 결론으로 조사가 통째로 헛돈다. 그래서 먼저 끌어온다.
    //
    // 그리고 이 호출이 **렌더러가 못 보는 것을 답한다**: `WEBGL_debug_renderer_info` 가 정책으로
    // 막힌 PC 에서는 렌더러 쪽 GPU 이름이 빈 문자열인데, 여기 glRenderer 는 그래도 나온다.
    // 실패는 삼킨다 — features 만이라도 보내는 것이 아무것도 안 보내는 것보다 낫다.
    const gl = { renderer: '', vendor: '', version: '' }
    try {
      // 형이 unknown 이다(Electron 타이핑) — 문자열인 것만 골라 넣는다.
      const info = (await app.getGPUInfo('complete')) as { auxAttributes?: Record<string, unknown> }
      const aux = info?.auxAttributes
      const pick = (k: string): string => (typeof aux?.[k] === 'string' ? String(aux[k]) : '')
      gl.renderer = pick('glRenderer')
      gl.vendor = pick('glVendor')
      gl.version = pick('glVersion')
    } catch {
      // 그대로 빈 문자열 — 화면은 "알 수 없음"으로 보여 준다.
    }
    return { features: { ...app.getGPUFeatureStatus() }, gl }
  })

  // F14: 클립보드에 담긴 파일 경로. 렌더러는 OS 클립보드의 파일 형식을 볼 수 없으므로(브라우저
  // Clipboard API 는 텍스트·이미지뿐) main 이 읽어 실존 파일만 돌려준다 — app:openExternal 과
  // 같은 "렌더러가 못 하는 OS 접근을 검증해서 대신해 준다" 자리다.
  handle('clipboard:readFiles', () => ({ paths: clipboardFilePaths(clipboard) }))

  /**
   * 텍스트 복사. **렌더러의 `navigator.clipboard.writeText` 를 대신한다.**
   *
   * 그 API 는 **문서에 포커스가 없으면 Chromium 이 거부한다.** 브라우저에서는 합리적인 방어지만
   * (아무 탭이나 남의 클립보드를 덮어쓰면 안 된다) 우리는 사용자가 자기 앱에서 자기 손으로 누른
   * 복사다 — 그 방어가 지킬 것이 없고, 대신 **떼어낸 세션 창·RDP·브라우저 뷰처럼 포커스가 다른
   * 곳에 있는 자리에서 조용히 거부된다.** 2026-08-31 준영님 제보가 그 자리다.
   *
   * main 의 `clipboard` 는 OS 클립보드에 직접 쓰므로 포커스 개념이 없다. 실패할 길이 사라진다.
   */
  handle('clipboard:writeText', (text: string) => {
    if (typeof text !== 'string') return { ok: false }
    clipboard.writeText(text)
    return { ok: true }
  })

  /**
   * 텍스트 읽기. **위 주석은 원래 "읽기는 안 옮긴다"였다 — 2026-09-02 에 뒤집었다.**
   *
   * 그때의 근거는 *"남의 클립보드를 읽는 것은 포커스 확인이 실제로 값을 한다"* 였는데, 실제로 읽기를
   * 막고 있던 것은 포커스가 아니라 **권한 핸들러**였다: `index.ts` 가 `media` 말고 전부 거절하므로
   * `navigator.clipboard.readText()` 는 `clipboard-read` 가 거부돼 항상 실패한다. 그 실패가
   * RDP 로컬→원격 붙여넣기를 통째로 죽이고 있었다(원격이 요구해도 우리가 읽지 못한다).
   *
   * 권한 핸들러에서 `clipboard-read` 를 여는 길도 있었지만 **더 나쁘다.** 그 핸들러는 세션 전체에
   * 걸려서 내장 브라우저가 띄우는 **원격 웹 페이지에도 같이 열린다.** 이 통로는 preload 를 지나는
   * 우리 렌더러만 쓴다 — 쓰기를 옮긴 것과 같은 이유로, 같은 방식이다.
   */
  handle('clipboard:readText', () => clipboard.readText())
}
