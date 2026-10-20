// #98 자동 업데이트 — electron-updater 를 가짜로 세워 **이벤트 배선과 상태 전이**를 본다.
// 실제 네트워크·설치는 여기서 볼 수 없다(그건 RELEASE-TEST 대본의 몫). 여기서 지키는 것은
// "받아 두기만 하고 재시작은 사용자가 정한다"와 "개발 모드에서는 아예 안 돈다" 둘이다.
import { describe, it, expect, vi } from 'vitest'
import { createAutoUpdate, type UpdaterLike } from '../src/main/update/AutoUpdate'
import type { UpdateState } from '../src/shared/ipc'

type Fake = UpdaterLike & {
  fire(event: string, arg?: unknown): void
  feed: string | null
  downloadUpdate: ReturnType<typeof vi.fn>
}

function fakeUpdater(
  checkResult: Promise<unknown> = Promise.resolve({}),
  downloadResult: Promise<unknown> = Promise.resolve({})
): Fake {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    // 서비스가 **직접 정하는** 값이라 시작값은 반대로 둔다 — 안 건드리면 그 자체로 드러난다.
    autoDownload: true,
    autoInstallOnAppQuit: false,
    feed: null,
    setFeedURL(o) {
      ;(this as Fake).feed = o.url
    },
    checkForUpdates: () => checkResult,
    downloadUpdate: vi.fn(() => downloadResult),
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

function setup(
  opts: { packaged?: boolean; feedUrl?: string; check?: Promise<unknown>; download?: Promise<unknown> } = {}
) {
  const updater = fakeUpdater(opts.check, opts.download)
  const seen: UpdateState[] = []
  const errors: string[] = []
  // 로그로 **무엇을** 넘겼는지도 본다 — update 범위는 스택이 아니라 사유만 남긴다(AUDIT-R2 ⑤).
  const logged: unknown[] = []
  const svc = createAutoUpdate({
    updater,
    packaged: opts.packaged ?? true,
    feedUrl: opts.feedUrl,
    emit: (s) => seen.push(s),
    onError: (where, err) => {
      errors.push(where)
      logged.push(err)
    }
  })
  return { updater, seen, errors, logged, svc }
}

describe('개발 모드', () => {
  it('★ 패키지본이 아니면 아무것도 걸지 않는다', () => {
    const { updater, svc, seen } = setup({ packaged: false, feedUrl: 'http://x.local/d/' })
    svc.check()
    svc.download()
    svc.install()
    expect(svc.state()).toEqual({ status: 'off' })
    expect(seen).toEqual([]) // 알릴 것도 없다
    expect(updater.feed).toBeNull() // 피드도 안 건다
    expect(updater.autoDownload).toBe(true) // 가짜의 시작값 그대로 = 설정을 안 건드렸다
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })
})

describe('설정', () => {
  it('피드 주소를 주면 generic 으로 건다', () => {
    const { updater } = setup({ feedUrl: 'http://ara.local/downloads/' })
    expect(updater.feed).toBe('http://ara.local/downloads/')
  })

  /**
   * ★ AUDIT-R2 ③(2026-08-28 준영님 결정): **받는 것은 사람이 누른다.**
   * 평문 HTTP 피드 + 무서명 빌드라 electron-updater 가 서명 검증을 건너뛴다 — 무인 내려받기 경로를
   * 없앤다. 적용 시점 정책(종료할 때)은 그대로다.
   */
  it('★ 자동으로 받지 않는다 · 적용은 종료할 때 — 이 조합이 이 기능의 약속이다', () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })
})

describe('상태 전이', () => {
  it('확인 → 새 버전 찾음 → (사람이 [받기]) → 진행률 → 준비', () => {
    const { updater, svc, seen } = setup()
    updater.fire('checking-for-update')
    updater.fire('update-available', { version: '0.2.0' })
    // 여기서 멈춘다 — 누르기 전에는 아무것도 안 받는다.
    expect(svc.state()).toEqual({ status: 'available', version: '0.2.0' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    svc.download()
    updater.fire('download-progress', { percent: 42.6 })
    updater.fire('update-downloaded', { version: '0.2.0' })
    expect(seen.map((s) => s.status)).toEqual([
      'checking',
      'available',
      'downloading', // download() 가 즉시 알린다(0%) — 누른 사람이 반응을 봐야 한다
      'downloading',
      'ready'
    ])
    expect(seen[3]).toMatchObject({ percent: 43, version: '0.2.0' }) // 반올림 + 버전 유지
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
    svc.download()
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

  /**
   * ★ AUDIT-R2 ⑤ — 한 번의 실패가 두 길로 온다(`error` 이벤트 + `checkForUpdates()` 거절).
   * 예전엔 둘 다 스택째 남아 VPN 밖 노트북에서 하루 4번 × 2벌이 쌓였다. 상한이 1MB 라 디스크가
   * 위험한 건 아니지만, **정작 진단할 때 로그가 그물로 덮여 쓸모없어진다.**
   */
  it('★ 같은 실패를 두 번 적지 않는다 · 스택이 아니라 사유만 남긴다', async () => {
    const err = new Error('getaddrinfo ENOTFOUND ara.local')
    const { updater, svc, errors, logged } = setup({ check: Promise.reject(err) })
    svc.check()
    updater.fire('error', err) // electron-updater 는 이벤트를 쏘면서 약속도 거절한다
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['update']) // 두 벌이 아니다
    expect(logged).toEqual(['getaddrinfo ENOTFOUND ara.local']) // Error 객체(=스택)가 아니다
    expect(svc.state().status).toBe('error')

    // 그렇다고 "또 났다"를 지우지는 않는다 — 다음 확인 회차의 같은 실패는 다시 적는다.
    svc.check()
    updater.fire('error', err)
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toEqual(['update', 'update'])
  })
})

describe('사용자 조작', () => {
  it('★ 이미 받는 중이면 확인을 다시 시작하지 않는다', () => {
    const { updater, svc, seen } = setup()
    updater.fire('update-available', { version: '0.2.0' })
    svc.download()
    const before = seen.length
    svc.check()
    expect(seen.length).toBe(before) // 상태가 안 바뀐다 = 아무 일도 안 했다
    expect(svc.state().status).toBe('downloading')
  })

  /**
   * ★★ 이번 라운드의 본체다(AUDIT-R2 ③).
   *
   * `autoDownload = false` 만 두고 `update-available` 을 그대로 'downloading' 으로 보내면
   * 진행률이 영영 오지 않아 그 상태에 **박힌다**. 그러면 `check()` 의 가드가 매번 즉시 반환해
   * 6시간 주기 확인이 프로세스 수명 내내 무효가 되고, 설정의 [확인] 버튼도 같은 조건(busy)이라
   * 영구 비활성이 된다. 재시작해도 20초 뒤 다시 박힌다 — 업데이트가 통째로 죽는 길이다.
   */
  it('★★ 새 버전을 찾아 둔 채로도 다시 확인할 수 있다 — available 은 가드가 아니다', () => {
    const { updater, svc, seen } = setup()
    updater.fire('update-available', { version: '0.2.0' })
    expect(svc.state().status).toBe('available')
    const before = seen.length
    svc.check()
    expect(svc.state().status).toBe('checking') // 무효화되지 않았다
    expect(seen.length).toBe(before + 1)
    // 그리고 그 확인이 "최신"으로 끝나면 available 은 깨끗이 걷힌다.
    updater.fire('update-not-available', {})
    expect(svc.state()).toEqual({ status: 'idle' })
  })

  it('★ 받아 둔 채로도 다시 확인해 더 새 버전을 받는다 — ready 는 가드가 아니다', () => {
    const { updater, svc } = setup()
    updater.fire('update-downloaded', { version: '1.0.27' })
    svc.check()
    expect(svc.state().status).toBe('checking')
    // 최신이거나 실패하면 받아 둔 것으로 돌아간다([다시 시작]이 사라지지 않는다)
    updater.fire('update-not-available', {})
    expect(svc.state()).toEqual({ status: 'ready', version: '1.0.27' })
    svc.check()
    updater.fire('error', new Error('ECONNREFUSED'))
    expect(svc.state()).toEqual({ status: 'ready', version: '1.0.27' })
    // 더 새 버전이 있으면 받는다
    svc.check()
    updater.fire('update-available', { version: '1.0.28' })
    svc.download()
    updater.fire('update-downloaded', { version: '1.0.28' })
    expect(svc.state()).toEqual({ status: 'ready', version: '1.0.28' })
  })

  it('★ [받기]는 새 버전을 찾아 둔 상태에서만 받는다', () => {
    const { updater, svc } = setup()
    svc.download() // idle
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    updater.fire('update-downloaded', { version: '0.2.0' }) // ready
    svc.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    updater.fire('update-available', { version: '0.3.0' })
    svc.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(svc.state()).toMatchObject({ status: 'downloading', version: '0.3.0', percent: 0 })
  })

  it('받기가 던지면 오류 상태가 된다', async () => {
    const { updater, svc, errors } = setup({ download: Promise.reject(new Error('디스크가 가득 찼습니다')) })
    updater.fire('update-available', { version: '0.2.0' })
    svc.download()
    await new Promise((r) => setTimeout(r, 0))
    expect(svc.state()).toMatchObject({ status: 'error', message: '디스크가 가득 찼습니다' })
    expect(errors).toContain('update download')
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

  it('★ 설치 창을 띄우지 않고, 끝나면 다시 켠다 — (isSilent, isForceRunAfter) 둘 다 true', () => {
    // 인자를 **안 주면** electron-updater 의 기본값이 `false` 라 NSIS 창이 화면에 뜬다.
    // 그 기본값으로 돌아가는 회귀를 여기서 잡는다(2026-09-10 준영님 제보).
    const { updater, svc } = setup()
    updater.fire('update-downloaded', { version: '0.2.0' })
    svc.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})
