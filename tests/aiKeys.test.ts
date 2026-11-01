// M5 R3 — AI 키 vault id 공용화. 음성(2.1)은 아라 채팅 엔진(AraSession)에 기대지 않고 이 자리에서 키 id 를 받는다.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { aiKeyVaultId } from '../src/main/secrets/aiKeys'

describe('aiKeyVaultId 공용 자리', () => {
  it('저장된 키 이름이 그대로다 — 바뀌면 사용자가 넣어 둔 키를 못 찾는다', () => {
    expect(aiKeyVaultId('google')).toBe('ai.apiKey.google')
    expect(aiKeyVaultId('anthropic')).toBe('ai.apiKey.anthropic')
  })
  it('음성 IPC 는 채팅 엔진을 import 하지 않는다(엔진을 바꿔도 음성 키 경로가 산다)', () => {
    const src = readFileSync('src/main/ipc/registerVoiceIpc.ts', 'utf8')
    expect(src).toContain("from '../secrets/aiKeys'")
    expect(src).not.toMatch(/from '\.\.\/ai\//)
  })
})
