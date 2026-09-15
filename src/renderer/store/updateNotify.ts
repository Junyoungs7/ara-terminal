import { useEffect, useRef, useState } from 'react'
import type { UpdateState } from '@shared/ipc'
import type { DialogResult, DialogSpec } from '../components/Dialog'
import { t } from '../i18n'

/**
 * #98 업데이트를 **알린다** — 상태를 사람 눈에 닿게 하는 자리.
 *
 * 감사 R2(2026-08-28)가 정한 것은 *"알리기만 하고 받는 것은 사람이 누른다"* 였는데,
 * `autoDownload = false` 로 **받지 않는다**만 만들고 **알린다**를 안 만들었다. `available` 이 닿는
 * 화면이 설정 서랍 하나뿐이라 아무도 안 여는 서랍에서 혼잣말을 하고 있었다
 * (2026-09-04 준영님 0.9.9 실기: *"20초동안 가만히 있어도 … 이건 안나오고"*).
 *
 * **상태 기계는 여기 없다.** main 의 `update/AutoUpdate.ts` 가 갖고 이 파일은 화면만 붙인다.
 * 알리는 자리는 둘이다:
 *  ① 상태 표시줄의 버전 칸 — `updateSeg`. 닫을 수 없으니 계속 남는다.
 *  ② 켤 때 한 번 뜨는 창 — `useUpdatePrompt`. [나중에] 를 누르면 그 버전으로는 다시 안 뜬다.
 */

/**
 * [나중에] 를 누른 버전. **localStorage 에 둔다.**
 *
 * 워크스페이스 스냅샷이 아닌 이유는 BootSplash 의 `ara.boot.lastGreet` 와 같다 — 사용자가 고른
 * **설정값이 아니라 잠깐의 기억**이고, 스냅샷에 넣으면 앱을 켤 때마다 설정 파일이 바뀐다.
 *
 * ⚠️ **스키마는 올리지 않았다.** 선택 필드 하나를 더하는 것 자체는 `migrations.ts` 가 요구하지
 * 않는다(없는 필드는 그대로 통과한다). 문제는 `SCHEMA_VERSION` 을 올리는 순간 그 파일을 **옛 앱이
 * 못 읽는다**는 것이다 — `migrate()` 는 `version > SCHEMA_VERSION` 이면 `null` 을 돌려주고 호출부는
 * 기본 스냅샷으로 떨어진다(= 프로필·레이아웃이 통째로 사라진 것처럼 보인다). 업데이트를 미룬 채
 * 옛 앱을 계속 쓰는 사람이 정확히 이 기능의 사용자라, 스누즈 한 칸 때문에 그 위험을 질 이유가 없다.
 */
const SNOOZE_KEY = 'ara.update.snoozed'

export const readSnoozed = (): string | null => {
  try {
    return localStorage.getItem(SNOOZE_KEY)
  } catch {
    return null // 저장소가 막힌 판 — 매번 묻는 쪽이 영영 안 묻는 쪽보다 낫다
  }
}

export const writeSnoozed = (v: string): void => {
  try {
    localStorage.setItem(SNOOZE_KEY, v)
  } catch {
    /* 못 기억해도 알림 자체는 돈다 */
  }
}

/**
 * 지금 창을 띄울 버전. 안 띄우면 null. **순수 함수** — 검사는 tests/updateNotify.test.ts.
 *
 * `available` 이면서 그 버전으로 **아직 안 물어봤을 때**만 뜬다. 스누즈는 버전별이라 더 새 버전이
 * 올라오면 다시 묻는다(1.0.0 을 미뤘다고 1.1.0 까지 조용하면 안 된다).
 *
 * 버전이 없는 `available` 은 **띄우지 않는다** — 스누즈할 열쇠가 없어 [나중에] 가 기억되지 않고,
 * 그러면 상태가 올 때마다 같은 창이 다시 뜬다. 그 경우도 상태 표시줄과 설정 서랍은 그대로 알린다.
 */
export function promptVersion(st: UpdateState | null, snoozed: string | null): string | null {
  if (!st || st.status !== 'available' || !st.version) return null
  return st.version === snoozed ? null : st.version
}

/**
 * 다 받은 뒤 **재시작을 물을 버전**. 안 물으면 null. **순수 함수** — 검사는 tests/updateNotify.test.ts.
 *
 * 왜 따로 있나(2026-09-10 준영님): *"받기 누르면 다운 받고 바로 팝업이 떠서 지금 재시작할거냐?
 * 또는 나중에 할꺼냐 팝업으로 선택 가능하게"*. 지금은 다 받아도 **설정 서랍 안에 [설치] 버튼이
 * 조용히 생길 뿐**이라, 서랍을 안 열면 다 받은 줄도 모른다(`available` 이 겪은 것과 같은 병이다).
 *
 * `promptVersion` 과 **합치지 않는다.** 둘은 묻는 것이 다르다 — 저쪽은 *"받을까요"*, 이쪽은
 * *"지금 껐다 켤까요"* 다. 그리고 스누즈 규칙이 다르다: 저쪽은 localStorage 로 판을 넘겨 기억하고,
 * 이쪽은 **이번 실행 안에서만** 기억한다(다음에 켤 때는 이미 설치돼 있다 — autoInstallOnAppQuit).
 */
export function readyVersion(st: UpdateState | null): string | null {
  if (!st || st.status !== 'ready' || !st.version) return null
  return st.version
}

/**
 * 방금 **새 판으로 넘어왔나** — 설치가 끝나고 다시 뜬 직후 한 번만 알린다. **순수 함수.**
 *
 * ⚠️ **저장값이 없으면 안 띄운다.** 처음 깐 사람에게 "업데이트되었습니다"는 거짓말이다 —
 * 그 사람은 업데이트한 적이 없다. 값이 없을 때는 조용히 지금 버전을 적어 두기만 한다(호출측).
 */
export function justUpdated(lastSeen: string | null, current: string): boolean {
  return lastSeen !== null && lastSeen !== '' && lastSeen !== current
}

/** 마지막으로 **본** 버전. 스누즈와 같은 이유로 localStorage 다(설정이 아니라 잠깐의 기억). */
const SEEN_KEY = 'ara.update.seenVersion'

export const readSeenVersion = (): string | null => {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null // 저장소가 막힌 판 — 조용한 쪽으로 떨어진다(안 띄운다)
  }
}

export const writeSeenVersion = (v: string): void => {
  try {
    localStorage.setItem(SEEN_KEY, v)
  } catch {
    /* 못 기억해도 앱은 돈다 */
  }
}

/** 상태 표시줄 버전 칸이 무엇이 되나(순수). */
export type UpdateSeg = {
  /** 칸에 찍는 짧은 글자. 상태바는 좁다 — 긴 말은 전부 `title` 로 간다. */
  text: string
  /** 툴팁. 할 말이 없으면 빈 문자열. */
  title: string
  /**
   * 누르면 무엇을 하나. null 이면 표시 전용 칸이다.
   *
   * `'check'` 가 1.0.10 에 생겼다(준영님: *"우측 하단에 버전을 누르면 최신버전입니다 토스트로
   * 뜨고, 업데이트할 버전이 있으면 이걸로도 버전 체크해서 업데이트가 가능하게"*).
   * 그전에는 **새 판이 있을 때만** 눌렸다 — 평소엔 버전을 보려고 설정을 열어야 했다.
   */
  action: 'download' | 'install' | 'check' | null
  /** CSS 가 색을 고르는 열쇠. **색만으로 말하지 않는다**(§6) — 위 `text` 가 같은 것을 글자로 말한다. */
  tone: 'available' | 'downloading' | 'ready' | null
}

/**
 * 상태 → 버전 칸. 기본은 지금까지와 똑같이 `v{version}` 이다.
 *
 * `error` 는 **일부러 여기 없다.** 사내망 밖 노트북이면 하루 네 번 확인마다 상태바가 빨개진다 —
 * 실패는 설정 서랍과 로그가 갖는다(AUDIT-R2 ⑤ 와 같은 판단). `checking` 도 같다: 20초마다 글자가
 * 흔들려 봐야 사람이 할 일이 없다.
 */
export function updateSeg(st: UpdateState | null, version: string): UpdateSeg {
  /**
   * 평소 모습 — **누르면 지금 확인한다.**
   *
   * ⚠️ `tone` 은 그대로 `null` 이다. 색은 "지금 할 일이 있다"를 뜻하고(§6), 최신인 상태는 할 일이
   * 없다 — 늘 색이 있으면 그 색이 아무 말도 안 하게 된다. 눌리는 것과 색은 다른 축이다.
   */
  const plain: UpdateSeg = { text: `v${version}`, title: t('statusbar.update.check.title'), action: 'check', tone: null }
  // 상태를 아직 모른다(부팅 직후) — 그래도 누르면 확인한다.
  if (!st) return plain
  // 받는 중에는 버전 없이도 할 말이 있다(진행률). 누를 것은 없다 — 취소는 만들지 않았다.
  if (st.status === 'downloading') {
    const p = String(st.percent ?? 0)
    return {
      text: t('statusbar.update.downloading').replace('{p}', p),
      title: t('statusbar.update.downloading.title').replace('{p}', p),
      action: null,
      tone: 'downloading'
    }
  }
  // 확인하는 동안에는 **누를 수 없다** — 두 번 누르면 두 번 확인한다.
  if (st.status === 'checking') {
    return { text: t('settings.update.checking'), title: '', action: null, tone: null }
  }
  // 버전을 모르면 할 말이 "새 게 있다" 뿐이라 상태바에서는 조용히 넘어간다(설정 서랍이 말한다).
  if (!st.version) return plain
  const v = st.version
  if (st.status === 'available') {
    return {
      text: t('statusbar.update.available').replace('{v}', v),
      title: t('statusbar.update.available.title').replace('{v}', v),
      action: 'download',
      tone: 'available'
    }
  }
  if (st.status === 'ready') {
    return {
      text: t('statusbar.update.ready').replace('{v}', v),
      title: t('statusbar.update.ready.title').replace('{v}', v),
      action: 'install',
      tone: 'ready'
    }
  }
  return plain
}

/** 업데이트 상태 구독 — 열릴 때 한 번 묻고 그 뒤로는 push 로 받는다(설정 서랍과 같은 규칙). */
export function useUpdateState(): UpdateState | null {
  const [st, setSt] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.ev?.app?.updateState?.().then(setSt).catch(() => {})
    return window.ev?.app?.onUpdateState?.(setSt)
  }, [])
  return st
}

/**
 * 상태 표시줄에서 누른 것을 집행한다.
 *
 * **`ready` 에서만 확인을 받는다.** 설치는 앱을 껐다 켜서 열려 있는 터미널·SSH 를 전부 끊는다 —
 * 좁은 상태바에서 실수로 스친 클릭에 하던 일이 날아가면 안 된다(파괴적 동작 규칙). `available` 은
 * 받기만 시작하고 하던 일을 안 건드리므로 곧장 간다.
 */
/**
 * 방금 끝난 확인의 **결과 문구**. 안 띄우면 null. **순수 함수** — 검사는 tests/updateNotify.test.ts.
 *
 * 왜 이렇게 좁나(준영님 요청: 버전 칸을 누르면 토스트):
 *  · **사람이 누른 확인에만 띄운다.** 6시간 주기 확인에도 띄우면 하루 네 번 토스트가 뜬다 —
 *    그건 기능이 아니라 방해다. 그래서 `asked` 를 호출측이 세운다
 *  · **`checking` → 다른 상태로 바뀌는 순간에만** 띄운다. 상태가 올 때마다 띄우면 같은 결과를
 *    여러 번 말한다(상태는 여러 이유로 다시 온다)
 *  · `available` 은 여기서 **말만 한다** — 받는 것은 상태바 칸이 `↑ 있음` 으로 바뀌어 받는다.
 *    토스트에 버튼을 만들지 않는다(토스트는 글자만 그리는 물건이다)
 */
/**
 * 설치를 시작한다 — **끄기 직전 한 박자 알리고** 부른다(#198).
 *
 * `quitAndInstall` 은 부르는 순간 창을 가져간다. 그 전에 `onInstalling()` 이 카드를 세우고,
 * **한 프레임 뒤에** 실제 설치를 부른다 — 안 그러면 카드가 그려질 틈이 없다.
 * ⚠️ 기다리는 시간은 "그릴 만큼"이다. 길면 사용자가 멈춘 줄 안다.
 * 🔴 설치가 **시작된 뒤에는** 우리가 그릴 수 있는 것이 없다(프로세스가 사라진다) — 이 한 박자가
 *    이 구조에서 보여 줄 수 있는 전부다.
 */
function startInstall(onInstalling?: () => void): void {
  onInstalling?.()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => void window.ev?.app?.updateInstall?.())
  })
}

export function checkToast(prev: UpdateState | null, next: UpdateState | null, asked: boolean): string | null {
  if (!asked) return null
  if (prev?.status !== 'checking') return null // 사람이 누른 그 확인이 끝나는 순간만
  if (!next) return null
  if (next.status === 'idle') return t('statusbar.update.toast.latest')
  if (next.status === 'available' && next.version) return t('statusbar.update.toast.found').replace('{v}', next.version)
  if (next.status === 'error') return t('settings.update.error')
  // downloading·ready·checking·off — 확인의 결과가 아니거나(이미 받는 중) 할 말이 없다.
  return null
}

export async function runUpdateAction(
  action: 'download' | 'install' | 'check',
  version: string,
  ask: (spec: DialogSpec) => Promise<DialogResult>,
  onInstalling?: () => void
): Promise<void> {
  // 확인은 묻지 않는다 — 아무것도 안 바꾸고 하던 일을 안 건드린다.
  if (action === 'check') {
    void window.ev?.app?.updateCheck?.()
    return
  }
  if (action === 'download') {
    void window.ev?.app?.updateDownload?.()
    return
  }
  const r = await ask({
    title: t('update.install.title'),
    message: t('update.install.msg').replace('{v}', version),
    tone: 'danger',
    confirmLabel: t('settings.update.install')
  })
  if (r === 'confirm') startInstall(onInstalling)
}

/**
 * 켤 때 한 번 뜨는 창 — [나중에] · [받기].
 *
 * **본창에서만 부른다.** 창마다 뜨면 떼어낸 창 셋이 동시에 묻는다. 가르는 자물쇠가 둘이다:
 *  · main 이 `update:state` 를 **본창 webContents 로만** 보낸다(src/main/index.ts 의 `mainWc`).
 *  · 그 위로 호출측이 `enabled` 를 준다 — MainArea 가 `detachedWinId` 와 인사 두 개로 만든다.
 *
 * 상태가 여러 번 와도(6시간마다 다시 확인한다) 창은 한 버전에 한 번이다. 스누즈는 껐다 켜도
 * 살지만 `asked` 는 이번 실행 안의 기억이라 [받기] 를 누른 뒤 다시 묻는 것도 여기서 막힌다.
 */
export function useUpdatePrompt(
  enabled: boolean,
  ask?: (spec: DialogSpec) => Promise<DialogResult>,
  onInstalling?: () => void
): void {
  const st = useUpdateState()
  /**
   * 이번 실행에서 이미 물어본 것. **`상태:버전` 으로 잡는다** — 버전만으로 잡으면 같은 판을
   * *"받을까요"* 로 한 번 물은 뒤 다 받고 나서 *"지금 껐다 켤까요"* 를 못 묻는다.
   */
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !ask) return

    // ① 다 받았다 → 지금 껐다 켤까요. 먼저 본다(같은 판이면 이쪽이 더 나중 단계다).
    const ready = readyVersion(st)
    if (ready && asked.current !== `ready:${ready}`) {
      asked.current = `ready:${ready}`
      void (async () => {
        const r = await ask({
          title: t('update.install.title'),
          message: t('update.install.msg').replace('{v}', ready),
          confirmLabel: t('settings.update.install'),
          cancelLabel: t('update.prompt.later')
        })
        // [나중에]·ESC 는 **아무것도 안 하는 게 맞다** — 이미 받아 뒀고 `autoInstallOnAppQuit` 이
        // 켜져 있어(main/update/AutoUpdate.ts) 그냥 끄기만 해도 종료할 때 조용히 설치된다.
        // 그 사실은 위 update.install.msg 가 마지막 문장으로 말한다. 상태 표시줄에도 남는다.
        if (r === 'confirm') startInstall(onInstalling)
      })()
      return
    }

    // ② 새 버전이 있다 → 받을까요.
    const v = promptVersion(st, readSnoozed())
    if (!v || asked.current === `available:${v}`) return
    asked.current = `available:${v}`
    void (async () => {
      const r = await ask({
        title: t('update.prompt.title').replace('{v}', v),
        message: t('update.prompt.msg'),
        confirmLabel: t('settings.update.download'),
        cancelLabel: t('update.prompt.later')
      })
      if (r === 'confirm') void window.ev?.app?.updateDownload?.()
      // [나중에]·ESC — 그 버전으로는 다시 안 묻는다. 상태 표시줄에는 계속 남는다.
      else writeSnoozed(v)
    })()
  }, [enabled, ask, st, onInstalling])
}
