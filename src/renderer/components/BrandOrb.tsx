// A.R.A 브랜드 마크 — **프롬프트가 배가 된다**(2026-08-23 준영님 확정, design-system §8).
// 선체는 굽은 `_`, 뱃머리는 `>`. 이름의 뜻(아라 = 바다)과 제품의 성격(터미널)이 한 그림에서 만난다.
// 앱 아이콘(resources/icons/ara-icon.svg)과 같은 형태를 **타이틀바 17px 용으로 단순화**한 판이다:
// 물결을 두 겹에서 한 겹으로 줄였다 — 그 크기에서 두 겹은 뭉쳐서 얼룩으로 보인다.
// 색은 var(--accent)/var(--accent-bright) 를 상속한다(테마를 갈면 마크도 따라간다).
export function BrandOrb() {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="A.R.A">
      {/* 뱃머리 = 프롬프트 꺾쇠 */}
      <path
        d="M12.4 8.2 L16.4 11.6 L12.4 15"
        stroke="var(--accent-bright)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 선체 = 아래로 굽은 밑줄 */}
      <path d="M8 17.4 q8 4.2 16 0" stroke="var(--accent-bright)" strokeWidth="2.7" strokeLinecap="round" />
      {/* 바다 — 한 겹만. 배보다 가늘고 어둡게 둬야 이 크기에서 둘이 갈린다 */}
      <path
        d="M6.5 23.5 q2.6 -2.2 5.2 0 q2.6 2.2 5.2 0 q2.6 -2.2 5.2 0"
        stroke="var(--accent)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}
