// p3-M21 펫 — Orca components/pet(pet-agent-state.ts · pet-overlay-visibility.ts) · main/ipc/pet.ts(pet-image-formats.ts)의 아라판 규칙(순수).
// 준영님 결정(안 1): 오른쪽 아래 떠 있는 펫, 끌어 옮김, 음성(아라 얼굴)이 열리면 숨김. **기본 캐릭터 없음 — 업로드만**, 기본 꺼짐.
// 뺀 것: 기본 캐릭터(Claudino·OpenCode·Gremlin), 스프라이트 묶음(pet.json), 상태 표시줄 [펫] 메뉴(설정 › 펫 과 펫 우클릭으로).
import type { AgentStatusView } from './agentHooks'

export const PET_SIZES = [80, 120, 180] as const
export type PetPrefs = {
  enabled: boolean
  /** 한 변 px(PET_SIZES). */
  size: number
  /** 올린 그림 파일 이름(userData/pet 안). 빈 값 = 아직 안 올림. */
  image: string
}
export const DEFAULT_PET: PetPrefs = { enabled: false, size: 120, image: '' }

/** Orca IMAGE_FORMATS — 확장자 → MIME. APNG 는 .png 그대로 온다. */
export const PET_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}
/** 그림 상한. Orca 는 64MB(Blob URL) — 아라는 data URL 로 IPC 를 건너므로 8MB. */
export const PET_MAX_BYTES = 8 * 1024 * 1024

/** 저장 파일 이름 — main 이 고정 이름(pet.<ext>)으로만 쓴다. 그 밖(경로 조각 등)은 거절. */
export const isPetImageName = (v: unknown): v is string => typeof v === 'string' && /^pet\.([a-z]+)$/.test(v) && v.slice(4) in PET_IMAGE_TYPES

/** 저장값(workspace.json ui.pet — 손으로 고칠 수 있다) → 확정값. */
export function petOf(raw: unknown): PetPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof PetPrefs, unknown>>
  return {
    enabled: src.enabled === true,
    size: (PET_SIZES as readonly unknown[]).includes(src.size) ? (src.size as number) : DEFAULT_PET.size,
    image: isPetImageName(src.image) ? src.image : ''
  }
}

export type PetMood = 'idle' | 'running' | 'waiting' | 'review'

/**
 * Orca agentStateAnimation — 막힘(승인·질문)이 하나라도 있으면 기다림, 일하는 게 있으면 달림, 끝난 게 있으면 검토, 아니면 쉼.
 * 아라 상태: working · blocked · idle(끝남). 에이전트만 끝나고 셸이 남은 탭(agentExited)은 세지 않는다.
 */
export function petMood(statuses: Iterable<AgentStatusView>): PetMood {
  let working = false
  let done = false
  for (const s of statuses) {
    if (s.agentExited || !s.state) continue
    if (s.state === 'blocked') return 'waiting'
    if (s.state === 'working') working = true
    else done = true
  }
  return working ? 'running' : done ? 'review' : 'idle'
}

/** 끌어 놓은 자리(오른쪽·아래 여백 px)를 창 안으로. 창이 작아져도 펫이 밖에 남지 않게. */
export function clampPetPos(pos: { right: number; bottom: number }, size: number, view: { w: number; h: number }): { right: number; bottom: number } {
  const c = (v: number, max: number): number => Math.round(Math.min(Math.max(0, v), Math.max(0, max)))
  return { right: c(pos.right, view.w - size), bottom: c(pos.bottom, view.h - size) }
}

/** 그림 올리기 결과. null = 고르기를 취소했다. 실패는 코드로(화면이 번역 — Orca PetImportFailure). */
export type PetImportResult = { ok: true; image: string } | { ok: false; error: 'type' | 'size' | 'read' } | null
