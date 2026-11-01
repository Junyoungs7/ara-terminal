// M1 라운드 2 — 상단 공간 전환 `[터미널 | AI 작업]`(시안 SW-final). 공간 값과 판정만 여기 둔다
// (렌더러 prefs·main 저장이 같은 클램프를 쓴다).
//
// M3 부터 AI 작업 공간은 기본 공개다 — 옛 실험 기능 게이트(shownSpace)는 지웠다. 저장값이 곧 그릴 공간이다.

export type Space = 'term' | 'ai'
export const SPACES: readonly Space[] = ['term', 'ai']

/** 신뢰 경계 밖(스냅샷) 값 → 공간. 모르는 값은 터미널. */
export const spaceOf = (v: unknown): Space => (v === 'ai' ? 'ai' : 'term')
