import { useEffect, useRef, useState } from 'react'
import type { McpState } from '@shared/types'
import { t } from '../i18n'

// F23 상태바 세그먼트 — "AI 조종 중" 가시화 + 킬 스위치(인계/중단)의 유일한 전역 진입점(설계 §3.1).
// 어느 탭을 보고 있든 여기서 닿을 수 있어야 한다는 게 상태바에 놓는 이유다.
// 글로우·점멸 없음(R8 톤다운 방침) — 색 자체가 신호다.

export function McpIndicator({ getSessionTitle }: { getSessionTitle: (id: string) => string }) {
  const [state, setState] = useState<McpState | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.ev?.mcp
      .getState()
      .then(setState)
      .catch(() => {})
    const off = window.ev?.mcp.onStateChanged(setState)
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!state || state.connected === 0) return null

  const handback = (kill: boolean) => {
    void window.ev?.mcp.handback(kill)
    setOpen(false)
  }

  // D2: 인계 상태를 상태바에서 바로 보여준다 — 기존 mcp.mode.readOnly 문구를 재사용(새 i18n 키 없음).
  const resume = () => {
    void window.ev?.mcp.resumeControl()
  }

  return (
    <div className="mcp-ind" ref={rootRef}>
      <button type="button" className="sb-seg mcp on" data-action="mcp.indicator.toggle" onClick={() => setOpen((o) => !o)}>
        <span className="lbl">{t('mcp.ind.label')}</span>
        <span className="val">· {state.sessions.length}{t('mcp.ind.sessions')}</span>
        {state.handedBack && <span className="val">· {t('mcp.mode.readOnly')}</span>}
      </button>
      {open && (
        <div className="mcp-pop" data-open="true">
          <div className="mcp-pop-hd">{t('mcp.ind.title')}</div>
          {state.sessions.length === 0 ? (
            <div className="mcp-pop-empty">{t('mcp.ind.none')}</div>
          ) : (
            <div className="mcp-pop-list">
              {state.sessions.map((s) => (
                <div className="mcp-pop-row" key={s.sessionId}>
                  <span className="title">{getSessionTitle(s.sessionId)}</span>
                  <span className={'mode ' + s.mode}>{t('mcp.mode.' + s.mode)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mcp-pop-actions">
            {state.handedBack ? (
              <button type="button" className="btn sec" data-action="mcp.resume" onClick={resume}>
                {t('log.resume')}
              </button>
            ) : (
              <button type="button" className="btn sec" data-action="mcp.handback" onClick={() => handback(false)}>
                {t('mcp.ind.handback')}
              </button>
            )}
            <button type="button" className="btn dgr" data-action="mcp.kill" onClick={() => handback(true)}>
              {t('mcp.ind.kill')}
            </button>
          </div>
          <div className="mcp-pop-note">{t('mcp.ind.note')}</div>
        </div>
      )}
    </div>
  )
}
