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
import { isLockedState, LOCK_MIN_PASSWORD, type LockResult } from '@shared/lock'

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

/**
 * 6자리 칸 — 보이는 칸은 여섯이지만 **입력은 하나**다(투명 입력칸이 칸 위에 깔린다). 칸마다 입력을 두면
 * 지우기·붙여넣기·포커스 이동을 키 처리로 흉내 내야 하는데, 잠긴 동안은 키 이벤트를 가드가 삼킨다.
 * 하나면 글자 입력·지우기·붙여넣기가 전부 기본 동작이라 가드와 무관하게 된다. 설정 › 보안도 이걸 쓴다.
 */
export function OtpInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span className="otp-box">
      <input
        className="otp-real"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={'otp-cell' + (i === 3 ? ' gap' : '') + (i === value.length ? ' at' : '')} aria-hidden>
          {value[i] ?? ''}
        </span>
      ))}
    </span>
  )
}

/**
 * 비밀번호 분실(A안) — 시안 L-forgot 의 세 단계. ① 구글 OTP 확인 → ② 지워지는 것 확인 → ③ 새 비밀번호.
 * 끝나면 main 이 저장된 비밀값을 지우고 새 비밀번호로 연다(상태가 unlocked 가 되면 이 화면은 저절로 내려간다).
 */
function ForgotFlow({ otp, onBack }: { otp: boolean; onBack: () => void }) {
  const [code, setCode] = useState('')
  const [verified, setVerified] = useState(false)
  const [ack, setAck] = useState(false)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const longOk = p1.length >= LOCK_MIN_PASSWORD
  const same = p1 !== '' && p1 === p2

  const verify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || code.length !== 6) return
    setBusy(true)
    const r = await window.ev.lock.forgotVerify(code).catch((): LockResult => ({ ok: false, reason: 'wrong' }))
    setBusy(false)
    setCode('')
    if (r.ok) {
      setVerified(true)
      setMsg('')
    } else {
      setMsg(r.reason === 'wait' ? failText(r, r.waitMs ?? 0) : t(r.reason === 'noOtp' ? 'lock.forgot.noOtp' : 'lock.forgot.wrongOtp'))
    }
  }

  const reset = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy || !verified || !ack || !longOk || !same) return
    setBusy(true)
    const r = await window.ev.lock.forgotReset(p1).catch((): LockResult => ({ ok: false, reason: 'state' }))
    setBusy(false)
    setP1('')
    setP2('')
    if (r.ok) return
    if (r.reason === 'expired') setVerified(false)
    setMsg(t(r.reason === 'expired' ? 'lock.forgot.expired' : 'lock.forgot.fail'))
  }

  return (
    <div className="lock-forgot">
      <div className="lf-hd">
        <h2>{t('lock.forgot')}</h2>
        <button type="button" className="lf-back" onClick={onBack}>
          {t('lock.forgot.back')}
        </button>
      </div>
      <div className="lf-cols">
        <form className="lf-col" onSubmit={verify}>
          <div className={'lf-step' + (verified ? ' done' : '')}>{t('lock.forgot.s1')}</div>
          <h3>{t('lock.forgot.s1.title')}</h3>
          {otp ? (
            <>
              <div className="lock-cap">{t('lock.forgot.s1.desc')}</div>
              {!verified && (
                <div className="lf-otp">
                  <OtpInput value={code} onChange={setCode} label={t('lock.forgot.s1.title')} />
                  <button type="submit" className="btn pri" disabled={busy || code.length !== 6}>
                    {t('lock.forgot.verify')}
                  </button>
                </div>
              )}
              {verified && <div className="lf-ok">{t('lock.forgot.verified')}</div>}
            </>
          ) : (
            <div className="lock-cap">{t('lock.forgot.noOtp')}</div>
          )}
          <div className="lf-note">{t('lock.forgot.s1.note')}</div>
        </form>
        <div className="lf-col">
          <div className={'lf-step' + (ack ? ' done' : '')}>{t('lock.forgot.s2')}</div>
          <div className="lf-warn">
            <div className="lf-warn-t">{t('lock.forgot.s2.warn')}</div>
            <div className="lock-cap">{t('lock.forgot.s2.gone')}</div>
            <ul className="lf-list gone">
              <li>{t('lock.forgot.s2.g1')}</li>
              <li>{t('lock.forgot.s2.g2')}</li>
              <li>{t('lock.forgot.s2.g3')}</li>
            </ul>
            <div className="lock-cap">{t('lock.forgot.s2.kept')}</div>
            <ul className="lf-list kept">
              <li>{t('lock.forgot.s2.k1')}</li>
              <li>{t('lock.forgot.s2.k2')}</li>
            </ul>
          </div>
          <div className="lf-note">{t('lock.forgot.s2.note')}</div>
          <label className="lf-ack">
            <input type="checkbox" checked={ack} disabled={!verified} onChange={(e) => setAck(e.target.checked)} />
            {t('lock.forgot.s2.ack')}
          </label>
        </div>
        <form className="lf-col" onSubmit={reset}>
          <div className="lf-step">{t('lock.forgot.s3')}</div>
          <h3>{t('lock.forgot.s3.title')}</h3>
          <div className="lock-cap">{t('lock.forgot.new')}</div>
          <PasswordInput value={p1} onChange={setP1} placeholder={t('lock.forgot.new')} ariaLabel={t('lock.forgot.new')} />
          <div className="lock-cap">{t('lock.forgot.again')}</div>
          <PasswordInput value={p2} onChange={setP2} placeholder={t('lock.forgot.again')} ariaLabel={t('lock.forgot.again')} />
          <ul className="lf-checks">
            <li className={longOk ? 'ok' : undefined}>{t('lock.rule.len').replace('{n}', String(LOCK_MIN_PASSWORD))}</li>
            <li className={same ? 'ok' : undefined}>{t('lock.rule.same')}</li>
          </ul>
          <button type="submit" className="btn pri lf-go" disabled={busy || !verified || !ack || !longOk || !same}>
            {t('lock.forgot.go')}
          </button>
        </form>
      </div>
      <div className="lock-msg" role="status" aria-live="polite">
        {msg}
      </div>
    </div>
  )
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
  const [forgot, setForgot] = useState(false)

  useEffect(() => {
    const root = document.getElementById('root')
    if (root) {
      root.toggleAttribute('inert', locked)
      root.classList.toggle('lock-blur', locked)
    }
    if (locked) {
      if (document.activeElement instanceof HTMLElement && root?.contains(document.activeElement)) document.activeElement.blur()
      setLockedAt(new Date())
    } else setForgot(false)
  }, [locked])

  if (!v || !locked) return null

  const forgotLink = (
    <button type="button" className="lock-link" onClick={() => setForgot(true)}>
      {t('lock.forgot')}
    </button>
  )

  if (forgot) {
    return (
      <div className="lock-veil" role="dialog" aria-modal="true" aria-label={t('lock.forgot')}>
        <ForgotFlow otp={v.otp} onBack={() => setForgot(false)} />
      </div>
    )
  }

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
          {forgotLink}
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
          {forgotLink}
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
