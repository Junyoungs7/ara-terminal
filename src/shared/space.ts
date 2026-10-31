// M1 라운드 2 — 상단 공간 전환 `[터미널 | AI 작업]`(시안 SW-final). 공간 값과 판정만 여기 둔다
// (렌더러 prefs·main 저장이 같은 클램프를 쓴다).
//
// AI 작업 공간은 M3 까지 **설정 › 고급 › 실험 기능**에서 켠 사람에게만 보인다(계획 M1). 꺼져 있으면
// 저장된 값이 'ai' 여도 터미널 공간을 그린다 — 실험 기능을 끈 순간 스위치와 함께 AI 작업 화면도 사라진다.

export type Space = 'term' | 'ai'
export const SPACES: readonly Space[] = ['term', 'ai']

/** 신뢰 경계 밖(스냅샷) 값 → 공간. 모르는 값은 터미널. */
export const spaceOf = (v: unknown): Space => (v === 'ai' ? 'ai' : 'term')

/** 지금 그릴 공간 — 실험 기능이 꺼져 있으면 늘 터미널. */
export const shownSpace = (p: { aiSpace: boolean; space: Space }): Space => (p.aiSpace ? p.space : 'term')
