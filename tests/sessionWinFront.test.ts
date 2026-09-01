// 떼어낸 창은 **앞에 온다** (2026-09-01 준영님 제보).
//
// *"탭을 끌고 다른 쪽으로 이동하면 분리한 창이 제일 위에 보여야 하는데 왜 가장 아래로 가는 거야?"*
//
// 창을 실제로 띄워야 보이는 것은 z-order 자체지만, **그것을 만드는 호출**은 여기서 고정할 수 있다:
// show → focus → moveTop 이 그 순서로 다 불려야 한다. focus() 하나로는 부족했던 이유는
// SessionWindows.ts 의 주석이 근거다 — 윈도우는 포그라운드가 아닌 프로세스의 활성화를 거부하고,
// 탭을 다른 앱 위에 놓는 동작이 정확히 그 조건을 만든다.
//
// 이 검사가 지키는 회귀 셋:
//  · moveTop() 이 빠지면 → 드롭을 받은 앱 뒤에 그려진다(이번 제보).
//  · show() 가 showInactive() 로 바뀌면 → 하네스 관행(ARA_E2E)이 제품 경로로 샌 것이다.
//  · setAlwaysOnTop 이 켜지면 → "항상 위"가 되어 다른 앱을 계속 가린다(원하는 건 만들 때 한 번).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const opened: Record<string, unknown>[] = []
  class FakeWin {
    static last: FakeWin | null = null
    private readonly handlers = new Map<string, () => void>()
    readonly webContents = { isDestroyed: () => false, isCrashed: () => false }
    constructor(opts: Record<string, unknown>) {
      opened.push(opts)
      FakeWin.last = this
    }
    removeMenu(): void {}
    on(ev: string, fn: () => void): void {
      this.handlers.set(ev, fn)
    }
    once(ev: string, fn: () => void): void {
      this.handlers.set(ev, fn)
    }
    /** 검사가 직접 돌리는 스위치 — Electron 이 첫 페인트 뒤에 부르는 그 자리다. */
    fire(ev: string): void {
      this.handlers.get(ev)?.()
    }
    show(): void {
      calls.push('show')
    }
    showInactive(): void {
      calls.push('showInactive')
    }
    focus(): void {
      calls.push('focus')
    }
    moveTop(): void {
      calls.push('moveTop')
    }
    setAlwaysOnTop(on: boolean): void {
      calls.push(`setAlwaysOnTop(${on})`)
    }
    loadURL(): void {}
    loadFile(): void {}
    isDestroyed(): boolean {
      return false
    }
    isMinimized(): boolean {
      return false
    }
  }
  return { calls, opened, FakeWin }
})

vi.mock('electron', () => ({
  BrowserWindow: h.FakeWin,
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }
}))

const { openSessionWindow } = await import('../src/main/windows/SessionWindows')

/** 창 하나를 열고 첫 페인트까지 흉내낸다. winId 는 매번 달라야 한다(모듈이 창을 기억한다). */
function detach(winId: string): void {
  openSessionWindow(winId, '제목', { at: { x: 800, y: 400 }, onClosed: () => {} })
  h.FakeWin.last?.fire('ready-to-show')
}

describe('떼어낸 창을 앞으로', () => {
  beforeEach(() => {
    h.calls.length = 0
    h.opened.length = 0
  })

  it('★ show → focus → moveTop — moveTop 이 없으면 드롭을 받은 앱 뒤에 그려진다', () => {
    detach('w-front-1')
    expect(h.calls).toEqual(['show', 'focus', 'moveTop'])
  })

  it('★ 항상 위로 만들지 않는다 — 만들 때 한 번 앞으로지, 남의 앱을 계속 가리는 것이 아니다', () => {
    detach('w-front-2')
    expect(h.calls.some((c) => c.startsWith('setAlwaysOnTop'))).toBe(false)
    expect(h.opened[0]).not.toHaveProperty('alwaysOnTop')
  })

  it('숨겨 만들고 첫 페인트 뒤에 보여 준다 — 그 전엔 아무것도 안 보인다(깜빡임 방지)', () => {
    openSessionWindow('w-front-3', '제목', { at: { x: 100, y: 100 }, onClosed: () => {} })
    expect(h.opened[0]).toMatchObject({ show: false })
    expect(h.calls).toEqual([])
  })
})
