import { useEffect, useState } from 'react'
import { BrandOrb } from './BrandOrb'
import { honorific } from '@shared/araPersona'
import { greetText, pickGreeting, type Greet } from '@shared/bootGreeting'

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
 * 한 줄은 **매번 다르다**(준영님 요청) — 인사·반가움·명언을 섞어 뽑는다. 고르는 규칙은
 * shared/bootGreeting.ts 가 순수 함수로 갖는다(같은 줄이 두 번 연속 안 나오는 것까지 검사 대상이다).
 *
 * 애니메이션은 전부 CSS 다 — 자바스크립트 타이머는 **사라지는 시점 하나**뿐이다.
 * `prefers-reduced-motion` 이면 움직임 없이 잠깐 떴다 사라진다(styles 쪽에서 처리).
 */

/**
 * 화면에 머무는 시간.
 *
 * 1400 이었는데 **읽기 전에 지나갔다**(2026-08-31 준영님: "너무 빨리 지나가는데 2초로"). 매번 다른
 * 한 줄을 뽑아 놓고 못 읽게 하면 그 장치가 통째로 헛돈다 — 사라지는 350ms 를 빼면 실제로 읽을 수
 * 있던 시간은 1초 남짓이었다.
 */
export const SPLASH_MS = 2000

/**
 * 직전에 띄운 줄. 같은 것이 두 번 연속 나오면 "랜덤"으로 안 느껴진다.
 *
 * **localStorage 에 둔다**(설정 파일이 아니라): 이건 사용자가 고른 값이 아니라 잠깐의 기억이고,
 * workspace.json 에 넣으면 앱을 켤 때마다 설정 파일이 바뀐다. 프로필마다 따로인 것도 여기가 맞다.
 */
const LAST_KEY = 'ara.boot.lastGreet'
const readLast = (): string | undefined => {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined
  } catch {
    return undefined // 저장소가 막힌 판 — 없으면 없는 대로 돈다
  }
}
const writeLast = (v: string): void => {
  try {
    localStorage.setItem(LAST_KEY, v)
  } catch {
    /* 저장 못 해도 인사는 뜬다 */
  }
}

export function BootSplash({ name, onDone }: { name: string; onDone: () => void }): JSX.Element {
  // 사라지는 중 — 즉시 언마운트하면 뚝 끊긴다(0.35초 동안 흐려진다).
  const [leaving, setLeaving] = useState(false)
  // 뽑기는 **한 번만** — 렌더마다 다시 뽑으면 글자가 깜빡인다.
  const [greet] = useState<Greet>(() => {
    const last = readLast()
    const g = pickGreeting({ name, hour: new Date().getHours(), rand: Math.random, ...(last ? { avoid: last } : {}) })
    writeLast(g.text)
    return g
  })

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
        {/* 매번 다른 한 줄. 명언이면 아래에 출처가 붙는다(없는 출처는 지어내지 않는다). */}
        <div className="boot-hi">{greetText(greet, honorific(name))}</div>
        {greet.by && <div className="boot-by">— {greet.by}</div>}
        <div className="boot-sweep" />
      </div>
    </div>
  )
}
