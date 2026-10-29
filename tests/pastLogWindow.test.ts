/**
 * 지난 세션 로그 독립 창(2026-10-29 준영님 요청 — 사이드바엔 목록만, 내용은 창으로).
 * 지키는 것: 창은 하나 — 두 번 열면 새 창이 아니라 있는 창에 대상만 바뀐다(pastlog:show).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { FakeWin, handlers, created } = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, req: unknown) => unknown>()
  const created: InstanceType<typeof FakeWin>[] = []
  class FakeWin {
    webContents = { send: vi.fn(), isDestroyed: () => false }
    opts: Record<string, unknown>
    closed?: () => void
    focus = vi.fn()
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      created.push(this)
    }
    isDestroyed = () => false
    isMinimized = () => false
    restore = vi.fn()
    removeMenu = () => {}
    on(ev: string, fn: () => void) {
      if (ev === 'closed') this.closed = fn
    }
    once() {}
    loadURL = () => Promise.resolve()
    loadFile = () => Promise.resolve()
    destroy = () => this.closed?.()
  }
  return { FakeWin, handlers, created }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, req: unknown) => unknown) => handlers.set(ch, fn) },
  app: { getPath: () => require('node:os').tmpdir() },
  BrowserWindow: Object.assign(FakeWin, { fromWebContents: () => null }),
  clipboard: {},
  shell: {}
}))

import { registerWindowIpc } from '../src/main/ipc/registerWindowIpc'
import { closePastLogWindow } from '../src/main/windows/PastLogWindow'

const main = new FakeWin({})
const call = (ch: string, req: unknown = {}) => handlers.get(ch)!({ sender: main.webContents }, req)
registerWindowIpc(() => main as never)

beforeEach(() => closePastLogWindow())

describe('지난 세션 로그 창', () => {
  it('★ 두 번 열면 창은 하나 — 있는 창에 새 대상을 밀고 앞으로', async () => {
    const a = { file: 'a.log', serverKey: 'web1', startedAt: 1 }
    const b = { file: 'b.log', serverKey: 'db1', startedAt: 2 }
    const n = created.length
    await call('pastlog:open', a)
    expect(created.length).toBe(n + 1)
    const w = created[created.length - 1]
    expect(w.opts.frame).toBe(false)
    expect(await call('pastlog:hello')).toEqual(a)

    await call('pastlog:open', b)
    expect(created.length).toBe(n + 1)
    expect(w.webContents.send).toHaveBeenCalledWith('pastlog:show', b)
    expect(w.focus).toHaveBeenCalled()
    expect(await call('pastlog:hello')).toEqual(b)
  })

  it('모양이 틀린 요청은 창을 만들지 않는다', async () => {
    const n = created.length
    expect(await call('pastlog:open', { file: 1 })).toEqual({ ok: false })
    expect(created.length).toBe(n)
  })
})
