// NSIS 스크립트에 보이지 않는 제어 문자가 섞이면 makensis 가 "unterminated string" 으로 설치본 빌드를 깬다.
// M4 때 `WindowsPowerShell\v1.0` 의 `\v` 가 세로 탭(0x0B) 한 바이트로 들어가 3.0.0-preview.1 빌드가 실패했다 — 소스로는 안 보인다.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'resources')

describe('resources/*.nsh', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.nsh'))) {
    it(`${f} 에 탭·줄바꿈 말고 제어 문자가 없다`, () => {
      const bad = [...readFileSync(join(dir, f))].filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)
      expect(bad).toEqual([])
    })
  }
})
