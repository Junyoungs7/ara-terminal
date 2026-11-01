import { useEffect, useRef } from 'react'
import { Bell, CheckCheck, ChevronRight, CircleCheck, CircleQuestionMark, CircleX, Info, SlidersHorizontal, Sparkles, SquareTerminal, X } from 'lucide-react'
import { dismissToast, hasUnread, readAllNotes, setNoteOpener, TOAST_LIFE, toastView, useNotes, type Note, type NoteKind } from '../store/notify'
import { t } from '../i18n'

/**
 * M1 라운드 3 알림 센터 화면 — 타이틀바 벨(+드롭다운)과 오른쪽 아래 토스트(시안 SW-final, Orca
 * `NotificationCardStack` · `activity-thread-row` · `ActivityTitlebarControls` 의 항목 구성).
 * 상태는 전부 store/notify.ts 가 갖는다. 여기는 그리기와 "누르면 이동"만 부른다(이동 자체는 Shell 이 안다).
 */

/** 누르면 — Shell 의 이동(공간·세션) 뒤에 그 공간 안의 자리(go, M3 에이전트 탭)로. */
const pickWith = (onPick: (n: Note) => void) => (n: Note) => {
  onPick(n)
  n.go?.()
}

const KIND_ICON: Record<NoteKind, typeof Bell> = { wait: CircleQuestionMark, done: CircleCheck, error: CircleX, info: Info }

function ago(at: number, now: number): string {
  const m = Math.round((now - at) / 60000)
  if (m < 1) return t('notify.ago.now')
  if (m < 60) return t('notify.ago.min').replace('{n}', String(m))
  return t('notify.ago.hour').replace('{n}', String(Math.round(m / 60)))
}

function NoteBody({ n }: { n: Note }) {
  const K = KIND_ICON[n.kind]
  return (
    <>
      <span className={'ntf-k ' + n.kind} role="img" aria-label={t('notify.kind.' + n.kind)}>
        <K aria-hidden />
      </span>
      <span className="ntf-b">
        <span className="ntf-t">{n.title}</span>
        {n.body && <span className="ntf-body">{n.body}</span>}
        <span className="ntf-m">
          {n.space === 'term' ? <SquareTerminal aria-hidden /> : <Sparkles aria-hidden />}
          {t('space.' + n.space)}
          {n.ctx && ` · ${n.ctx}`}
        </span>
      </span>
    </>
  )
}

/** 타이틀바 벨 — 안 읽음이면 점(숫자 없음). 드롭다운: 새/지난, 누르면 이동, 모두 읽음, 설정 › 알림. */
export function NotifyBell({
  open,
  onOpenChange,
  onPick,
  onSettings
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (n: Note) => void
  onSettings: () => void
}) {
  const { notes } = useNotes()
  const wrap = useRef<HTMLSpanElement>(null)
  const pick = pickWith(onPick)
  const un = hasUnread(notes)

  // 바깥을 누르거나 Esc — 닫힌다(시안). 캡처로 받아 터미널이 Esc 를 먹기 전에 닫는다.
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onOpenChange(false)
    }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, onOpenChange])

  const fresh = notes.filter((n) => !n.read)
  const old = notes.filter((n) => n.read)
  const now = Date.now()
  const item = (n: Note) => (
    <button key={n.id} type="button" className={'ntf-item' + (n.read ? '' : ' unread')} data-note={n.id} onClick={() => pick(n)}>
      <NoteBody n={n} />
      <span className="ntf-time">{ago(n.at, now)}</span>
    </button>
  )
  return (
    <span className="tb-bellwrap" ref={wrap}>
      <button
        type="button"
        className={'tb-bell' + (open ? ' on' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={un ? t('notify.label.unread') : t('notify.label')}
        title={t('notify.label')}
        onClick={() => onOpenChange(!open)}
      >
        <Bell aria-hidden />
        {un && <i className="tb-bell-dot" />}
      </button>
      {open && (
        <div className="ntf-menu" role="dialog" aria-label={t('notify.label')}>
          <div className="ntf-head">
            <b>{t('notify.label')}</b>
            {fresh.length > 0 && <span className="ntf-cnt">{t('notify.unread').replace('{n}', String(fresh.length))}</span>}
            <button type="button" className="ntf-readall" disabled={!fresh.length} onClick={readAllNotes}>
              <CheckCheck aria-hidden />
              {t('notify.readAll')}
            </button>
          </div>
          <div className="ntf-list">
            {notes.length ? (
              <>
                {fresh.length > 0 && <div className="ntf-sec">{t('notify.new')}</div>}
                {fresh.map(item)}
                {old.length > 0 && <div className="ntf-sec">{t('notify.old')}</div>}
                {old.map(item)}
              </>
            ) : (
              <div className="ntf-empty">
                <Bell aria-hidden />
                <b>{t('notify.empty.title')}</b>
                <span>{t('notify.empty.desc')}</span>
              </div>
            )}
          </div>
          <button type="button" className="ntf-foot" onClick={onSettings}>
            <SlidersHorizontal aria-hidden />
            {t('notify.settings')}
            <ChevronRight aria-hidden />
          </button>
        </div>
      )}
    </span>
  )
}

/**
 * 오른쪽 아래 토스트 — 최대 셋, 넘치면 위에 "+n" 알약(누르면 벨). 올리거나 포커스하면 수명이 멈추고(CSS),
 * 누르면 그 공간·세션으로 간다. 수명은 아래 막대의 CSS 애니메이션이 끝날 때(animationend) 닫는다 —
 * 숨은 토스트는 그려지지 않으므로 보일 때부터 수명이 흐른다.
 */
export function NotifyToasts({ onPick, onMore }: { onPick: (n: Note) => void; onMore: () => void }) {
  const { notes } = useNotes()
  const { shown, more } = toastView(notes)
  const pick = pickWith(onPick)
  // OS 알림을 눌러도 같은 길로 간다(store/notify openNoteVia). 토스트 자리는 늘 붙어 있다.
  useEffect(() => {
    setNoteOpener(pickWith(onPick))
    return () => setNoteOpener(null)
  }, [onPick])
  if (!shown.length) return null
  return (
    <div className="ntf-toasts" role="status" aria-live="polite">
      {more > 0 && (
        <button type="button" className="ntf-more" onClick={onMore}>
          {t('notify.more').replace('{n}', String(more))}
        </button>
      )}
      {shown.map((n) => (
        <div
          key={n.id}
          className="ntf-toast"
          data-note={n.id}
          data-kind={n.kind}
          role="button"
          tabIndex={0}
          title={t('notify.goTip')}
          onClick={() => pick(n)}
          onKeyDown={(e) => e.key === 'Enter' && pick(n)}
        >
          <NoteBody n={n} />
          <button
            type="button"
            className="ntf-x"
            aria-label={t('notify.close')}
            onClick={(e) => {
              e.stopPropagation()
              dismissToast(n.id)
            }}
          >
            <X aria-hidden />
          </button>
          <i
            className={'ntf-life ' + n.kind}
            style={{ animationDuration: TOAST_LIFE[n.kind] + 'ms' }}
            onAnimationEnd={() => dismissToast(n.id)}
          />
        </div>
      ))}
    </div>
  )
}
