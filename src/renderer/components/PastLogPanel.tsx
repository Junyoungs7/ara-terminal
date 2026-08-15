// #86(2026-08-16) 지난 세션 — 준영님: "현재 세션의 기록은 하단에서, 이전 세션 기록은 우측에서
// 찾을 수 있게."
//
// 왜 갈랐나: 하나였을 때는 "지금 이 세션"과 "예전 어느 세션"이 같은 화면을 두고 다퉜다.
// 나눠 놓으면 §4.8 배치 원칙에 각자 정확히 맞는다 —
//   현재 기록 → 하단(로그 한 줄은 **가로**가 필요하다)
//   지난 목록 → 우측(세션 **목록**은 세로 카드다)
//
// **새 저장소가 없다.** 로그 파일 이름이 `날짜-시각_서버_id8.log` 라 그 폴더를 읽으면 목록이
// 그대로 나온다(main/log/SessionLog.listPast). 읽기도 기존 창 단위 읽기를 그대로 탄다 —
// 이 패널이 새로 만든 것은 목록 UI 하나뿐이다.
import { useCallback, useEffect, useState } from 'react'
import { IconClose, IconRefresh } from './icons'
import { filterLogLines } from './LogPanel'
import { humanSize, relTime } from './filePath'
import { t } from '../i18n'
import type { PastLog } from '@shared/ipc'

type Props = {
  open: boolean
  onClose: () => void
  /** 진행 중인 기록을 누르면 하단 [세션 기록]으로 보낸다(같은 것을 두 곳에서 다르게 보여 주지 않는다). */
  onOpenCurrent: () => void
}

export function PastLogPanel({ open, onClose, onOpenCurrent }: Props): JSX.Element | null {
  const [list, setList] = useState<PastLog[]>([])
  const [sel, setSel] = useState<PastLog | null>(null)
  const [text, setText] = useState('')
  const [start, setStart] = useState(0)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setBusy(true)
    const rows = await window.ev.sessionLog.list()
    setBusy(false)
    setList(rows)
  }, [])

  // 열 때마다 다시 읽는다 — 보존 기간이 지나 사라졌거나 새 세션이 끝났을 수 있다.
  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  const pick = useCallback(async (row: PastLog) => {
    setSel(row)
    setQuery('')
    setBusy(true)
    const res = await window.ev.sessionLog.readFile(row.file)
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      setText('')
      return
    }
    setError(null)
    setText(res.text)
    setStart(res.start)
  }, [])

  const loadOlder = useCallback(async () => {
    if (!sel || start === 0) return
    setBusy(true)
    const res = await window.ev.sessionLog.readFile(sel.file, start)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    setText((cur) => res.text + cur)
    setStart(res.start)
  }, [sel, start])

  if (!open) return null

  const lines = filterLogLines(text, query)

  return (
    <div className="monitor-panel pastlog">
      <div className="mon-head">
        <span className="mon-name">{t('pastlog.title')}</span>
        <span className="sb-act" title={t('sftp.refresh')} onClick={() => void reload()}>
          <IconRefresh />
        </span>
        <span className="mon-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>

      {sel === null ? (
        <div className="pl-list">
          {/* #68 과 같은 규칙: 실패·비활성을 빈 목록으로 감추지 않는다. 기록이 꺼져 있으면
              "없다"가 아니라 "끄셨다"라고 말해야 사용자가 설정을 켤 생각을 한다. */}
          {!busy && list.length === 0 && <div className="sftp-empty">{t('pastlog.empty')}</div>}
          {list.map((row) => {
            // live 는 main 이 판단해 실어 준다 — 렌더러에는 로그 파일 경로가 없다.
            const live = row.live === true
            return (
              <div
                key={row.file}
                className={'pl-row' + (live ? ' live' : '')}
                data-file={row.file}
                title={row.file}
                onClick={() => (live ? onOpenCurrent() : void pick(row))}
              >
                <div className="pl-top">
                  <span className="pl-srv">{row.serverKey}</span>
                  {live && <span className="pl-live">{t('pastlog.live')}</span>}
                </div>
                <div className="pl-sub">
                  <span>{relTime(row.startedAt)}</span>
                  <span className="pl-size">{humanSize(row.bytes)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <>
          <div className="pl-back">
            <button type="button" className="btn sec" onClick={() => setSel(null)}>
              {t('pastlog.back')}
            </button>
            <span className="pl-cur" title={sel.file}>
              {sel.serverKey}
            </span>
          </div>
          <div className="sb-search">
            <div className="field">
              <input
                type="text"
                value={query}
                placeholder={t('log.search.placeholder')}
                aria-label={t('log.search.placeholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') setQuery('')
                }}
              />
            </div>
          </div>
          <div className="log-body">
            {error && <div className="sftp-err">{error}</div>}
            {!error && start > 0 && (
              <button type="button" className="log-more" disabled={busy} onClick={() => void loadOlder()}>
                {t('log.loadOlder')}
              </button>
            )}
            {query && <div className="log-hits">{t('log.hits').replace('{n}', String(lines.length))}</div>}
            <pre className="log-text">{lines.join('\n')}</pre>
          </div>
        </>
      )}
    </div>
  )
}
