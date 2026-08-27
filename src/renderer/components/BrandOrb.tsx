import { MARK_FRONT_CLIP, MARK_RING, MARK_SPARK } from './brandMark'

// A.R.A 브랜드 마크 — **터미널을 도는 고리**(2026-08-27 준영님 확정, design-system §8).
// 원격 서버(랙)를 마우스로 다루는 터미널 + 그 위를 도는 AI. 앱 아이콘과 같은 도안을
// **타이틀바 17px 용으로 덜어낸 판**이다: 랙을 뺐다 — 그 크기에서 막대 셋은 얼룩으로 뭉친다.
//
// 고리 좌표는 **생성물이다**(brandMark.ts ← scripts/make-brand-svg.mjs). 손으로 찍으면 어긋나
// "그은 선"이 된다. 앞쪽 절반을 한 번 더 그려 창 앞으로 지나가게 하는 것도 아이콘과 같은 방식이다.
// 색은 var(--accent)/var(--accent-bright) 를 상속한다(테마를 갈면 마크도 따라간다).
export function BrandOrb() {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="A.R.A">
      <defs>
        <clipPath id="orbFront">
          <polygon points={MARK_FRONT_CLIP} />
        </clipPath>
      </defs>
      {/* 고리 뒤쪽 — 창 뒤로 지나간다. 어둡게 둬야 뒤에 있어 보인다 */}
      <path d={MARK_RING} fill="var(--accent)" fillRule="evenodd" opacity=".55" />
      {/* 터미널 창 + 프롬프트 */}
      <rect x="8.6" y="10.4" width="14.8" height="11.4" rx="2.8" stroke="var(--accent-bright)" strokeWidth="2" />
      <path
        d="M12 13.7 L14.7 15.9 L12 18.1"
        stroke="var(--accent-bright)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M16.8 18.3 L20.4 18.3" stroke="var(--accent-bright)" strokeWidth="2" strokeLinecap="round" />
      {/* 고리 앞쪽 — 같은 모양을 절반만 다시. 이음매가 없다 */}
      <g clipPath="url(#orbFront)">
        <path d={MARK_RING} fill="var(--accent-bright)" fillRule="evenodd" />
      </g>
      <path d={MARK_SPARK} fill="var(--accent-bright)" />
    </svg>
  )
}
