// fix-da1: 번들 conpty 의 시작 DA1 에 main 이 한 번만 답한다(PtyBackend.filterStartupDa1).
import { describe, it, expect } from 'vitest'
import { filterStartupDa1, startupDa1Initial, type StartupDa1 } from '../src/main/sessions/PtyBackend'

function run(chunks: string[]): { out: string[]; replies: number; st: StartupDa1 } {
  let st = startupDa1Initial()
  const out: string[] = []
  let replies = 0
  for (const c of chunks) {
    const r = filterStartupDa1(st, c)
    st = r.st
    if (r.reply) replies++
    out.push(r.out)
  }
  return { out, replies, st }
}

describe('fix-da1 — 시작 DA1 가로채기', () => {
  it('첫 질의만 가로채 답하고 그 바이트는 넘기지 않는다', () => {
    const r = run(['\x1b[1t', '\x1b[c\x1b[?1004h\x1b[?9001h', 'PS> '])
    expect(r.replies).toBe(1)
    expect(r.out).toEqual(['\x1b[1t', '\x1b[?1004h\x1b[?9001h', 'PS> '])
    expect(r.st).toBeNull()
  })

  it('조각 경계에서 쪼개진 질의도 잡는다', () => {
    const a = run(['abc\x1b', '[c\x1b[?1004h'])
    expect(a.replies).toBe(1)
    expect(a.out.join('')).toBe('abc\x1b[?1004h')
    const b = run(['\x1b[', 'c', 'x'])
    expect(b.replies).toBe(1)
    expect(b.out.join('')).toBe('x')
  })

  it('질의가 없으면 그대로 통과하고, 지켜보는 조각 수가 지나면 끝난다', () => {
    const r = run(['a', 'b\x1b', '[0m', 'd', 'e'])
    expect(r.replies).toBe(0)
    expect(r.out.join('')).toBe('ab\x1b[0mde')
    expect(r.st).toBeNull()
  })

  it('두 번째 질의(사용자 프로그램)는 손대지 않는다', () => {
    const r = run(['\x1b[c', 'PS> ', 'vim\x1b[c'])
    expect(r.replies).toBe(1)
    expect(r.out).toEqual(['', 'PS> ', 'vim\x1b[c'])
  })
})
