/**
 * 아라 대화에서 고를 수 있는 Claude Code 모델(#137).
 *
 * **런타임에 바뀐다**(2026-08-25 실측): `control_request{subtype:'set_model'}` 이 `success` 를 주고
 * 곧바로 `init` 이 새 모델로 다시 온다 — 재기동도 `--resume` 도 필요 없다. 그래서 이 고르기는
 * 즉시 반영되고, 대화가 끊기지 않는다.
 *
 * 목록을 여기 고정해 두는 이유: 이름을 자유 입력으로 두면 오타 한 자에 프로세스가 조용히
 * 기본 모델로 돌아간다(무엇으로 돌고 있는지 모르게 된다). 새 모델이 나오면 이 표에 한 줄 더한다.
 */
export type AraModel = { id: string; label: string; hint: string }

/** 첫 항목은 **고르지 않음** — 사용자의 `~/.claude` 기본값을 그대로 쓴다는 뜻이다. */
export const ARA_MODELS: readonly AraModel[] = [
  { id: '', label: '기본', hint: '내 Claude Code 설정을 그대로' },
  { id: 'claude-opus-5', label: 'Opus 5', hint: '가장 똑똑하고 가장 느리다' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: '평소 쓰기 좋은 균형' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: '빠르고 싸다 — 간단한 일에' }
] as const

/** 저장·전달값 클램프. 목록 밖은 **기본**으로 내린다(모르는 이름을 프로세스에 넘기지 않는다). */
export function araModelOf(v: unknown): string {
  return typeof v === 'string' && ARA_MODELS.some((m) => m.id === v && m.id !== '') ? v : ''
}

/** 화면에 쓸 이름. 빈 값이면 '기본'. */
export function araModelLabel(id: string): string {
  return ARA_MODELS.find((m) => m.id === id)?.label ?? '기본'
}
