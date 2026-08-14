import { useCallback, useRef, useState } from 'react'
import { t } from '../i18n'
import { TerminalPane } from '../terminal/TerminalPane'
import { RdpView } from './RdpView'
import { IconClose } from './icons'
import type { PaneCell, useLayout } from '../store/layout'
import type { Session } from '../store/sessions'
import { paneDropZone, zoneRect, type DropZone, type Rect } from '../store/dropZone'
import { spanRdp } from '../store/rdpSpanOpen'

// F4a 분할 그리드 — 목업 variant-final-3 의 .pane-grid / .pane / .pane-hd / .div-* 를 그대로 재현하되
// 패널 개수(1~4)에 따라 grid-template 과 셀 배치를 동적으로 만든다.
//
// 렌더 단위는 "패널"이 아니라 "세션"이다(R1.1): 세션마다 요소 하나를 sessionId 로 keyed 렌더해 두고,
// 그중 패널에 배치된 세션만 그리드 셀을 차지한다. 배치되지 않은 세션은 display:none 으로 마운트만 유지한다.
// 이렇게 해야 패널의 세션이 바뀌어도 xterm 이 dispose 되지 않아 스크롤백이 남는다
// (패널 단위로 렌더하면 세션 교체 = 언마운트 → 버퍼 소멸 → 검은 화면).

// F6 부분 복원(C-4): SSH 재접속 실패 패널 정보. placeholder sessionId 로 keyed.
export type RestoreError = {
  sessionId: string
  profileId: string | null
  title: string
  serverKey: string
  reason: string
}

type Props = {
  layout: ReturnType<typeof useLayout>
  sessions: Session[]
  restoreErrors?: Map<string, RestoreError>
  onRetryRestore?: (errSessionId: string) => void
  onDismissError?: (errSessionId: string) => void
  /** 칸 헤더 × = 세션 종료(탭 ×와 같은 경로). RDP 가 원격에서 끊겼을 때도 여기로 탭을 정리한다. */
  onCloseSession?: (sessionId: string) => void
  /**
   * 탭·칸 헤더를 끌어다 가장자리에 놓았을 때. 방향(zone)까지 그대로 넘긴다 —
   * 왼쪽에 놓으면 왼쪽에 생겨야 하고, 이미 배치된 세션이면 원래 칸을 다른 세션으로 채워야 한다.
   * 그 판단(배경 세션 고르기·없으면 새 셸)은 세션 목록을 아는 MainArea 가 한다.
   */
  onSplitDrop?: (sessionId: string, zone: Exclude<DropZone, 'center'>) => void
  // R3.6: 셸이 보낸 OSC 0/2 제목을 상위(MainArea)로 올린다.
  onTitle?: (sessionId: string, title: string) => void
  // F8: 터미널 안 URL Ctrl+클릭. 라우팅 판단은 MainArea 가 한다(그쪽에 다이얼로그가 있다).
  onLink?: (sessionId: string, url: string, isSsh: boolean) => void
}

// 그리드 트랙: 사용 열/행 수 + divider(5px) 삽입. 단일 열/행이면 divider 없음.
function template(usedRatio: number, count: 1 | 2): string {
  if (count === 1) return '1fr'
  return `${usedRatio}fr 5px ${1 - usedRatio}fr`
}

// 셀(col,row) → grid-column/grid-row 라인 번호. divider 가 2번 라인을 차지하므로 1·3 사용.
const line = (i: 0 | 1) => (i === 0 ? 1 : 3)

// FB-0002: 뷰포트 기준 사각형을 .pane-grid 기준 상대 좌표로(오버레이를 그 안에 절대배치하려고).
const toLocal = (gridRect: Rect, r: Rect): Rect => ({
  left: r.left - gridRect.left,
  top: r.top - gridRect.top,
  width: r.width,
  height: r.height
})

// 탭 드래그 → 패널 드롭 미리보기 상태. targetSessionId = 중앙(교체) 판정일 때 그 패널이 지금 보여주는 세션.
type DropPreview = { zone: DropZone; blocked: boolean; targetSessionId: string | null; rect: Rect }

export function PaneGrid({
  layout,
  sessions,
  restoreErrors,
  onRetryRestore,
  onDismissError,
  onCloseSession,
  onSplitDrop,
  onTitle,
  onLink
}: Props) {
  const {
    cells,
    usage,
    focusedId,
    maximizedId,
    colRatio,
    rowRatio,
    focus,
    setColRatio,
    setRowRatio,
    canSplit,
    replaceSession,
    showSession
  } = layout
  const gridRef = useRef<HTMLDivElement>(null)
  // FB-0002: 탭 드래그 → 패널 드롭 미리보기(점선 오버레이). null = 드래그 중이 아니거나 그리드 밖.
  const [preview, setPreview] = useState<DropPreview | null>(null)

  // 탭(HTML5 DnD, text/plain=sessionId) 이 터미널 영역 위를 지날 때 방향/불가를 판정해 오버레이를 세운다.
  // 탭바 위 드롭은 재정렬(TermTabbar 담당) — 여긴 터미널 영역만 본다, 서로 다른 DOM 이라 겹치지 않는다.
  const onGridDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('text/plain')) return // OS 파일 드롭 등 탭 드래그가 아니면 무시
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const grid = gridRef.current
      if (!grid) return
      const gridRect = grid.getBoundingClientRect()
      const paneEl = (e.target as HTMLElement).closest('.pane') as HTMLElement | null
      if (!paneEl) {
        // 빈 그리드/패널 밖 — 전체 영역이 곧 "중앙"(그대로 열기).
        setPreview({ zone: 'center', blocked: false, targetSessionId: null, rect: toLocal(gridRect, gridRect) })
        return
      }
      const paneRect = paneEl.getBoundingClientRect()
      const zone = paneDropZone(paneRect, e.clientX, e.clientY)
      setPreview({
        zone,
        blocked: zone !== 'center' && !canSplit,
        targetSessionId: paneEl.dataset.sessionId ?? null,
        rect: toLocal(gridRect, zoneRect(paneRect, zone))
      })
    },
    [canSplit]
  )

  const onGridDragLeave = useCallback((e: React.DragEvent) => {
    const grid = gridRef.current
    if (grid && e.relatedTarget instanceof Node && grid.contains(e.relatedTarget)) return // 자식 사이 이동은 무시
    setPreview(null)
  }, [])

  const onGridDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const info = preview
      setPreview(null)
      const sessionId = e.dataTransfer.getData('text/plain')
      if (!sessionId || !info) return
      const { zone, blocked, targetSessionId } = info
      if (zone === 'center') {
        // 중앙 = 그 패널로 이동/교체. 같은 세션 위에 놓으면 그냥 포커스만(showSession 이 처리).
        if (targetSessionId && targetSessionId !== sessionId) replaceSession(targetSessionId, sessionId)
        else showSession(sessionId)
        return
      }
      if (blocked) return // 4분할 초과 — 미리보기대로 아무 것도 하지 않는다.
      onSplitDrop?.(sessionId, zone)
    },
    [preview, replaceSession, showSession, onSplitDrop]
  )

  // divider 드래그 — 그리드 전체 폭/높이에 대한 포인터 위치로 비율 재계산(6px 패딩 감안은 근사).
  const dragCol = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const grid = gridRef.current
      if (!grid) return
      const move = (ev: PointerEvent) => {
        const r = grid.getBoundingClientRect()
        setColRatio((ev.clientX - r.left) / r.width)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setColRatio]
  )
  const dragRow = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const grid = gridRef.current
      if (!grid) return
      const move = (ev: PointerEvent) => {
        const r = grid.getBoundingClientRect()
        setRowRatio((ev.clientY - r.top) / r.height)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setRowRatio]
  )

  const empty = cells.length === 0
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: template(colRatio, usage.cols),
    gridTemplateRows: template(rowRatio, usage.rows)
  }

  // 렌더 슬롯 = 모든 세션(패널 배치 여부 무관) + 복원 실패 placeholder(실 세션 아님, xterm 없음).
  type Slot = { key: string; cell?: PaneCell; session?: Session; err?: RestoreError }
  //
  // 오류에는 두 종류가 있고 슬롯 만드는 법이 다르다:
  //  · **부팅 복원 실패**(F6) — placeholder 라 `sessions` 에 없다. 자기 슬롯을 따로 만든다.
  //  · **쓰던 중 끊김**(2026-08-14) — 세션이 `sessions` 에 **그대로 있다.** 따로 만들면 key 가
  //    겹쳐 같은 패널이 두 번 그려진다. 그래서 그 세션 슬롯에 err 를 얹기만 한다.
  const slots: Slot[] = [
    ...sessions.map((s) => ({
      key: s.id,
      session: s,
      cell: cells.find((c) => c.sessionId === s.id),
      err: restoreErrors?.get(s.id)
    })),
    ...cells
      .filter((c) => restoreErrors?.has(c.sessionId) && !sessions.some((s) => s.id === c.sessionId))
      .map((c) => ({ key: c.sessionId, cell: c, err: restoreErrors!.get(c.sessionId)! }))
  ]

  return (
    <div
      className={'pane-grid' + (empty ? '' : ' split')}
      ref={gridRef}
      style={empty ? undefined : gridStyle}
      onDragOver={onGridDragOver}
      onDragLeave={onGridDragLeave}
      onDrop={onGridDrop}
    >
      {/* #66-8(2026-08-14): 세션이 없으면 화면의 70% 가 한 글자도 없이 비어 있었다. 사이드바의
          260px 짜리 안내는 정확하지만 눈은 큰 빈 칸으로 간다.
          **버튼은 두지 않는다** — 여기 있던 [로컬 셸]/[SSH 연결] 버튼은 UI-tabbar(2026-08-04)에서
          "탭바 ＋ 와 완전히 같은 경로라 중복"이라는 이유로 일부러 없앴다(scenarios.md LOCAL-2).
          그 판단은 그대로 두고, 빠져 있던 것(어디를 눌러야 하는지 알려 주는 문장)만 채운다. */}
      {empty && (
        <div className="pane-empty">
          <h2>{t('pane.empty.title')}</h2>
          <p>{t('pane.empty.desc')}</p>
          <div className="pe-keys">
            <span>
              <kbd>Ctrl+Shift+T</kbd> {t('pane.empty.key.new')}
            </span>
            <span>
              <kbd>Ctrl+Shift+M</kbd> {t('pane.empty.key.conn')}
            </span>
            <span>
              <kbd>F1</kbd> {t('pane.empty.key.palette')}
            </span>
          </div>
        </div>
      )}
      {slots.map(({ key, cell, session, err }) => {
        // 패널에 없거나(배경 탭) 최대화로 가려진 세션 → 숨김. 마운트는 유지한다.
        const hidden = !cell || (maximizedId != null && maximizedId !== cell.id)
        const style: React.CSSProperties = !cell
          ? { display: 'none' }
          : {
              // 최대화 시 포커스 패널만 전체를 차지.
              gridColumn: maximizedId === cell.id ? '1 / -1' : usage.cols === 1 ? '1 / -1' : line(cell.col),
              gridRow: maximizedId === cell.id ? '1 / -1' : usage.rows === 1 ? '1 / -1' : line(cell.row),
              display: hidden ? 'none' : 'flex'
            }
        return (
          <div
            key={key}
            // 배치되지 않은 세션은 .pane 이 아니다 — 패널 수를 세는 쪽(테스트·CSS)에서 제외한다.
            className={
              cell ? 'pane' + (cell.id === focusedId ? ' focused' : '') + (err ? ' restore-error' : '') : 'pane-stash'
            }
            style={style}
            data-session-id={key}
            onMouseDown={() => cell && focus(cell.id)}
          >
            {/* 헤더 = 상태 dot + 제목 + 닫기. R3.9 에서 ×(그땐 detach: 창만 사라지고 탭은 남음)가
                혼란을 불러 없앴었는데, R9a 로 "칸 닫기 = 세션 종료"가 되면서 탭 ×와 뜻이 같아졌다 —
                손이 가는 자리에 있는 편이 낫다. Ctrl+Shift+W·메뉴 pane.close 도 전부 같은 경로다. */}
            <div
              className="pane-hd"
              draggable={!!session}
              onDragStart={(e) => {
                if (!session) return
                e.dataTransfer.setData('text/plain', session.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
            >
              <span className="pdot" style={{ background: err ? 'var(--err)' : 'var(--ok)' }} />
              <span className="ptitle">
                <b>{err ? err.title : (session?.title ?? key)}</b>
              </span>
              {cell && (
                <span
                  className="px"
                  title={t('tab.close')}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    // 복원 실패 자리는 세션이 아니다 — 카드의 [닫기]와 같은 경로로 치운다.
                    if (err) onDismissError?.(err.sessionId)
                    else onCloseSession?.(key)
                  }}
                >
                  <IconClose />
                </span>
              )}
            </div>
            <div className="pane-body">
              {err && !session ? (
                // F6 부분 복원(C-4): SSH 재접속 실패 — 오류 + 재시도/닫기. 다른 패널은 정상.
                // 여기는 **placeholder 전용**이다(세션이 없어 터미널을 그릴 수 없다).
                <div className="restore-err-card">
                  <div className="rec-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M12 9v4M12 17h.01" />
                      <path d="M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3.1l-8-14a2 2 0 00-3.4 0z" />
                    </svg>
                  </div>
                  {/* 같은 카드를 두 상황이 쓴다 — 부팅 복원 실패와, 쓰던 중에 끊긴 것.
                      제목이 갈리지 않으면 "복원 실패"가 멀쩡히 쓰던 세션에 뜬다. */}
                  <div className="rec-title">{t(err.reason === 'dropped' ? 'restore.dropped' : 'restore.failed')}</div>
                  <div className="rec-sub">
                    {err.serverKey} · {t('restore.reason.' + err.reason)}
                  </div>
                  <div className="rec-actions">
                    <button type="button" className="rec-btn primary" onClick={() => onRetryRestore?.(err.sessionId)}>
                      {t('restore.retry')}
                    </button>
                    <button type="button" className="rec-btn" onClick={() => onDismissError?.(err.sessionId)}>
                      {t('restore.dismiss')}
                    </button>
                  </div>
                </div>
              ) : session?.type === 'rdp' ? (
                // F25: 원격 화면은 pty 가 아니라 캔버스다 — 같은 칸에 RdpView 를 그린다.
                <RdpView
                  profileId={session.profileId ?? ''}
                  name={session.title}
                  onClose={() => onCloseSession?.(session.id)}
                  onSpan={() => void spanRdp(session.profileId ?? '', session.title)}
                />
              ) : (
                <TerminalPane
                  sessionId={key}
                  active={!hidden && cell?.id === focusedId}
                  local={session?.type !== 'ssh'}
                  serverKey={session?.serverKey ?? 'local'}
                  onTitle={onTitle}
                  onLink={onLink}
                />
              )}
              {/* 쓰던 중에 끊긴 세션 — 카드를 터미널 **위에** 얹는다. 대신 그리면 끊기기 직전
                  화면이 사라지는데, 그 화면이 대개 "왜 끊겼나"의 유일한 단서다. */}
              {err && session && (
                <div className="restore-err-card over">
                  <div className="rec-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M12 9v4M12 17h.01" />
                      <path d="M10.3 3.9l-8 14A2 2 0 004 21h16a2 2 0 001.7-3.1l-8-14a2 2 0 00-3.4 0z" />
                    </svg>
                  </div>
                  <div className="rec-title">{t('restore.dropped')}</div>
                  <div className="rec-sub">
                    {err.serverKey} · {t('restore.reason.' + err.reason)}
                  </div>
                  <div className="rec-actions">
                    {/* 프로필이 없으면 되살릴 방법이 없다 — 버튼을 내주지 않는다(눌러도 안 되는
                        버튼보다 없는 편이 낫다). 사유는 위 문구가 이미 말한다. */}
                    {err.profileId && (
                      <button type="button" className="rec-btn primary" onClick={() => onRetryRestore?.(err.sessionId)}>
                        {t('restore.reconnect')}
                      </button>
                    )}
                    <button type="button" className="rec-btn" onClick={() => onDismissError?.(err.sessionId)}>
                      {t('restore.dismiss')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* 세로 divider(좌우 열 사이) — 열이 2개일 때만. 최대화 중엔 숨김. */}
      {usage.cols === 2 && !maximizedId && (
        <div className="div-col" onPointerDown={dragCol} style={{ gridColumn: 2, gridRow: '1 / -1' }} />
      )}
      {/* 가로 divider(상하 행 사이). 열이 하나면(2패널 상·하 배치) 전 폭 하나 —
          2열용 좌·우 divider 를 그대로 쓰면 존재하지 않는 3번 열이 암시적으로 생겨 그리드가 틀어진다. */}
      {usage.rows === 2 && !maximizedId && (
        usage.cols === 1 ? (
          <div className="div-row" onPointerDown={dragRow} style={{ gridColumn: '1 / -1', gridRow: 2 }} />
        ) : (
          <>
            <div className="div-row" onPointerDown={dragRow} style={{ gridColumn: 1, gridRow: 2 }} />
            <div className="div-row-r" onPointerDown={dragRow} style={{ gridColumn: 3, gridRow: 2 }} />
          </>
        )
      )}

      {/* FB-0002: 탭 드래그 → 분할 미리보기. blocked = 4분할 상한 초과("불가" 안내, pane.limit 재사용). */}
      {preview && (
        <div
          className={'drop-preview' + (preview.blocked ? ' blocked' : '')}
          style={{ left: preview.rect.left, top: preview.rect.top, width: preview.rect.width, height: preview.rect.height }}
        >
          {preview.blocked && <span className="drop-preview-msg">{t('pane.limit')}</span>}
        </div>
      )}
    </div>
  )
}
