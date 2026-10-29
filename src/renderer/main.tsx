// 2.0 앱 잠금 — **맨 먼저** import 한다: 그 파일이 거는 키 가드가 다른 모든 키 리스너보다 앞서야 한다.
import { initLock, subscribeLock, lockView, LOCK_HOST_ID } from './store/lock'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './components/Shell'
import { EditorWindow, parseEditorHash } from './components/EditorWindow'
import { RdpSpanWindow, parseRdpWinHash } from './components/RdpSpanWindow'
import { SessionWindow, parseSessionWinHash } from './components/SessionWindow'
import { PortWindow } from './components/PortWindow'
import { isPortWinHash } from '@shared/portWin'
import { ExplorerWindow } from './components/ExplorerWindow'
import { isExplorerWinHash } from '@shared/explorerWin'
import { PastLogWindow } from './components/PastLogWindow'
import { isPastLogWinHash } from '@shared/pastLogWin'
import { BrowserWindow as BrowserTabStrip } from './components/BrowserWindow'
import { LockScreen } from './components/LockScreen'
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
// 탐색기 독립 창(2026-10-28). 포트 모니터와 같이 매개변수가 없다 — 대상은 창 안 좌측이 고른다.
const explorerWin = isExplorerWinHash(window.location.hash)
// 지난 세션 로그 창(2026-10-29). 매개변수 없음 — 어느 로그인지는 main 이 hello·show 로 건넨다.
const pastLogWin = isPastLogWinHash(window.location.hash)

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

/**
 * 2.0 앱 잠금 — 덮개는 본문(#root) **밖**에 따로 그린다. 잠기면 #root 를 inert·블러로 덮고 덮개만 살린다.
 * 본창은 시계(B), 나머지 창은 가운데 카드(A). 앱을 켤 때의 잠금은 어느 창이든 카드다(LockScreen 이 가른다).
 */
const isMainWin = !editorTarget && !rdpWinTarget && !sessionWinTarget && !portWin && !browserWin && !explorerWin && !pastLogWin
const lockHost = document.createElement('div')
lockHost.id = LOCK_HOST_ID
document.body.appendChild(lockHost)
createRoot(lockHost).render(<LockScreen variant={isMainWin ? 'clock' : 'card'} />)

const renderApp = (): void =>
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
    ) : explorerWin ? (
      <ExplorerWindow />
    ) : pastLogWin ? (
      <PastLogWindow />
    ) : (
      <Shell />
    )}
  </StrictMode>
  )

/**
 * **앱을 켤 때 잠겨 있으면 본창(Shell)을 아직 그리지 않는다** — Shell 이 마운트되면 세션 복원·자동 접속이
 * 돌고, 그건 저장된 비밀번호를 쓴다. 풀린 뒤에 그린다(= 복원·접속이 그때 진행된다).
 * 보조 창은 기다리지 않는다: 풀기 전엔 열 길이 없고, 열려 있다면 이미 한 번 풀린 뒤다.
 */
void initLock().then((v) => {
  if (!isMainWin || v?.state !== 'locked-startup') return renderApp()
  const off = subscribeLock(() => {
    if (lockView()?.state === 'locked-startup') return
    off()
    renderApp()
  })
})
