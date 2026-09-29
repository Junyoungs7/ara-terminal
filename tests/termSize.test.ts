// 🔴 쓸 수 없는 터미널 치수(9×4 등)가 저장되거나 복원되지 않는다 — 2026-09-28 #2 오류 신고.
//
// 준영님 스냅샷에 세션 둘이 9×4 로 저장돼 있었고, 다음 부팅에 그 치수로 pty 를 열어
// `PS D:\AI\deadeye>` 가 `PS D:\AI\` 에서 접혔다. 1.0.11 의 "끌 때 치수로 복원"이 리사이즈마다
// 기록하는데, 창이 작아진 한순간의 값까지 담았다.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { usableSize } from '../src/shared/termSize'
import { MainSessionManager } from '../src/main/sessions/MainSessionManager'
import type { SessionBackend } from '../src/main/sessions/SessionBackend'

describe('usableSize', () => {
  it('제보의 9×4 는 쓸 수 없다', () => expect(usableSize(9, 4)).toBe(false))
  it('평범한 치수는 쓴다', () => expect(usableSize(139, 18)).toBe(true))
  it('문턱 바로 위아래', () => {
    expect(usableSize(20, 5)).toBe(true)
    expect(usableSize(19, 5)).toBe(false)
    expect(usableSize(20, 4)).toBe(false)
  })
  it('없거나 이상한 값', () => {
    expect(usableSize(undefined, undefined)).toBe(false)
    expect(usableSize(80.5, 24)).toBe(false)
    expect(usableSize(99999, 24)).toBe(false)
  })
})

describe('🔴 main 은 쓸 수 없는 리사이즈를 pty 에도 저장값에도 안 넘긴다', () => {
  function rig() {
    const sent: [number, number][] = []
    const mgr = new MainSessionManager({ data() {}, exit() {}, cwd() {} })
    const backend: SessionBackend = {
      write() {},
      resize(c: number, r: number) {
        sent.push([c, r])
      },
      pause() {},
      resume() {},
      kill() {},
      onData() {},
      onExit() {}
    }
    mgr.adopt(backend, { type: 'ssh', title: 't', serverKey: 's', profileId: 'p', cwd: undefined, shell: undefined }, 'a')
    return { mgr, sent, meta: () => mgr.snapshot()[0] }
  }

  it('9×4 는 무시된다 — 앞의 제 치수가 그대로 남는다', () => {
    const { mgr, sent, meta } = rig()
    mgr.resize('a', 139, 18)
    mgr.resize('a', 9, 4) // ← 창이 작아진 한순간
    expect(sent).toEqual([[139, 18]])
    expect([meta().cols, meta().rows]).toEqual([139, 18])
  })

  it('양성 대조 — 제 치수는 그대로 넘어간다', () => {
    const { mgr, sent } = rig()
    mgr.resize('a', 120, 30)
    expect(sent).toEqual([[120, 30]])
  })
})

describe('복원이 저장값을 거른다 — 옛 스냅샷에 이미 9×4 가 있다', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/components/MainArea.tsx'), 'utf8')
  it('로컬·SSH 복원 둘 다 usableSize 를 지난다', () => {
    expect(src.match(/usableSize\(item\.session\.cols, item\.session\.rows\)/g)?.length).toBe(2)
  })
  it('옛 판정(`cols && rows`)이 남아 있지 않다', () => {
    expect(src).not.toMatch(/item\.session\.cols && item\.session\.rows/)
  })
})

describe('🔴 화면(xterm)도 쓸 수 없는 크기로는 맞추지 않는다 — 오류 신고 #4', () => {
  // 탐색기 `아라` 로 연 셸이 칸이 정해지기 전에 마운트되어 xterm 이 9칸으로 맞춰졌고, 윈도우 로컬은
  // 줄을 다시 접지 않아 프롬프트가 9칸에서 접힌 채 남았다. main 은 거르지만 xterm 은 따로 막아야 한다.
  const pane = readFileSync(join(__dirname, '..', 'src/renderer/terminal/TerminalPane.tsx'), 'utf8')
  it('fit() 을 부르는 자리가 전부 usableSize 판정 뒤에 있다', () => {
    const bare = pane.split('\n').filter((l) => /\bfit(Ref\.current)?\.fit\(\)/.test(l) && !/canFit\(\)|usableSize\(/.test(l))
    expect(bare).toEqual([])
  })
})
