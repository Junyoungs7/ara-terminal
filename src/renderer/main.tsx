import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './components/Shell'
import { EditorWindow, parseEditorHash } from './components/EditorWindow'
import { RdpSpanWindow, parseRdpWinHash } from './components/RdpSpanWindow'
import { installTooltips } from './store/tooltip'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/shell.css'
import './styles/interactions.css'

// 보조 창(편집기·다중 모니터 RDP)은 같은 번들을 해시로 갈라 쓴다(별도 진입점·별도 preload 없음 —
// 폰트·토큰·CSS 재사용). Shell 을 그리기 **전에** 갈라야 한다: Shell 의 세션 복원 이펙트가 보조 창에서
// 또 돌면 세션이 두 벌 생긴다.
const editorTarget = parseEditorHash(window.location.hash)
const rdpWinTarget = editorTarget ? null : parseRdpWinHash(window.location.hash)

// OS 기본 툴팁 대신 우리 것을 쓴다. 창마다(본체·편집기·다중 모니터) 각자 자기 document 에 건다 —
// 전역 위임이라 `title` 을 쓰는 89곳을 하나도 고치지 않는다(store/tooltip.ts).
installTooltips()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {editorTarget ? <EditorWindow target={editorTarget} /> : rdpWinTarget ? <RdpSpanWindow target={rdpWinTarget} /> : <Shell />}
  </StrictMode>
)
