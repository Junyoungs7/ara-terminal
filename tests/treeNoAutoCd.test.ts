// 🔴 파일 트리에서 폴더에 들어가도 **터미널에 cd 를 치지 않는다** (2026-09-28 준영님 제보).
//
// 예전엔 `enterDir` 가 활성 세션에 `cd …⏎` 를 보냈다. 아라는 그 세션에서 셸이 프롬프트에 서
// 있는지 모르므로, claude·codex 가 돌던 탭에서는 그 줄이 **AI 에게 프롬프트로 들어갔다.**
// 이제 cd 는 트리 머리의 [터미널도 여기로] 버튼을 누를 때만 나간다.
//
// ⚠️ 소스를 읽는 시험이다 — 실제 클릭은 실기 확인 항목이다. 이 결함의 본체가 "그 함수가
//    onCdTerminal 을 부른다"는 한 줄이었으므로 그 한 줄을 지킨다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'src/renderer/components/FileTree.tsx'), 'utf8')

/** `const enterDir = useCallback(` 부터 그 useCallback 이 닫히는 `)` 까지. */
function enterDirBody(): string {
  const at = src.indexOf('const enterDir = useCallback(')
  expect(at).toBeGreaterThan(-1)
  const end = src.indexOf('\n  )', at)
  return src.slice(at, end)
}

describe('🔴 폴더 진입이 터미널로 cd 를 보내지 않는다', () => {
  it('enterDir 안에 onCdTerminal 이 없다', () => {
    expect(enterDirBody()).not.toContain('onCdTerminal')
  })

  it('★ cd 는 버튼 하나에서만 나간다 — 호출 자리가 정확히 하나', () => {
    // `onCdTerminal(` 와 `onCdTerminal?.(` 를 둘 다 센다 — 옛 코드가 뒤쪽 모양이었다.
    const calls = src.match(/onCdTerminal(\?\.)?\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(src).toMatch(/data-action="file\.cdTerminal"[\s\S]{0,200}onClick=\{\(\) => onCdTerminal\(path\)\}/)
  })

  it('배선이 없는 자리(작업대)에서는 버튼을 그리지 않는다', () => {
    expect(src).toMatch(/\{onCdTerminal && \(\s*<button/)
  })
})
