/**
 * 탐색기 독립 창의 중계(2026-10-28 준영님 제보 — "탐색기가 별도의 창으로 떠야하는데 아라 툴 내부에서만 떠").
 *
 * main 은 **중계만** 한다: 본창(Shell)이 사본을 밀고(explorer:state), 탐색기 창이 일을 올린다
 * (explorer:act). 여기서 지키는 것은 그 길이 엉뚱한 창에서 오거나 엉뚱한 창으로 가지 않는 것 —
 * 그게 틀리면 화면은 멀쩡해 보이는데 [연결]이 아무 데도 안 가거나 목록이 다른 창 것으로 바뀐다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock 은 import 보다 먼저 끌어올려진다 — 그 안에서 쓰는 가짜 창은 vi.hoisted 로 같이 올린다.
const { FakeWin, handlers, created, mkWc } = vi.hoisted(() => {
  const mkWc = () => ({ send: vi.fn(), isDestroyed: () => false })
  const handlers = new Map<string, (e: unknown, req: unknown) => unknown>()
  const created: InstanceType<typeof FakeWin>[] = []
  class FakeWin {
    webContents = mkWc()
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
  return { FakeWin, handlers, created, mkWc }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, req: unknown) => unknown) => handlers.set(ch, fn) },
  app: { getPath: () => require('node:os').tmpdir() },
  BrowserWindow: Object.assign(FakeWin, { fromWebContents: () => null }),
  clipboard: {},
  shell: {}
}))

import { registerWindowIpc } from '../src/main/ipc/registerWindowIpc'
import { closeExplorerWindow } from '../src/main/windows/ExplorerWindow'
import { EXPLORER_WIN_HASH, isExplorerWinHash } from '../src/shared/explorerWin'

const main = new FakeWin({})
const call = (ch: string, sender: unknown, req: unknown = {}) => handlers.get(ch)!({ sender }, req)
const explorer = () => created[created.length - 1]

beforeEach(() => {
  closeExplorerWindow()
  main.webContents.send.mockClear()
  main.focus.mockClear()
})

registerWindowIpc(() => main as never)

describe('탐색기 창 중계', () => {
  it('★ 진짜 OS 창이다 — 프레임리스(2.0 타이틀바)로 만들고 해시로 진입한다', async () => {
    await call('explorer:open', main.webContents)
    expect(explorer()).not.toBe(main)
    expect(explorer().opts.frame).toBe(false)
    expect(isExplorerWinHash(EXPLORER_WIN_HASH)).toBe(true)
    // 본창 레일에 "열렸다"가 간다
    expect(main.webContents.send).toHaveBeenCalledWith('explorer:shown', { open: true })
  })

  it('★ 두 번 열면 새 창이 아니라 있는 창을 앞으로', async () => {
    await call('explorer:open', main.webContents)
    const n = created.length
    await call('explorer:open', main.webContents)
    expect(created.length).toBe(n)
    expect(explorer().focus).toHaveBeenCalled()
  })

  it('★ 본창이 민 사본만 탐색기로 간다 — 다른 창(세션 창)이 보낸 것은 버린다', async () => {
    await call('explorer:open', main.webContents)
    const st = { sessions: [], profiles: [], workProfiles: [{ id: 'w', name: 'n', profileId: null, path: '/' }] }
    await call('explorer:state', mkWc(), st)
    expect(explorer().webContents.send).not.toHaveBeenCalledWith('explorer:state', st)
    await call('explorer:state', main.webContents, st)
    expect(explorer().webContents.send).toHaveBeenCalledWith('explorer:state', st)
    // 늦게 뜬 창도 hello 로 같은 사본을 받는다
    expect(await call('explorer:hello', explorer().webContents)).toMatchObject({ state: st })
  })

  it('★ 탐색기의 [연결]은 본창에 도착하고 본창을 앞으로 가져온다(접속 확인이 뒤에 숨지 않게)', async () => {
    await call('explorer:open', main.webContents)
    const act = { kind: 'connect', profileId: 'p1' }
    await call('explorer:act', explorer().webContents, act)
    expect(main.webContents.send).toHaveBeenCalledWith('explorer:act', act)
    expect(main.focus).toHaveBeenCalled()
  })

  it('컨테이너 접속 한 줄(sendInput)은 본창을 앞으로 끌지 않는다', async () => {
    await call('explorer:open', main.webContents)
    await call('explorer:act', explorer().webContents, { kind: 'sendInput', text: 'x' })
    expect(main.webContents.send).toHaveBeenCalledWith('explorer:act', { kind: 'sendInput', text: 'x' })
    expect(main.focus).not.toHaveBeenCalled()
  })

  it('탐색기 창이 아닌 곳에서 온 act 는 버린다', async () => {
    await call('explorer:open', main.webContents)
    await call('explorer:act', mkWc(), { kind: 'connect', profileId: 'p1' })
    expect(main.webContents.send).not.toHaveBeenCalledWith('explorer:act', expect.anything())
  })

  it('★ [탐색기로 열기]의 폴더는 떠 있는 창에 바로, 새 창에는 hello 로 간다', async () => {
    await call('explorer:open', main.webContents, { reveal: { profileId: 'p1', path: '/var/log' } })
    const r = (await call('explorer:hello', explorer().webContents)) as { reveal: { path: string; at: number } }
    expect(r.reveal).toMatchObject({ profileId: 'p1', path: '/var/log' })
    await call('explorer:open', main.webContents, { reveal: { profileId: 'p1', path: '/etc' } })
    expect(explorer().webContents.send).toHaveBeenCalledWith(
      'explorer:reveal',
      expect.objectContaining({ profileId: 'p1', path: '/etc' })
    )
  })

  it('닫으면 본창 레일에 "닫혔다"가 간다', async () => {
    await call('explorer:open', main.webContents)
    main.webContents.send.mockClear()
    closeExplorerWindow()
    expect(main.webContents.send).toHaveBeenCalledWith('explorer:shown', { open: false })
  })
})
