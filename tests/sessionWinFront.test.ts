// 떼어낸 창은 **앞에 온다** (2026-09-01 → 2026-09-02 준영님 재제보).
//
// ① *"탭을 끌고 다른 쪽으로 이동하면 분리한 창이 제일 위에 보여야 하는데 왜 가장 아래로 가는 거야?"*
// ② *"현재 프로그램 위에 창 분리를 하면 **해당 프로그램 바로 뒤에** 뜨더라고."*
//
// ①에 moveTop() 을 붙였고 ②가 그걸로 부족하다고 말한다. moveTop 은 SetWindowPos(HWND_TOP) —
// **일반 창들의** 맨 위라, 드롭을 받으며 방금 포그라운드가 된 앱보다는 아래다("바로 뒤").
// 그 위로 가려면 topmost 를 한 번 거쳐야 한다: 켰다가 즉시 끄면 HWND_NOTOPMOST 가 창을
// 일반 창들의 맨 위에 **다시** 꽂고, 그때는 그 앱도 포함이다.
//
// 창을 실제로 띄워야 보이는 것은 z-order 자체지만, **그것을 만드는 호출**은 여기서 고정할 수 있다.
// 이 검사가 지키는 회귀 셋:
//  · 순서가 무너지면 → 드롭을 받은 앱 뒤에 그려진다(②).
//  · **setAlwaysOnTop 을 켜 둔 채로 두면** → "항상 위"가 되어 다른 앱을 영영 가린다.
//    (①의 검사는 "setAlwaysOnTop 유입 금지"였다 — 그 처방이 틀려서 뜻을 이렇게 바꾼다.)
//  · show() 가 showInactive() 로 바뀌면 → 하네스 관행(ARA_E2E)이 제품 경로로 샌 것이다.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const calls: string[] = []
  const opened: Record<string, unknown>[] = []
  class FakeWin {
    static last: FakeWin | null = null
    private readonly handlers = new Map<string, () => void>()
    // once 는 로딩 단계 진단(TEMP-DIAG)이 건다 — 가짜 창에도 있어야 openSessionWindow 가 지나간다.
    readonly webContents = { isDestroyed: () => false, isCrashed: () => false, once: (): void => {} }
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

  it('★ topmost 를 한 번 거쳐 보여 준다 — 이게 없으면 드롭을 받은 앱 **바로 뒤**에 그려진다', () => {
    detach('w-front-1')
    expect(h.calls).toEqual(['setAlwaysOnTop(true)', 'show', 'setAlwaysOnTop(false)', 'focus', 'moveTop'])
  })

  it('★ 켜 둔 채로 두지 않는다 — "항상 위"로 남으면 다른 앱을 영영 가린다', () => {
    detach('w-front-2')
    const flags = h.calls.filter((c) => c.startsWith('setAlwaysOnTop'))
    expect(flags.at(-1)).toBe('setAlwaysOnTop(false)') // 마지막 말이 "끈다"여야 한다
    expect(h.opened[0]).not.toHaveProperty('alwaysOnTop') // 창을 처음부터 그렇게 만들지도 않는다
  })

  it('★ 켜고 끄는 사이에 기다리지 않는다 — await 가 끼면 그 틈에 다른 앱이 가려진다', () => {
    detach('w-front-4')
    const on = h.calls.indexOf('setAlwaysOnTop(true)')
    const off = h.calls.indexOf('setAlwaysOnTop(false)')
    // ready-to-show 핸들러 **한 번의 동기 실행** 안에서 둘 다 끝났다(fire 가 돌아온 시점에 이미 꺼져 있다).
    expect(on).toBeGreaterThanOrEqual(0)
    expect(off).toBe(on + 2) // 사이에 있는 것은 show() 하나뿐
  })

  it('숨겨 만들고 첫 페인트 뒤에 보여 준다 — 그 전엔 아무것도 안 보인다(깜빡임 방지)', () => {
    openSessionWindow('w-front-3', '제목', { at: { x: 100, y: 100 }, onClosed: () => {} })
    expect(h.opened[0]).toMatchObject({ show: false })
    expect(h.calls).toEqual([])
  })
})
