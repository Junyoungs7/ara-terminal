// 시험 훅 — 지정 영역의 경계 안 자식이 다음 렌더에서 던지게 한다(ErrorBoundary 시험용).
// 배포본에서는 설치되지 않는다: main 이 `!app.isPackaged && ARA_E2E=1` 일 때만 `--ara-test-hooks` 를 넘기고
// preload 가 그것을 `ev.app.testHooks` 로 건넨다. React 를 import 하지 않아 node vitest 가 읽는다.
const armed = new Set<string>()
const listeners = new Map<string, Set<() => void>>()

export const shouldCrash = (area: string): boolean => armed.has(area)

export const subscribeCrash = (area: string, fn: () => void): (() => void) => {
  const set = listeners.get(area) ?? new Set<() => void>()
  set.add(fn)
  listeners.set(area, set)
  return () => void set.delete(fn)
}

export const crashArea = (area: string): void => {
  armed.add(area)
  listeners.get(area)?.forEach((fn) => fn())
}

/** 다시 시도가 같은 원인으로 또 잡히지 않게 — 시험이 필요하면 부른다. */
export const disarmCrash = (area: string): void => void armed.delete(area)

export function installTestCrash(enabled: boolean | undefined, win: object = window): void {
  if (enabled) (win as { __araTestCrash?: (a: string) => void }).__araTestCrash = crashArea
}
