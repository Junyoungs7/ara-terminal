import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { callNameOf, honorific } from '@shared/araPersona'
import { BrandOrb } from './BrandOrb'

/**
 * 첫 실행 인사(#138) — **이름을 받는다.**
 *
 * 준영님 요청(2026-08-25): *"처음 실행 시 이름을 멋있게 받고 그 이름으로 아라가 불러주게 하자."*
 *
 * 왜 이름부터인가: 아라는 말을 거는 물건이라 부를 말이 없으면 문장이 어색해진다("사용자님").
 * 한 번 받아 두면 그 뒤 모든 답이 그 이름으로 온다.
 *
 * **건너뛸 수 있다.** 이름을 강요하면 첫 화면이 관문이 된다 — 안 넣으면 기본 호칭으로 부르고,
 * 설정에서 언제든 넣을 수 있다(그 자리를 안내 문구에 적어 둔다).
 *
 * 껍데기는 Dialog 의 `.overlay/.modal` 을 그대로 쓴다 — 새 모달 프레임워크를 만들지 않는다.
 */
export function WelcomeModal({ open, onDone }: { open: boolean; onDone: (name: string) => void }): JSX.Element | null {
  const [name, setName] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  if (!open) return null
  const clean = callNameOf(name)
  return (
    <div className="overlay open" role="dialog" aria-modal="true" aria-label={t('welcome.title')}>
      <div className="modal welcome">
        {/* 브랜드 마크는 타이틀바가 쓰는 그것을 그대로 — 첫 화면에서 처음 보는 얼굴이다. */}
        <div className="wc-mark" aria-hidden>
          <BrandOrb />
        </div>
        <div className="wc-t">{t('welcome.title')}</div>
        <div className="wc-d">{t('welcome.desc')}</div>
        <input
          ref={ref}
          className="wc-input"
          type="text"
          maxLength={20}
          spellCheck={false}
          placeholder={t('welcome.placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onDone(clean)
          }}
        />
        {/* 어떻게 불릴지 **미리 보여 준다** — 넣기 전에 알면 고쳐 쓰게 된다. */}
        <div className="wc-prev">{t('welcome.preview').replace('{n}', honorific(clean))}</div>
        <div className="wc-ft">
          <button type="button" className="btn sec" data-action="welcome.skip" onClick={() => onDone('')}>
            {t('welcome.skip')}
          </button>
          <button type="button" className="btn pri" data-action="welcome.ok" onClick={() => onDone(clean)}>
            {t('welcome.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
