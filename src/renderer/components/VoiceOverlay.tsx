import { useEffect } from 'react'
import type { VoiceState } from '@shared/voice'
import type { VoiceUi } from '../store/voice'
import { t } from '../i18n'

// 음성 모드 화면 — 자비스식(2026-08-27 준영님: *"채팅보다 음성이 일렁이는 화면"*).
//
// 채팅창을 띄우지 않는 이유: 말로 시키는 사람은 **화면을 안 보고 있다.** 글을 읽히려고 만든
// 화면이 아니라 *지금 듣고 있다 / 생각 중이다 / 말하는 중이다* 를 곁눈으로 알리는 화면이다.
// 그래서 가운데는 파형뿐이고, 글은 아래에 자막으로 깔린다(나중에 눈으로 확인할 몫).
//
// **막대는 진짜 소리다.** 애니메이션이 아니라 AnalyserNode 의 주파수 값을 로그 간격으로 묶은
// 것이라(shared/voice.ts bars) 말을 멈추면 실제로 가라앉는다 — 그 정직함이 이 화면의 값어치다.

const LABEL: Record<VoiceState, string> = {
  off: 'voice.state.off',
  asleep: 'voice.state.asleep',
  listening: 'voice.state.listening',
  thinking: 'voice.state.thinking',
  speaking: 'voice.state.speaking'
}

export function VoiceOverlay({
  ui,
  wakeWord,
  onClose,
  onTalk
}: {
  ui: VoiceUi
  wakeWord: string
  onClose: () => void
  /** 칩을 눌러 바로 말하기(Alt+V 와 같은 길). */
  onTalk: () => void
}) {
  // Esc 로 닫는다. 캡처 단계에서 멈춰 뒤쪽 핸들러(터미널 검색 등)로 새지 않게 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // 잠자는 중에는 화면을 덮지 않는다 — 마이크만 열려 있을 뿐 사람은 일을 하고 있다.
  // 대신 **작은 칩**을 남긴다(2026-08-27 준영님: "음성 켜기 했는데 아무 반응이 없는데?").
  // 처음엔 아무것도 안 그렸는데, 그러면 켠 사람이 켜졌는지 알 길이 없다 — 켜져 있다는 사실과
  // 마이크가 실제로 살아 있다는 것(막대가 움직인다)을 이 칩 하나가 말한다.
  if (ui.state === 'asleep' || (ui.state === 'off' && ui.error)) {
    const dead = ui.state === 'off'
    return (
      <button
        type="button"
        className={'voice-chip' + (dead ? ' dead' : '')}
        data-voice="chip"
        onClick={dead ? undefined : onTalk}
        title={dead ? (ui.error ?? '') : t('voice.chip.title')}
      >
        <span className="vc-dot" />
        {!dead && (
          <span className="vc-bars" aria-hidden>
            {ui.bars.slice(0, 12).map((v, i) => (
              <span key={i} style={{ transform: `scaleY(${(0.12 + v * 1.6).toFixed(3)})` }} />
            ))}
          </span>
        )}
        <span className="vc-txt">
          {dead
            ? (ui.error ?? '')
            : ui.wakeReady
              ? t('voice.chip.wake').replace('{w}', wakeWord)
              : t('voice.chip.hotkey')}
        </span>
      </button>
    )
  }
  if (ui.state === 'off') return null

  const live = ui.state === 'listening'
  return (
    <div className={'voice-ov ' + ui.state} data-voice={ui.state} role="dialog" aria-live="polite" aria-label={t('voice.title')}>
      <div className="vo-stage">
        {/* 막대 — 가운데를 축으로 위아래로 자란다(한쪽으로만 자라면 그래프로 읽힌다). */}
        <div className="vo-bars" aria-hidden>
          {ui.bars.map((v, i) => (
            <span key={i} style={{ transform: `scaleY(${(0.06 + v * 0.94).toFixed(3)})` }} />
          ))}
        </div>
        <div className="vo-state">{t(LABEL[ui.state])}</div>
        <div className="vo-sub">
          {live ? t('voice.hint.listening') : ui.state === 'thinking' ? t('voice.hint.thinking') : t('voice.hint.speaking')}
        </div>
      </div>

      <div className="vo-cap">
        {ui.heard && (
          <div className="vo-line">
            <span className="vo-who me">{t('voice.who.me')}</span>
            <span className="vo-txt me">{ui.heard}</span>
          </div>
        )}
        {(ui.answer || ui.tools.length > 0) && (
          <div className="vo-line">
            <span className="vo-who ara">{t('voice.who.ara')}</span>
            <span className="vo-txt">
              {ui.answer}
              {ui.tools.length > 0 && <span className="vo-tool">🔧 {ui.tools.join(' · ')}</span>}
            </span>
          </div>
        )}
        {ui.error && <div className="vo-err">{ui.error}</div>}
        <div className="vo-foot">
          <span>
            <kbd>Esc</kbd> {t('voice.foot.close')}
          </span>
          <span>{t('voice.foot.stop')}</span>
          <span className="vo-wake">{t('voice.foot.wake').replace('{w}', wakeWord)}</span>
          <button type="button" className="vo-stop" data-action="voice.stop" onClick={onClose}>
            ■ {t('voice.stop')}
          </button>
        </div>
      </div>
    </div>
  )
}
