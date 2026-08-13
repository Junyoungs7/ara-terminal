// 프로바이더 함수 테이블 — 클래스 계층·팩토리·DI 없음. AraSession 은 여기서 골라 부르기만 한다.
import type { AiProvider } from '@shared/types'
import { anthropicAdapter } from './anthropic'
import { openaiAdapter, compatibleAdapter } from './openaiCompatible'
import { googleAdapter } from './google'
import type { ProviderAdapter } from './types'

export const PROVIDERS: Record<AiProvider, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
  compatible: compatibleAdapter
}

export * from './types'
