// 2.0 앱 잠금 화면 — 시안 mockups/v2/L-lock-b(본창 시계형)·L-lock-a(나머지 창·앱 켤 때 가운데 카드).
//
// 모든 창이 main.tsx 에서 본문(#root) **밖**의 #lock-root 에 이것을 하나씩 그린다. 잠기면:
//   · #root 에 inert(클릭·포커스·보조기기 차단) + 강한 블러(.lock-blur) — 세션은 그 뒤에서 그대로 돈다.
//   · 키 입력은 store/lock.ts 의 window 캡처 가드가 막는다(덮개 안 입력칸만 산다).
// 비밀번호 값은 이 컴포넌트 상태에만 잠깐 있고, 보낸 뒤 바로 비운다.
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { PasswordInput } from './PasswordInput'
import { IconLock } from './icons'
import { useLockView } from '../store/lock'
import { isLockedState, type LockResult } from '@shared/lock'

export type LockVariant = 'clock' | 'card'

// 시안 B 의 세션 칸은 이름 없이 "세션 n" — 잠긴 화면에 서버 이름을 내지 않는다. 칸은 이만큼까지만 그린다.
const MAX_TILES = 4
const TICK_MS = 1000

function useNow(on: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!on) return
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(id)
  }, [on])
  return now
}

const hhmm = (d: Date): string => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

function failText(r: LockResult, waitLeft: number): string {
  if (r.ok) return ''
  if (r.reason === 'wait') return t('lock.wait').replace('{s}', String(Math.ceil(waitLeft / 1000)))
  return t('lock.wrong')
}

function UnlockForm({ wide, onDone }: { wide: boolean; onDone?: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<LockResult>({ ok: true })
  const [waitUntil, setWaitUntil] = useState(0)
  const now = useNow(waitUntil > 0)
  const waitLeft = Math.max(0, waitUntil - now.getTime())
  const boxRef = useRef<HTMLFormElement>(null)

  // 잠기는 순간·창이 다시 앞으로 올 때 입력칸으로 — 마우스 없이 바로 친다.
  useEffect(() => {
    const focus = (): void => boxRef.current?.querySelector('input')?.focus()
    focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || !pw || waitLeft > 0) return
    setBusy(true)
    const r = await window.ev.lock.unlock(pw).catch((): LockResult => ({ ok: false, reason: 'wrong' }))
    setPw('')
    setBusy(false)
    setRes(r)
    if (!r.ok && r.waitMs) setWaitUntil(Date.now() + r.waitMs)
    if (r.ok) onDone?.()
  }

  const msg = waitLeft > 0 ? failText({ ok: false, reason: 'wait' }, waitLeft) : failText(res, 0)
  return (
    <form className={'lock-form' + (wide ? ' wide' : '')} onSubmit={submit} ref={boxRef}>
      <div className="lock-line">
        <PasswordInput value={pw} onChange={setPw} placeholder={t('lock.pw')} ariaLabel={t('lock.pw')} />
        <button type="submit" className="btn pri" disabled={busy || !pw || waitLeft > 0} data-action="lock.unlock">
          {t('lock.unlock')}
        </button>
      </div>
      <div className="lock-msg" role="status" aria-live="polite">
        {msg}
      </div>
    </form>
  )
}

function Sessions({ n, tiles }: { n: number; tiles: boolean }) {
  if (n <= 0) return null
  return (
    <div className="lock-sess">
      <span className="lock-live">
        <span className="lock-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        {t('lock.sessions').replace('{n}', String(n))}
      </span>
      {tiles &&
        Array.from({ length: Math.min(n, MAX_TILES) }, (_, i) => (
          <span className="lock-tile" key={i} aria-hidden>
            <span>{t('lock.tile').replace('{n}', String(i + 1))}</span>
            <span className="lock-eq">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </span>
        ))}
    </div>
  )
}

export function LockScreen({ variant }: { variant: LockVariant }) {
  const v = useLockView()
  const locked = !!v && isLockedState(v.state)
  const startup = v?.state === 'locked-startup'
  const now = useNow(locked)
  const [lockedAt, setLockedAt] = useState<Date | null>(null)

  useEffect(() => {
    const root = document.getElementById('root')
    if (root) {
      root.toggleAttribute('inert', locked)
      root.classList.toggle('lock-blur', locked)
    }
    if (locked) {
      if (document.activeElement instanceof HTMLElement && root?.contains(document.activeElement)) document.activeElement.blur()
      setLockedAt(new Date())
    }
  }, [locked])

  if (!v || !locked) return null

  // 앱을 켤 때는 어느 창이든 카드(A) — 시안 결정. 본창의 실행 중 잠금만 시계(B).
  if (variant === 'clock' && !startup) {
    return (
      <div className="lock-veil clock" role="dialog" aria-modal="true" aria-label={t('lock.title')}>
        <div className="lock-brand">
          <span className="lock-mark">A.R.A</span>
          <span className="lock-cap">
            <IconLock />
            {t('lock.badge')}
          </span>
        </div>
        <div className="lock-clock">
          <div className="lock-time">{hhmm(now)}</div>
          <div className="lock-date">
            {now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}
          </div>
        </div>
        <div className="lock-bottom">
          <UnlockForm wide />
          <Sessions n={v.sessions} tiles />
        </div>
      </div>
    )
  }

  return (
    <div className="lock-veil" role="dialog" aria-modal="true" aria-label={t('lock.title')}>
      <div className="lock-card">
        <div className="lock-top">
          <span className="lock-mark">A.R.A</span>
          <IconLock />
        </div>
        <h2>{t(startup ? 'lock.startup.title' : 'lock.title')}</h2>
        <div className="lock-sub">{t(startup ? 'lock.startup.sub' : 'lock.sub')}</div>
        <UnlockForm wide={false} />
        <div className="lock-row2">
          <span />
          <span className="lock-cap">{t('lock.rule')}</span>
        </div>
        {!startup && (
          <div className="lock-foot">
            <Sessions n={v.sessions} tiles={false} />
            <span className="lock-cap">{lockedAt ? t('lock.at').replace('{t}', hhmm(lockedAt)) : ''}</span>
          </div>
        )}
      </div>
    </div>
  )
}
