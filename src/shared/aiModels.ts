/**
 * 아라 대화에서 고를 수 있는 Claude Code 모델(#137).
 *
 * **런타임에 바뀐다**(2026-08-25 실측): `control_request{subtype:'set_model'}` 이 `success` 를 주고
 * 곧바로 `init` 이 새 모델로 다시 온다 — 재기동도 `--resume` 도 필요 없다. 그래서 이 고르기는
 * 즉시 반영되고, 대화가 끊기지 않는다.
 *
 * **별칭으로 둔다**(2026-10-20 v2): `opus`·`sonnet`·`haiku`·`fable` 은 CLI 가 그때의 최신 모델로
 * 풀어 준다 — 모델이 새로 나와도 이 표를 고칠 일이 없다(전에는 버전 박힌 ID 라 금방 낡았다).
 * 목록을 고정하는 이유는 그대로다: 자유 입력이면 오타 한 자에 프로세스가 조용히 기본 모델로 돈다.
 */
export type AraModel = { id: string; label: string; hint: string }

/** 첫 항목은 **고르지 않음** — 사용자의 `~/.claude`(계정) 기본값을 그대로 쓴다는 뜻이다. */
export const ARA_MODELS: readonly AraModel[] = [
  { id: '', label: '기본값', hint: '계정 설정' },
  { id: 'opus', label: 'Opus', hint: '가장 강력' },
  { id: 'sonnet', label: 'Sonnet', hint: '균형' },
  { id: 'haiku', label: 'Haiku', hint: '빠름·가벼움' },
  { id: 'fable', label: 'Fable', hint: '긴 작업' }
] as const

/** 저장·전달값 클램프. 목록 밖(낡은 버전 ID 포함)은 **기본값**으로 내린다. */
export function araModelOf(v: unknown): string {
  return typeof v === 'string' && ARA_MODELS.some((m) => m.id === v && m.id !== '') ? v : ''
}

/** 화면에 쓸 이름. 빈 값이면 '기본값'. */
export function araModelLabel(id: string): string {
  return ARA_MODELS.find((m) => m.id === id)?.label ?? ARA_MODELS[0].label
}
