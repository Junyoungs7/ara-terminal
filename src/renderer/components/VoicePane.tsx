// 2.1 음성 패널 — 작업대의 칸 하나(시안 V-photo-f). 화면에 하나뿐이다: 아라 전체를 조종하는 비서라
// 세션마다 두지 않는다(PLAN 결정). 얼굴은 다음 라운드 — 이번엔 자리와 상태 글자, 출력 음량 막대만.
import { useEffect, useRef } from 'react'
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { t } from '../i18n'
import { KEYMAP, isMac, keyText } from '../../shared/keymap'
import type { VoicePrefs } from '@shared/voice'
import { closeVoice, outputLevel, toggleMute, useVoice } from '../store/voice'

const BARS = 4

export function VoicePane({ prefs, onOpenAiSettings }: { prefs: VoicePrefs; onOpenAiSettings: () => void }) {
  const v = useVoice()
  const eqRef = useRef<HTMLSpanElement>(null)

  // 출력 음량 → 막대. React 상태로 두면 초당 60번 다시 그린다 — CSS 변수 하나만 바꾼다.
  // 다음 라운드 얼굴(입 열림)도 같은 outputLevel() 을 읽는다.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      eqRef.current?.style.setProperty('--lv', Math.min(1, outputLevel() * 4).toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const state = v.muted && v.status !== 'error' ? 'muted' : v.status
  const key = KEYMAP.find((k) => k.action === 'voice.toggle')
  const combo = key ? keyText(isMac() ? key.mac : key.win) : ''
  const lines = v.captions.slice(-prefs.captionLines)

  return (
    <div className="pane voice-pane focused" data-voice-state={state}>
      <div className="vp-hd">
        <b>{t('voice.pane.title')}</b>
        <span>Gemini Live</span>
        <span className="grow" />
        <button type="button" className={'btn sec' + (v.muted ? ' on' : '')} data-action="voice.mute" onClick={toggleMute} aria-pressed={v.muted}>
          {v.muted ? <MicOff size={13} /> : <Mic size={13} />}
          {t(v.muted ? 'voice.unmute' : 'voice.mute')}
        </button>
        <button type="button" className="btn sec" data-action="voice.hangup" onClick={closeVoice}>
          <PhoneOff size={13} />
          {t('voice.hangup')}
        </button>
      </div>
      <div className="vp-body">
        {/* 얼굴 자리(설정의 얼굴 선택은 저장만 — 그림은 다음 라운드). 자막만 고른 사람에게도 상태 글자는 보인다. */}
        <div className={'vp-face' + (prefs.face === 'none' ? ' bare' : '')} aria-hidden={prefs.face === 'none'} />
        <div className="vp-st" role="status">
          <span className="vp-eq" ref={eqRef} aria-hidden>
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span>{t('voice.st.' + state)}</span>
        </div>
        {v.noKey ? (
          <div className="vp-note">
            {t('voice.noKey')}
            <button type="button" className="lnk" onClick={onOpenAiSettings}>
              {t('voice.toAiSettings')}
            </button>
          </div>
        ) : v.status === 'error' ? (
          <div className="vp-note err">{v.reason === 'mic' ? t('voice.err.mic') : v.reason || t('voice.err.generic')}</div>
        ) : (
          prefs.listen === 'ptt' &&
          !v.talking && (
            <div className="vp-note">
              <kbd className="kbd">{combo}</kbd> {t('voice.pttHint')}
            </div>
          )
        )}
        <div className="vp-caps" aria-live="polite">
          {lines.map((c, i) => (
            <div key={i} className={'vp-cap ' + c.who + (c.done ? '' : ' now')}>
              <span className="w">{t(c.who === 'me' ? 'voice.me' : 'voice.ara')}</span>
              <span className="t">{c.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
