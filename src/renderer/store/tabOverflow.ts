// FB-tabs: 탭바가 넘쳤는지(오버플로 드롭다운을 보여줄지) 판정하는 순수 함수.
// 실제 폭은 TermTabbar 가 DOM에서 재서(scrollWidth/clientWidth) 넘긴다 — 여기는 비교만 한다.
export function isTabOverflowing(availableWidth: number, contentWidth: number): boolean {
  return contentWidth > availableWidth + 1 // 서브픽셀 반올림 오차 여유
}
