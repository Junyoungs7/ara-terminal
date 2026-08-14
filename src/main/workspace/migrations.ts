import { SCHEMA_VERSION, type WorkspaceSnapshot } from '@shared/types'

// schemaVersion 순차 마이그레이션 (계획서 §B.3). v1이 현재 최신이라 등록된 스텝은 아직 없다.
// n → n+1 변환을 이 맵에 추가하면 migrate가 순차 적용한다.
type MigrationStep = (snap: Record<string, unknown>) => Record<string, unknown>

const STEPS: Record<number, MigrationStep> = {
  // v1 → v2, v2 → v3: 둘 다 ui.ctxMenuStyle 을 'list' 로 내리는 스텝이었다. #67(2026-08-14)에서
  // 라디얼·스마트 팔레트를 지워 그 필드 자체가 없어졌으므로 남은 일은 버전 올리기뿐이다.
  // (스텝을 지우면 옛 파일이 마이그레이션 경로를 잃고 기본 스냅샷으로 떨어진다 — 남겨 둔다.)
  1: (s) => ({ ...s, schemaVersion: 2 }),
  2: (s) => ({ ...s, schemaVersion: 3 }),
  // v3 → v4: W4sat F21 — 프로필에 type 판별 필드가 생겼다. 옛 프로필은 전부 ssh였으므로 type 없는
  // 항목에만 'ssh' 를 채운다(이미 있으면 손대지 않는다 — 없을 리 없지만 재적용 안전성).
  3: (s) => {
    const profiles = Array.isArray(s.profiles) ? (s.profiles as Record<string, unknown>[]) : []
    return {
      ...s,
      schemaVersion: 4,
      profiles: profiles.map((p) => (p.type ? p : { ...p, type: 'ssh' }))
    }
  },
  // v4 → v5: W5 아라 멀티 프로바이더 — 단일 ui.aiModel(anthropic 전용) 을 provider-분리
  // ui.aiModels{provider:model} 로 옮긴다. 실제 사용자가 골라 둔 모델명이라 버리지 않고 anthropic
  // 칸으로 이관한다(v3→v4 의 프로필 type 백필과 같은 실 마이그레이션 — defaulting 이 아니다).
  4: (s) => {
    const ui = (s.ui ?? {}) as Record<string, unknown>
    const legacyModel = typeof ui.aiModel === 'string' ? ui.aiModel : undefined
    const { aiModel: _legacy, ...restUi } = ui
    return {
      ...s,
      schemaVersion: 5,
      ui: {
        ...restUi,
        aiProvider: 'anthropic',
        aiModels: legacyModel ? { anthropic: legacyModel } : {},
        aiCompatibleBaseUrl: ''
      }
    }
  }
}

// 알 수 없는 미래 버전이거나 스텝이 없으면 null → 호출부가 기본 스냅샷으로 폴백.
export function migrate(raw: Record<string, unknown>): WorkspaceSnapshot | null {
  let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version > SCHEMA_VERSION) return null
  let snap = raw
  while (version < SCHEMA_VERSION) {
    const step = STEPS[version]
    if (!step) return null
    snap = step(snap)
    version = typeof snap.schemaVersion === 'number' ? snap.schemaVersion : version + 1
  }
  return snap as unknown as WorkspaceSnapshot
}
