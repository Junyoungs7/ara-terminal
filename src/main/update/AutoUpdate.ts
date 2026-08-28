/**
 * 자동 업데이트 (#98) — 사내 파일 서버에 올린 설치본을 받아 두고 **다음 실행 때** 적용한다.
 *
 * 설계 결정 넷:
 *  0. **알리기만 하고 받는 것은 사람이 누른다**(AUDIT-R2 ③, 2026-08-28 준영님 결정).
 *     피드가 평문 HTTP 이고 빌드에 서명이 없어 electron-updater 가 서명 검증을 건너뛴다
 *     (`publisherName == null → return null`). 그 조합에서 무인 내려받기는 "누가 올린 것이든
 *     받아서 설치 대기까지 걸어 두는" 경로가 된다 — 그래서 `autoDownload = false` 로 끊고
 *     `available` 상태를 새로 뒀다. 코드 서명은 0.2.0 과제.
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
  /** `autoDownload = false` 라 받기는 이걸로만 시작된다(설계 결정 0). */
  downloadUpdate(): Promise<unknown>
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
  /** 지금 받는다. 새 버전을 찾아 둔(`available`) 상태에서만 뜻이 있다. */
  download(): void
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

  if (!packaged) return { state: () => state, check: () => {}, download: () => {}, install: () => {} }

  // 받는 것은 사람이 누른다(설계 결정 0) — 적용 시점은 그대로 종료할 때다(설계 결정 1).
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  if (feedUrl) {
    try {
      updater.setFeedURL({ provider: 'generic', url: feedUrl })
    } catch (err) {
      onError('update feedUrl', err)
    }
  }

  /**
   * 실패를 기록하고 상태로 옮긴다.
   *
   * **한 번의 실패가 두 길로 온다** — electron-updater 는 `error` 이벤트를 쏘면서
   * `checkForUpdates()` 의 약속도 거절한다. 예전에는 둘 다 `logMainError` 로 가서 하루 4번 확인마다
   * **스택이 두 벌씩** 쌓였다. VPN 밖 노트북이면 그 그물(ENOTFOUND·ECONNREFUSED)만으로 로그가 차서
   * 정작 진단해야 할 것을 못 찾는다(AUDIT-R2 ⑤). 그래서 둘을 하나로 접고, **스택 말고 사유만** 남긴다
   * — 여기서 나오는 오류는 전부 네트워크 그물이라 스택에 읽을 것이 없다.
   */
  let lastLogged: string | null = null
  const fail = (where: string, err: unknown): void => {
    const message = reason(err)
    if (message !== lastLogged) {
      lastLogged = message
      onError(where, message)
    }
    set({ status: 'error', message })
  }

  updater.on('checking-for-update', () => set({ status: 'checking' }))
  // **받지 않는다 — 찾았다고만 한다**(설계 결정 0). 여기서 곧장 'downloading' 으로 넘기면
  // `autoDownload = false` 인 지금은 진행률이 영영 안 와서 그 상태에 박힌다(= check() 가드와 화면
  // [확인] 버튼이 프로세스 수명 내내 잠긴다). 받기는 download() 가 시작한다.
  updater.on('update-available', (info) => set({ status: 'available', version: version(info) }))
  // 최신이면 idle 로 돌아간다 — "확인했고 받을 게 없다"를 별도 상태로 두지 않는다(화면에 쓸 말이 같다).
  updater.on('update-not-available', () => set({ status: 'idle' }))
  updater.on('download-progress', (p) =>
    set({ status: 'downloading', version: state.version, percent: percentOf(p) })
  )
  updater.on('update-downloaded', (info) => set({ status: 'ready', version: version(info) ?? state.version }))
  updater.on('error', (err) => fail('update', err))

  return {
    state: () => state,
    check: () => {
      // 'available' 은 **넣지 않는다** — 새 버전을 찾아 두고 안 받은 채로도 다시 확인할 수 있어야 한다
      // (그 사이 더 새 버전이 올라올 수 있고, 무엇보다 여기 넣으면 [확인] 버튼이 영영 죽는다).
      if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return
      lastLogged = null // 새 회차 — 같은 사유라도 이번 실패는 다시 적는다
      set({ status: 'checking' })
      // 실패는 'error' 이벤트로도 오지만, 던지는 경로(주소 자체가 잘못된 경우)도 여기서 받는다.
      updater.checkForUpdates().catch((err) => fail('update check', err))
    },
    download: () => {
      if (state.status !== 'available') return
      lastLogged = null // check() 와 같은 규칙 — 새 회차의 실패는 다시 적는다
      // 누른 사람이 반응을 봐야 한다 — 첫 진행률이 오기 전에도 0% 로 알린다.
      set({ status: 'downloading', version: state.version, percent: 0 })
      updater.downloadUpdate().catch((err) => fail('update download', err))
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
