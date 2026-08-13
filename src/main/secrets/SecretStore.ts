// SecretStore 인터페이스 (계획서 §B.4). 구현체와 무관하게 평문 반환 금지가 계약이다.
export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
}
