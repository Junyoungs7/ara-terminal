import { useEffect, useState } from 'react'
import { BrandOrb } from './BrandOrb'
import { honorific } from '@shared/araPersona'
import { t } from '../i18n'

/**
 * 부팅 인사(#139) — 준영님: *"아이언맨의 자비스처럼."*
 *
 * **세 가지를 지킨다.** 멋은 한 번 보고 말지만 방해는 매일 쌓인다:
 *  ① **짧다.** 1.4초. 그 시간은 어차피 워크스페이스 복원·세션 재연결에 쓰이던 시간이라
 *     실제로 늘어나는 대기가 거의 없다.
 *  ② **건너뛴다.** 아무 키·클릭이면 즉시 사라진다 — 급할 때 화면이 사람을 붙잡으면 안 된다.
 *  ③ **끌 수 있다.** 설정 [일반]. 매일 켜는 사람에게는 셋째 날부터 방해다.
 *
 * **가짜 진행 표시를 하지 않는다.** "세션 복원 중… 완료" 같은 줄을 흉내 내면 그럴듯하지만
 * 거짓말이다(실제로는 아무것도 안 재고 있다). 인사와 이름만 띄운다.
 *
 * 애니메이션은 전부 CSS 다 — 자바스크립트 타이머는 **사라지는 시점 하나**뿐이다.
 * `prefers-reduced-motion` 이면 움직임 없이 잠깐 떴다 사라진다(styles 쪽에서 처리).
 */

/** 화면에 머무는 시간. 이보다 길면 "빨리 좀"이 되고, 짧으면 글자를 못 읽는다. */
export const SPLASH_MS = 1400

export function BootSplash({ name, onDone }: { name: string; onDone: () => void }): JSX.Element {
  // 사라지는 중 — 즉시 언마운트하면 뚝 끊긴다(0.35초 동안 흐려진다).
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const bye = (): void => setLeaving(true)
    const timer = setTimeout(bye, SPLASH_MS)
    // 아무 키·클릭이면 건너뛴다. capture 로 잡는다 — 아래 화면이 그 클릭을 먹으면 안 된다.
    window.addEventListener('keydown', bye, true)
    window.addEventListener('mousedown', bye, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', bye, true)
      window.removeEventListener('mousedown', bye, true)
    }
  }, [])

  useEffect(() => {
    if (!leaving) return
    const gone = setTimeout(onDone, 350)
    return () => clearTimeout(gone)
  }, [leaving, onDone])

  return (
    <div className={'boot' + (leaving ? ' out' : '')} aria-hidden>
      <div className="boot-in">
        <div className="boot-mark">
          <BrandOrb />
        </div>
        <div className="boot-name">A.R.A</div>
        {/* 이름이 있으면 그 이름으로, 없으면 그냥 인사한다(첫 실행에는 곧 이름을 묻는다). */}
        <div className="boot-hi">{name ? t('boot.hi').replace('{n}', honorific(name)) : t('boot.hi.anon')}</div>
        <div className="boot-sweep" />
      </div>
    </div>
  )
}
