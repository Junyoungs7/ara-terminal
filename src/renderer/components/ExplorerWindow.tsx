import { useEffect, useState } from 'react'
import type { ExplorerAct, ExplorerReveal, ExplorerState } from '@shared/explorerWin'
import { WorkbenchView } from './WorkbenchView'
import { useDialog } from './Dialog'

// 탐색기 독립 창 (2026-10-28 준영님 제보 — "탐색기가 별도의 창으로 떠야하는데 아라 툴 내부에서만 떠").
//
// 왜 진짜 창인가: PortWindow.tsx 머리 주석과 같다 — 앱 안 떠 있는 창은 본창을 못 벗어나고 본창을
// 최소화하면 같이 숨는다. 탐색기는 다른 모니터에 띄워 두고 터미널과 나란히 쓰는 화면이다.
//
// 이 창은 세션을 **소유하지 않는다**(PortWindow 와 같음). 세션·프로필·즐겨찾기는 본창(Shell)이
// 주인이고 여기는 main 이 중계한 사본이다(explorer:state). 거꾸로 [연결]·[AI 에 묻기]·[작업 프로필로
// 저장] 처럼 본창에서 일어나야 하는 일은 act 로 올려 보낸다 — 서버 [연결] 을 누르면 본창에 세션이
// 열리고, 그 세션이 사본으로 돌아오면 WorkbenchView 의 pending 이 그 서버로 넘어간다.
const EMPTY: ExplorerState = { sessions: [], profiles: [], workProfiles: [] }

export function ExplorerWindow() {
  const [state, setState] = useState<ExplorerState>(EMPTY)
  const [reveal, setReveal] = useState<ExplorerReveal | null>(null)
  // 확인·이름 입력(삭제 확인 등)은 이 창에서 묻는다 — 본창의 다이얼로그를 빌려올 수 없다.
  const { ask, askText, node: dialogNode } = useDialog()
  // × 는 창을 숨긴다(main ExplorerWindow.ts) — 숨은 동안은 원격 폴링을 멈춘다(1.x 의 visible 규칙).
  // OS 창이 숨거나 최소화되면 Chromium 이 visibilityState 를 hidden 으로 바꾼다.
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setDocVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  // visibilityState 만으로는 × 숨김을 모를 때가 있었다(2026-10-29 e2e: OS 창은 숨었는데 문서는 visible) —
  // main 이 숨기고 보일 때 이 창에도 알린다(registerWindowIpc explorer:open). 둘 중 하나라도 숨김이면 숨김이다.
  const [shown, setShown] = useState(true)
  useEffect(() => window.ev?.explorer.onShown((e) => setShown(e.open)), [])
  const visible = docVisible && shown

  useEffect(() => {
    const offState = window.ev?.explorer.onState(setState)
    const offReveal = window.ev?.explorer.onReveal(setReveal)
    // 구독을 건 **다음에** 묻는다 — 그 사이에 온 push 를 hello 가 덮어도 같은 사본이다.
    void window.ev?.explorer
      .hello()
      .then((r) => {
        if (r.state) setState(r.state)
        if (r.reveal) setReveal(r.reveal)
      })
      .catch(() => {})
    return () => {
      offState?.()
      offReveal?.()
    }
  }, [])

  const act = (a: ExplorerAct): void => void window.ev?.explorer.act(a).catch(() => {})

  return (
    <div className="app explorerwin" data-visible={visible ? 'true' : 'false'}>
      <WorkbenchView
        visible={visible}
        sessions={state.sessions}
        profiles={state.profiles}
        workProfiles={state.workProfiles}
        onConnect={(profileId) => act({ kind: 'connect', profileId })}
        ask={ask}
        askText={askText}
        onAskAi={(text) => act({ kind: 'askAi', text })}
        onSendInput={(text) => act({ kind: 'sendInput', text })}
        onLaunch={(id, profileId, cwd) => act({ kind: 'launch', id, profileId, ...(cwd ? { cwd } : {}) })}
        onAiCli={(profileId, path) => act({ kind: 'aiCli', profileId, path })}
        onSaveWork={(profileId, path) => act({ kind: 'saveWork', profileId, path })}
        reveal={reveal}
        onWorkAction={(id, workId) => act({ kind: 'workAction', id, workId })}
      />
      {dialogNode}
    </div>
  )
}
