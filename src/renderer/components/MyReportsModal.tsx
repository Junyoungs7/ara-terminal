import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { failText } from './BugReportModal'
import type { ToastAction } from './MainArea'
import type { MyReportItem, MyReportNews, ReportDetail, ReportFail } from '@shared/bugReport'

// R16 [내 신고] — 내가 보낸 신고에 관리자가 단 댓글·상태를 보고 답글을 단다. 계약 docs/bug-report-api.md.
// 껍데기는 신고 창(BugReportModal)과 같은 `.overlay/.modal/.modal-hd/.dlg-body/.modal-ft`.
// 🔴 서버에서 온 글은 전부 텍스트 노드로만 그린다(innerHTML 금지). 🔴 바깥 클릭으로 닫지 않는다(신고 #6) — [×]·Esc.

/** 켤 때 한 번 + 10분마다. 서버에 묻는 것은 main 이다(보낸 신고가 없으면 main 이 묻지도 않는다). */
const POLL_MS = 10 * 60_000
const NET: ReportFail = { ok: false, reason: 'network' }

export const statusText = (status: string, fixedIn: string | null): string =>
  t('report.status.' + status) + (fixedIn ? ` ${fixedIn}` : '')

/** 토스트 한 줄. 여럿이면 하나로 묶는다(토스트는 한 번에 하나다). */
export function newsText(news: readonly MyReportNews[]): string {
  if (news.length > 1) return t('report.news.many').replace('{n}', String(news.length))
  const n = news[0]
  if (n.kind === 'comment') return t('report.news.comment').replace('{n}', String(n.number))
  return t('report.news.status').replace('{n}', String(n.number)).replace('{s}', statusText(n.status, n.fixedIn))
}

const stamp = (at: number): string => new Date(at).toLocaleString('ko-KR')

/**
 * [내 신고] 훅 — **본창(Shell)만 쓴다**(창마다 폴링하면 떼어낸 창 수만큼 묻고 토스트가 겹친다).
 * unread 는 메뉴바의 빨간 점, open(id?) 은 토스트 [보기]·메뉴·통합 검색이 부른다.
 */
export function useMyReports(toast: (msg: string, action?: ToastAction) => void): {
  unread: number
  open: (id?: string) => void
  node: JSX.Element | null
} {
  const [items, setItems] = useState<MyReportItem[]>([])
  const [offline, setOffline] = useState(false)
  // undefined = 닫힘 · null = 열림(고른 것 없음) · id = 그 신고로 바로
  const [openAt, setOpenAt] = useState<string | null | undefined>(undefined)
  const toastRef = useRef(toast)
  toastRef.current = toast

  const refresh = useCallback(async (announce: boolean) => {
    const r = await window.ev.report.mine().catch(() => ({ ok: false }) as const)
    setOffline(!r.ok)
    if (!r.ok) return // 🔴 조용히 — 사내망 밖이면 늘 이렇다
    setItems(r.items)
    if (!announce || r.news.length === 0) return
    const target = r.news.length === 1 ? r.news[0].id : null
    toastRef.current(newsText(r.news), { label: t('report.news.view'), run: () => setOpenAt(target) })
  }, [])

  useEffect(() => {
    void refresh(true)
    const h = setInterval(() => void refresh(true), POLL_MS)
    return () => clearInterval(h)
  }, [refresh])

  const open = useCallback(
    (id?: string) => {
      setOpenAt(id ?? null)
      void refresh(false)
    },
    [refresh]
  )
  const onSeen = useCallback(() => void refresh(false), [refresh])
  const close = useCallback(() => setOpenAt(undefined), [])

  return {
    unread: items.filter((i) => i.fresh).length,
    open,
    node:
      openAt === undefined ? null : (
        <MyReportsModal items={items} offline={offline} initial={openAt} onSeen={onSeen} onClose={close} />
      )
  }
}

function MyReportsModal({
  items,
  offline,
  initial,
  onSeen,
  onClose
}: {
  items: MyReportItem[]
  offline: boolean
  initial: string | null
  onSeen: () => void
  onClose: () => void
}): JSX.Element {
  const [sel, setSel] = useState<string | null>(initial)
  const [detail, setDetail] = useState<ReportDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const cur = useRef(sel)

  useEffect(() => {
    cur.current = sel
    setDetail(null)
    setErr(null)
    setReply('')
    if (!sel) return
    void window.ev.report
      .detail(sel)
      .catch(() => NET)
      .then((r) => {
        if (cur.current !== sel) return // 그사이 다른 신고를 골랐다
        if (r.ok) {
          setDetail(r.report)
          onSeen() // main 이 읽음으로 적었다 — 목록의 점·메뉴바의 점을 다시 받는다
        } else setErr(failText(r))
      })
  }, [sel, onSeen])

  const canSend = detail !== null && reply.trim() !== '' && !sending
  // 🔴 실패해도 다시 보내지 않는다(신고 창과 같은 규칙) — 문장을 보여 주고 사람이 다시 누른다.
  const send = async () => {
    if (!canSend || !detail) return
    const id = detail.id
    setSending(true)
    const r = await window.ev.report.reply(id, reply.trim()).catch(() => NET)
    setSending(false)
    if (!r.ok) return setErr(failText(r))
    setErr(null)
    setReply('')
    setDetail((d) => (d && d.id === id ? { ...d, comments: [...d.comments, r.comment] } : d))
  }

  const para = (label: string, body: string) =>
    body.trim() !== '' && (
      <div>
        <div className="mr-meta">{label}</div>
        <p className="mr-text">{body}</p>
      </div>
    )

  return (
    // 신고 창과 같다: 바깥을 눌러도 닫지 않는다 — 쓰던 답글이 한 번의 클릭에 사라진다.
    <div className="overlay open">
      <div
        className="modal sm my-reports"
        role="dialog"
        aria-modal="true"
        aria-label={t('mine.title')}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !sending) onClose()
        }}
      >
        <div className="modal-hd">
          <div className="mh-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 5h16v11H9l-5 4V5z" />
            </svg>
          </div>
          <div>
            <h2>{t('mine.title')}</h2>
          </div>
          <button type="button" className="x" aria-label={t('dlg.close')} title={t('dlg.close')} onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="dlg-body mr-body">
          <div className="mr-list" data-field="mine.list">
            {items.length === 0 && <p className="br-note">{offline ? t('mine.offline') : t('mine.empty')}</p>}
            {items.map((i) => (
              <button
                key={i.id}
                type="button"
                className={'mr-item' + (i.id === sel ? ' on' : '')}
                data-report={i.id}
                onClick={() => setSel(i.id)}
              >
                <span className="mr-meta">#{i.number}</span>
                <span className="mr-item-t" title={i.title}>
                  {i.title}
                </span>
                {i.fresh ? <i className="mr-new" role="img" aria-label={t('mine.new')} /> : <span />}
                <span />
                <span className="mr-meta">{statusText(i.status, i.fixedIn)}</span>
              </button>
            ))}
          </div>

          <div className="mr-detail" data-field="mine.detail">
            {!sel && items.length > 0 && <p className="br-note">{t('mine.pick')}</p>}
            {sel && !detail && !err && <p className="br-note">{t('mine.loading')}</p>}
            {detail && (
              <>
                <div>
                  <h3>
                    #{detail.number} {detail.title}
                  </h3>
                  <div className="mr-meta">
                    {statusText(detail.status, detail.fixedIn)} · {stamp(detail.createdAt)}
                  </div>
                </div>
                {para(t('mine.f.what'), detail.what)}
                {para(t('mine.f.happened'), detail.happened)}
                {para(t('mine.f.expected'), detail.expected)}
                <div className="mr-meta">{t('mine.comments')}</div>
                {detail.comments.length === 0 && <p className="br-note">{t('mine.noComments')}</p>}
                {detail.comments.map((c, n) => (
                  <div key={n} className={'mr-cmt' + (c.author === 'admin' ? ' admin' : '')}>
                    <div className="mr-cmt-hd">
                      <b>{t('mine.author.' + c.author)}</b>
                      <span>{stamp(c.at)}</span>
                    </div>
                    <p className="mr-text">{c.body}</p>
                  </div>
                ))}
                <div className="fld">
                  <label>{t('mine.reply')}</label>
                  <textarea rows={3} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="modal-ft">
          {err && <span className="err">{err}</span>}
          <span className="sp" />
          <button type="button" className="btn pri" data-action="mine.reply" disabled={!canSend} onClick={() => void send()}>
            {sending ? t('mine.sending') : t('mine.send')}
          </button>
        </div>
      </div>
    </div>
  )
}
