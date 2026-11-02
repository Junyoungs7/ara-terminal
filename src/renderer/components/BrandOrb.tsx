import { useId } from 'react'
import { MARK_FACES, MARK_GRADS, MARK_VIEWBOX } from './brandMark'

// ARA 브랜드 마크 — **접힌 4갈래 별**(2026-11-02 준영님 확정 보드, D:\AI\OFA\docs\brand\final).
// 왼쪽 아래로 길게 뻗은 꼬리 + 접힌 두 면(a 위·꼬리 / b 아래 갈래). 시작 화면·첫 인사가 쓴다.
//
// 경로·색은 **생성물이다**(brandMark.ts ← scripts/make-brand-svg.mjs ← 키트). 색은 브랜드 그라데이션
// 그대로 — 테마 강조색(--accent, 사람 앰버)을 따르지 않는다: 브랜드 색은 마크 자리에서만 쓰고
// UI 신호색(사람 앰버·AI 인디고~스카이)은 바꾸지 않는다. 밝은 변형이라 라이트·다크 바탕 둘 다 읽힌다.
export function BrandOrb() {
  // 한 화면에 둘 이상 그려질 수 있다(시작 화면 위 첫 인사) — 그라데이션 id 가 겹치면 안 된다.
  const id = useId()
  return (
    <svg viewBox={MARK_VIEWBOX} xmlns="http://www.w3.org/2000/svg" aria-label="ARA">
      <defs>
        {MARK_GRADS.map((g, i) => (
          <linearGradient key={i} id={`${id}g${i}`} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
            {g.stops.map(([o, c]) => (
              <stop key={o} offset={o} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {MARK_FACES.map((d, i) => (
        <path key={i} d={d} fill={`url(#${id}g${i})`} />
      ))}
    </svg>
  )
}
