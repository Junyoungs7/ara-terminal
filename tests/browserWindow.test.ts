/**
 * 내장 브라우저 창은 본창에 딸리지 않은 독립 창이다(2026-10-28 준영님 요청 — "탐색기처럼").
 *
 * parent 가 붙으면 Windows 에서 늘 본창 위에 떠 있고 본창 최소화 때 같이 숨는다. 그 대신
 * 본창 닫힘·앱 종료 때는 closeBrowserWindow 로 명시적으로 닫는다(index.ts) — 그 함수가 실제로
 * 창을 없애고 탭을 비우는지를 여기서 본다.
 */
import { describe, it, expect, vi } from 'vitest'

const { FakeWin, FakeView, created } = vi.hoisted(() => {
  const mkWc = () => ({
    send: vi.fn(),
    isDestroyed: () => false,
    isLoading: () => false,
    loadURL: () => Promise.resolve(),
    close: vi.fn(),
    on: () => {}
  })
  const created: InstanceType<typeof FakeWin>[] = []
  class FakeWin {
    webContents = mkWc()
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    opts: Record<string, unknown>
    dead = false
    closed?: () => void
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      created.push(this)
    }
    isDestroyed = () => this.dead
    isMinimized = () => false
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    removeMenu = () => {}
    getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
    on(ev: string, fn: () => void) {
      if (ev === 'closed') this.closed = fn
    }
    once() {}
    loadURL = () => Promise.resolve()
    loadFile = () => Promise.resolve()
    destroy = () => {
      this.dead = true
      this.closed?.()
    }
    close = this.destroy
  }
  class FakeView {
    webContents = mkWc()
    setVisible = vi.fn()
    setBounds = vi.fn()
  }
  return { FakeWin, FakeView, created }
})

vi.mock('electron', () => ({ BrowserWindow: FakeWin, WebContentsView: FakeView }))
vi.mock('../src/main/browser/BrowserService', () => ({
  BROWSER_PARTITION: 'persist:test',
  BROWSER_TITLE: 'test',
  hardenSession: () => ({}),
  wireTabContents: () => {}
}))

import { openTab, closeBrowserWindow, browserWindowForTest } from '../src/main/browser/BrowserTabs'

describe('내장 브라우저 창 — 본창과 독립', () => {
  it('parent 를 달지 않는다(본창이 있어도)', () => {
    const main = new FakeWin({})
    expect(openTab('http://localhost:3000/', () => main as never)).toBe(true)
    const w = created[created.length - 1]
    expect(w).not.toBe(main)
    expect('parent' in w.opts).toBe(false)
    expect('modal' in w.opts).toBe(false)
    closeBrowserWindow()
  })

  it('closeBrowserWindow 는 창을 없애고 탭을 비운다(본창 닫힘·앱 종료 길)', () => {
    openTab('http://localhost:3000/', () => null)
    const w = browserWindowForTest().win as unknown as InstanceType<typeof FakeWin>
    expect(w).not.toBeNull()
    closeBrowserWindow()
    expect(w.dead).toBe(true)
    expect(browserWindowForTest()).toEqual({ win: null, tab: null })
    // 다시 열면 새 창이다.
    openTab('http://localhost:3000/', () => null)
    expect(browserWindowForTest().win).not.toBe(w)
    closeBrowserWindow()
  })
})
