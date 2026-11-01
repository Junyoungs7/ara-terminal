// AI 키의 vault 자리 — 아라 채팅(API 엔진)과 2.1 음성(google 키)이 **같이** 쓴다(M5 R3: AraSession 에서 옮김).
// 채팅 엔진이 바뀌어도 음성 키 경로가 끊기지 않게 엔진 밖에 둔다.
import type { AiProvider } from '@shared/types'

// vault 키 네임스페이스. ProfileStore 는 프로필 UUID 를 vault 키로 쓰므로 충돌하지 않는다(점이 든
// 문자열은 UUID 가 아니다). 프로바이더별로 분리해 전환 시 재입력이 필요 없게 한다(설계 W5 §구조결정 3).
export function aiKeyVaultId(provider: AiProvider): string {
  return `ai.apiKey.${provider}`
}

export type KeyVault = {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
}
