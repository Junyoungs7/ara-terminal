// `direction: rtl` 로 앞을 자르는 경로 칸은 양끝 LRM(::before/::after)이 있어야 한다 — 없으면 bidi 가 맨 앞 `/` 를
// 끝으로 보내 `/srv/배포` 가 `srv/배포/` 로 보인다(1.0.22 QA). 새 rtl 칸이 생기면 이 시험이 문다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync('src/renderer/styles/shell.css', 'utf8')

function rtlSelectors(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/direction:\s*rtl/.test(m[2].replace(/\/\*[\s\S]*?\*\//g, ''))) out.push(...m[1].split(',').map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '').trim()))
  }
  return out
}
const missing = (src: string): string[] =>
  rtlSelectors(src).filter((s) => !src.includes(`${s}::before`) || !src.includes(`${s}::after`))

describe('rtl 경로 칸의 LRM', () => {
  it('rtl 칸이 있고(가드), 전부 양끝 LRM 이 있다', () => {
    expect(rtlSelectors(css).length).toBeGreaterThanOrEqual(5)
    expect(missing(css)).toEqual([])
  })
  it('LRM 을 뺀 소스는 문다', () => {
    expect(missing(css.replace('.sess-node .sess-cwd::after,', ''))).toEqual(['.sess-node .sess-cwd'])
  })
})
