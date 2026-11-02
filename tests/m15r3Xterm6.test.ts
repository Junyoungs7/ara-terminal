// M15 R3 xterm 6 — windowsMode 가 없어졌다. 로컬 Windows 셸(TerminalPane CONPTY_NO_REFLOW)은
// windowsPty 빌드번호 < 21376 으로 리플로우를 끈다. xterm 이 그 게이트를 바꾸면 여기서 깨진다(headless 도 같은 Buffer).
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/headless'

async function rowsAfterShrink(windowsPty?: { backend: 'conpty'; buildNumber?: number }): Promise<string[]> {
  const t = new Terminal({ cols: 20, rows: 5, allowProposedApi: true, ...(windowsPty ? { windowsPty } : {}) })
  await new Promise<void>((r) => t.write('ABCDEFGHIJKLMNOPQRST\r\n', r))
  t.resize(10, 5)
  const b = t.buffer.active
  const out: string[] = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  t.dispose()
  return out
}

describe('xterm 6 windowsPty 리플로우 게이트', () => {
  it('빌드번호 1(아라 로컬 셸) — 좁혀도 줄을 다시 접지 않는다(옛 windowsMode 와 같다)', async () => {
    const rows = await rowsAfterShrink({ backend: 'conpty', buildNumber: 1 })
    // 줄은 접히지 않고 둘째 줄이 비어 있다(셀은 버퍼에 남아 있어 첫 줄 문자열은 그대로다).
    expect(rows.slice(0, 2)).toEqual(['ABCDEFGHIJKLMNOPQRST', ''])
  })
  it('실제 빌드번호(26200, Orca 방식) — 리플로우가 켜져 줄이 접힌다', async () => {
    const rows = await rowsAfterShrink({ backend: 'conpty', buildNumber: 26200 })
    expect(rows.slice(0, 2)).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST'])
  })
  it('windowsPty 없음(SSH) — 리플로우가 켜진다', async () => {
    const rows = await rowsAfterShrink()
    expect(rows.slice(0, 2)).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST'])
  })
})
