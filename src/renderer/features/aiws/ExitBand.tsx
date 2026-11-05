// fb2214 에이전트가 끝나 셸만 남은 탭 — 터미널 보기 = 위 띠(목업 mockups/exit-band A), 채팅 보기 = 대화 끝 카드.
// 모양은 계정 전환 띠·카드(AccountSwitch.tsx — aiws-acct-band · ag-ask)를 그대로 쓴다. 끝남 판정은 main 화면 판정 agentExited(재시작 칩과 같은 것).
// [이 대화 이어 하기] = 지난 세션 [재개]와 같은 launchAgent({resume}) 길(restartTab 이 셸을 닫고 그 자리에 띄움) · id 를 모르면 [지난 세션 열기].
import { useEffect, useState, type JSX } from 'react'
import { History, Play, Power, RotateCw, X } from 'lucide-react'
import { AGENTS } from '@shared/agents'
import { t } from '../../i18n'
import { useAgentStore, type AgentTab } from './agentStore'
import './accountSwitch.css'

/** 띠·카드 머리 글 — "Claude 세션이 끝났습니다 · 1h 12m"(시간은 이 창이 띄운 탭만). */
export function exitBandText(tab: AgentTab): string {
  const base = t('aiws.exit.ended').replace('{agent}', AGENTS[tab.agent].label.split(' ')[0])
  // 1분 미만은 안 적는다("· 0m" 은 정보가 아니라 잡음 — fb2214 실측).
  return tab.ranMs && tab.ranMs >= 60_000 ? `${base} · ${koDuration(tab.ranMs)}` : base
}

/** "1시간 12분" · "7분" — 띠 글은 한국어 문장이라 1h 12m 대신. */
export function koDuration(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  return h ? `${h}시간${m % 60 ? ` ${m % 60}분` : ''}` : `${m}분`
}

/** 띠·카드가 같이 쓰는 동작. resume = 이어 갈 세션 id(undefined = 묻는 중 · null = 모름). */
function useExitActions(tab: AgentTab): { resume: string | null | undefined; busy: boolean; err: string | null; run: (resume?: string) => void } {
  const [resume, setResume] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.ev.agents
      .resumeIds([tab.sessionId])
      .then((ids) => alive && setResume(ids[tab.sessionId] ?? null))
      .catch(() => alive && setResume(null))
    return () => {
      alive = false
    }
  }, [tab.sessionId])
  return {
    resume,
    busy,
    err,
    run: (id) => {
      if (busy) return
      setBusy(true)
      setErr(null)
      void useAgentStore
        .getState()
        .restartTab(tab.sessionId, id)
        .then(setErr)
        .finally(() => setBusy(false))
    }
  }
}

const dismiss = (sessionId: string): void => useAgentStore.setState((s) => ({ tabs: s.tabs.map((x) => (x.sessionId === sessionId ? { ...x, exitBandOff: true as const } : x)) }))
const openVault = (): void => useAgentStore.getState().setView('sessions')

function Buttons({ a }: { a: ReturnType<typeof useExitActions> }): JSX.Element {
  return (
    <>
      {a.resume ? (
        <button type="button" className="btn pri" data-aiws="exit-resume" disabled={a.busy} onClick={() => a.run(a.resume ?? undefined)}>
          <Play aria-hidden />
          {t('aiws.exit.resume')}
        </button>
      ) : (
        a.resume === null && (
          <button type="button" className="btn sec" data-aiws="exit-vault" onClick={openVault}>
            <History aria-hidden />
            {t('aiws.exit.vault')}
          </button>
        )
      )}
      <button type="button" className="btn sec" data-aiws="exit-new" disabled={a.busy} onClick={() => a.run()}>
        <RotateCw aria-hidden />
        {t('aiws.exit.new')}
      </button>
      {a.err && <span className="aiws-err">{a.err}</span>}
    </>
  )
}

/** 터미널 보기 — 탭 맨 위 띠. */
export function ExitBand({ tab }: { tab: AgentTab }): JSX.Element | null {
  const a = useExitActions(tab)
  if (tab.exitBandOff) return null
  return (
    <div className="aiws-note aiws-acct-band warn" role="status" data-aiws="exit-band">
      <Power aria-hidden />
      <span>{exitBandText(tab)}</span>
      <span className="aiws-acct-sp" />
      <Buttons a={a} />
      <button type="button" className="aiws-ic" data-aiws="exit-band-close" aria-label={t('aiws.exit.dismiss')} title={t('aiws.exit.dismiss')} onClick={() => dismiss(tab.sessionId)}>
        <X />
      </button>
    </div>
  )
}

/** 채팅 보기 — 대화 끝 카드(계정 전환 카드와 같은 ag-ask 모양). */
export function ExitCard({ tab }: { tab: AgentTab }): JSX.Element | null {
  const a = useExitActions(tab)
  if (tab.exitBandOff) return null
  return (
    <div className="ag-ask" role="group" aria-label={exitBandText(tab)} data-aiws="exit-card">
      <div className="ag-ask-head">
        <Power aria-hidden className="aiws-acct-warn" />
        <span>{exitBandText(tab)}</span>
      </div>
      <div className="aiws-new-foot">
        <Buttons a={a} />
      </div>
    </div>
  )
}
