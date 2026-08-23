// #98 자동 업데이트 — electron-updater 를 가짜로 세워 **이벤트 배선과 상태 전이**를 본다.
// 실제 네트워크·설치는 여기서 볼 수 없다(그건 RELEASE-TEST 대본의 몫). 여기서 지키는 것은
// "받아 두기만 하고 재시작은 사용자가 정한다"와 "개발 모드에서는 아예 안 돈다" 둘이다.
import { describe, it, expect, vi } from 'vitest'
import { createAutoUpdate, type UpdaterLike } from '../src/main/update/AutoUpdate'
import type { UpdateState } from '../src/shared/ipc'

type Fake = UpdaterLike & { fire(event: string, arg?: unknown): void; feed: string | null }

function fakeUpdater(checkResult: Promise<unknown> = Promise.resolve({})): Fake {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    feed: null,
    setFeedURL(o) {
      ;(this as Fake).feed = o.url
    },
    checkForUpdates: () => checkResult,
    quitAndInstall: vi.fn(),
    on(event, listener) {
      handlers.set(event, listener as (...a: unknown[]) => void)
      return this
    },
    fire(event, arg) {
      handlers.get(event)?.(arg)
    }
  }
}

function setup(opts: { packaged?: boolean; feedUrl?: string; check?: Promise<unknown> } = {}) {
  const updater = fakeUpdater(opts.check)
  const seen: UpdateState[] = []
  const errors: string[] = []
  const svc = createAutoUpdate({
    updater,
    packaged: opts.packaged ?? true,
    feedUrl: opts.feedUrl,
    emit: (s) => seen.push(s),
    onError: (where) => errors.push(where)
  })
  return { updater, seen, errors, svc }
}

describe('개발 모드', () => {
  it('★ 패키지본이 아니면 아무것도 걸지 않는다', () => {
    const { updater, svc, seen } = setup({ packaged: false, feedUrl: 'http://x.local/d/' })
    svc.check()
    svc.install()
    expect(svc.state()).toEqual({ status: 'off' })
    expect(seen).toEqual([]) // 알릴 것도 없다
    expect(updater.feed).toBeNull() // 피드도 안 건다
    expect(updater.autoDownload).toBe(false) // 설정도 안 건드린다
  })
})

describe('설정', () => {
  it('피드 주소를 주면 generic 으로 건다', () => {
    const { updater } = setup({ feedUrl: 'http://ara.local/downloads/' })
    expect(updater.feed).toBe('http://ara.local/downloads/')
  })

  it('★ 받아 두기만 하고 적용은 종료할 때 — 이 조합이 이 기능의 약속이다', () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })
})

describe('상태 전이', () => {
  it('확인 → 새 버전 → 진행률 → 준비', () => {
    const { updater, svc, seen } = setup()
    updater.fire('checking-for-update')
    updater.fire('update-available', { version: '0.2.0' })
    updater.fire('download-progress', { percent: 42.6 })
    updater.fire('update-downloaded', { version: '0.2.0' })
    expect(seen.map((s) => s.status)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(seen[2]).toMatchObject({ percent: 43, version: '0.2.0' }) // 반올림 + 버전 유지
    expect(svc.state()).toEqual({ status: 'ready', version: '0.2.0' })
  })

  it('최신이면 idle 로 돌아간다', () => {
    const { updater, svc } = setup()
    updater.fire('checking-for-update')
    updater.fire('update-not-available', { version: '0.1.0' })
    expect(svc.state()).toEqual({ status: 'idle' })
  })

  it('진행률이 이상해도 0~100 을 벗어나지 않는다', () => {
    const { updater, svc } = setup()
    updater.fire('update-available', { version: '0.2.0' })
    updater.fire('download-progress', { percent: 240 })
    expect(svc.state().percent).toBe(100)
    updater.fire('download-progress', { percent: Number.NaN })
    expect(svc.state().percent).toBe(0)
  })

  it('오류는 사유를 남기고 로그로도 간다', () => {
    const { updater, svc, errors } = setup()
    updater.fire('error', new Error('getaddrinfo ENOTFOUND ara.local'))
    expect(svc.state().status).toBe('error')
    expect(svc.state().message).toContain('ENOTFOUND')
    expect(errors).toContain('update')
  })

  it('긴 오류 문구는 잘라서 보여 준다', () => {
    const { updater, svc } = setup()
    updater.fire('error', new Error('x'.repeat(500)))
    expect((svc.state().message ?? '').length).toBeLessThanOrEqual(201)
  })
})

describe('사용자 조작', () => {
  it('★ 이미 받는 중이면 확인을 다시 시작하지 않는다', () => {
    const { updater, svc, seen } = setup()
    updater.fire('update-available', { version: '0.2.0' })
    const before = seen.length
    svc.check()
    expect(seen.length).toBe(before) // 상태가 안 바뀐다 = 아무 일도 안 했다
    expect(svc.state().status).toBe('downloading')
  })

  it('확인이 던지면 오류 상태가 된다', async () => {
    const { svc, errors } = setup({ check: Promise.reject(new Error('bad url')) })
    svc.check()
    await new Promise((r) => setTimeout(r, 0))
    expect(svc.state()).toMatchObject({ status: 'error', message: 'bad url' })
    expect(errors).toContain('update check')
  })

  it('★ 준비되기 전에는 재시작하지 않는다', () => {
    const { updater, svc } = setup()
    svc.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.fire('update-downloaded', { version: '0.2.0' })
    svc.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
