/**
 * 자동 업데이트 (#98) — 사내 파일 서버에 올린 설치본을 조용히 받아 두고 **다음 실행 때** 적용한다.
 *
 * 설계 결정 셋:
 *  1. **받아 두기만 한다.** 쓰던 터미널을 끊고 재시작시키는 앱은 신뢰를 잃는다. 내려받기가 끝나면
 *     상태만 알리고, 적용은 사용자가 [다시 시작]을 누르거나 평소처럼 앱을 껐다 켤 때 일어난다
 *     (`autoInstallOnAppQuit`).
 *  2. **주소는 패키지에 박힌 것(app-update.yml)을 쓰되 `ARA_UPDATE_URL` 로 덮을 수 있다.** 사내
 *     배포 서버가 옮겨 갔다고 앱을 다시 빌드해야 하는 건 말이 안 된다 — 환경변수 한 줄로 돌린다.
 *  3. **개발 중에는 아예 돌지 않는다.** `app.isPackaged` 가 아니면 electron-updater 는 어차피
 *     "dev-app-update.yml 이 없다"로 던진다. 그 예외를 잡아 로그를 더럽히느니 시작을 안 한다.
 *
 * electron-updater 를 직접 import 하지 않고 주입받는다 — 이벤트 배선을 단위 테스트에서 가짜
 * 업데이터로 그대로 돌려 보기 위해서다(tests/autoUpdate.test.ts).
 */
import type { UpdateState } from '../../shared/ipc'

/** electron-updater 의 `autoUpdater` 중 **우리가 쓰는 것만** 추린 모양. */
export type UpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export type AutoUpdateDeps = {
  updater: UpdaterLike
  /** 패키지본인가(app.isPackaged). false 면 상태는 영영 'off'. */
  packaged: boolean
  /** 환경변수 override. 비어 있으면 패키지에 박힌 주소를 쓴다. */
  feedUrl?: string
  emit(state: UpdateState): void
  onError(where: string, err: unknown): void
}

export type AutoUpdateService = {
  state(): UpdateState
  /** 지금 확인한다. 이미 확인·내려받기 중이면 아무 일도 안 한다. */
  check(): void
  /** 받아 둔 버전으로 지금 재시작한다. 준비 안 됐으면 무시. */
  install(): void
}

const version = (info: unknown): string | undefined => {
  const v = (info as { version?: unknown } | null | undefined)?.version
  return typeof v === 'string' ? v : undefined
}

const percentOf = (p: unknown): number => {
  const n = (p as { percent?: unknown } | null | undefined)?.percent
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

const reason = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err ?? '')
  // 사내망 밖에서 흔한 그물(주소를 못 찾음·연결 거부)은 사용자에게 그대로 보여 줘도 뜻이 없다.
  return m.length > 200 ? m.slice(0, 200) + '…' : m
}

export function createAutoUpdate(deps: AutoUpdateDeps): AutoUpdateService {
  const { updater, packaged, feedUrl, emit, onError } = deps
  let state: UpdateState = { status: packaged ? 'idle' : 'off' }

  const set = (next: UpdateState): void => {
    state = next
    emit(next)
  }

  if (!packaged) return { state: () => state, check: () => {}, install: () => {} }

  // 받아만 두고 적용은 종료할 때 — 위 설계 결정 1.
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  if (feedUrl) {
    try {
      updater.setFeedURL({ provider: 'generic', url: feedUrl })
    } catch (err) {
      onError('update feedUrl', err)
    }
  }

  updater.on('checking-for-update', () => set({ status: 'checking' }))
  updater.on('update-available', (info) => set({ status: 'downloading', version: version(info), percent: 0 }))
  // 최신이면 idle 로 돌아간다 — "확인했고 받을 게 없다"를 별도 상태로 두지 않는다(화면에 쓸 말이 같다).
  updater.on('update-not-available', () => set({ status: 'idle' }))
  updater.on('download-progress', (p) =>
    set({ status: 'downloading', version: state.version, percent: percentOf(p) })
  )
  updater.on('update-downloaded', (info) => set({ status: 'ready', version: version(info) ?? state.version }))
  updater.on('error', (err) => {
    onError('update', err)
    set({ status: 'error', message: reason(err) })
  })

  return {
    state: () => state,
    check: () => {
      if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return
      set({ status: 'checking' })
      // 실패는 'error' 이벤트로도 오지만, 던지는 경로(주소 자체가 잘못된 경우)도 여기서 받는다.
      updater.checkForUpdates().catch((err) => {
        onError('update check', err)
        set({ status: 'error', message: reason(err) })
      })
    },
    install: () => {
      if (state.status !== 'ready') return
      try {
        updater.quitAndInstall()
      } catch (err) {
        onError('update install', err)
      }
    }
  }
}
