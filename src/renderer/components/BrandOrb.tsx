// A.R.A 브랜드 마크 — 오리지널 "별자리 노드 거미" (design-system §8, 타이틀바 17px용 단순화판).
// 색은 var(--accent)/var(--accent-bright) 상속. 마블 IP·빨강파랑·방사형 거미줄 없음.
export function BrandOrb() {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="A.R.A">
      {/* 다리 3쌍 — 각진 회로형 폴리라인 */}
      <g
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 12 L7.5 8 L5 9.5" />
        <path d="M13.7 15 L6.5 15 L4.5 17" />
        <path d="M14 18 L7.5 21.5 L6 24" />
        <path d="M18 12 L24.5 8 L27 9.5" />
        <path d="M18.3 15 L25.5 15 L27.5 17" />
        <path d="M18 18 L24.5 21.5 L26 24" />
      </g>
      {/* 두흉부 + 복부 (2노드 몸통) */}
      <ellipse cx="16" cy="13" rx="2.6" ry="2.3" fill="var(--accent-bright)" />
      <ellipse cx="16" cy="20.5" rx="4.4" ry="5.6" fill="var(--accent-bright)" />
      {/* 센서 코어 */}
      <circle cx="16" cy="20.5" r="1.6" fill="var(--bg-surface)" />
    </svg>
  )
}
