import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './components/Shell'
import { EditorWindow, parseEditorHash } from './components/EditorWindow'
import { RdpSpanWindow, parseRdpWinHash } from './components/RdpSpanWindow'
import { SessionWindow, parseSessionWinHash } from './components/SessionWindow'
import { PortWindow } from './components/PortWindow'
import { isPortWinHash } from '@shared/portWin'
import { BrowserWindow as BrowserTabStrip } from './components/BrowserWindow'
import { isBrowserWinHash } from '@shared/browserWin'
import { installTooltips } from './store/tooltip'
import { installErrorRing } from './store/errorRing'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/shell.css'
import './styles/interactions.css'

// #206 렌더러 오류 링버퍼 — **가장 먼저** 건다(아래 무엇이 던지든 기록되게). 모든 창이 이 파일을 지난다.
installErrorRing()

// 보조 창(편집기·다중 모니터 RDP)은 같은 번들을 해시로 갈라 쓴다(별도 진입점·별도 preload 없음 —
// 폰트·토큰·CSS 재사용). Shell 을 그리기 **전에** 갈라야 한다: Shell 의 세션 복원 이펙트가 보조 창에서
// 또 돌면 세션이 두 벌 생긴다.
const editorTarget = parseEditorHash(window.location.hash)
const rdpWinTarget = editorTarget ? null : parseRdpWinHash(window.location.hash)
// F32: 떼어낸 세션 창. 위 둘과 같은 이유로 **Shell 보다 먼저** 갈라야 한다 — 여기서 Shell 이
// 그려지면 그 안의 F6 복원이 또 돌아 세션이 두 벌 생긴다(MainArea 의 detachedWinId 가 2차 방어).
const sessionWinTarget = editorTarget || rdpWinTarget ? null : parseSessionWinHash(window.location.hash)
// 포트 모니터 독립 창. 매개변수가 없다 — 어느 서버를 볼지는 창 안 탭이 정한다.
const portWin = !editorTarget && !rdpWinTarget && !sessionWinTarget && isPortWinHash(window.location.hash)
// 내장 브라우저 탭 줄. 이 창의 본문(원격 페이지)은 main 이 WebContentsView 로 붙인다 —
// 여기서 그리는 것은 줄 하나뿐이다.
const browserWin =
  !editorTarget && !rdpWinTarget && !sessionWinTarget && !portWin && isBrowserWinHash(window.location.hash)

// OS 기본 툴팁 대신 우리 것을 쓴다. 창마다(본체·편집기·다중 모니터) 각자 자기 document 에 건다 —
// 전역 위임이라 `title` 을 쓰는 89곳을 하나도 고치지 않는다(store/tooltip.ts).
installTooltips()

// #154 **빗나간 파일 드롭을 막는다.** 받는 자리(아라 패널·파일 트리·RDP 화면) 밖에 파일을 놓으면
// Chromium 은 창을 그 파일로 이동시킨다 — 앱이 통째로 사라지고 열려 있던 세션이 다 끊긴다.
// 파일을 끌어다 놓으라고 권하는 기능을 넣는 이상, 빗나갔을 때의 대가가 "앱이 죽는다"면 안 된다.
//
// 받는 자리는 자기 dragover 에서 preventDefault 를 부르므로 여기서 건드리지 않는다(defaultPrevented).
// 그 밖에서는 못 놓는다고 커서로 말한다 — 막아 놓고 놓을 수 있는 척하지 않는다.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    const ev = e as DragEvent
    if (ev.defaultPrevented) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none'
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {editorTarget ? (
      <EditorWindow target={editorTarget} />
    ) : rdpWinTarget ? (
      <RdpSpanWindow target={rdpWinTarget} />
    ) : sessionWinTarget ? (
      <SessionWindow target={sessionWinTarget} />
    ) : portWin ? (
      <PortWindow />
    ) : browserWin ? (
      <BrowserTabStrip />
    ) : (
      <Shell />
    )}
  </StrictMode>
)
