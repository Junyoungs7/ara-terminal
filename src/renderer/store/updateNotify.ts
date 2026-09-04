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

/** 상태 표시줄 버전 칸이 무엇이 되나(순수). */
export type UpdateSeg = {
  /** 칸에 찍는 짧은 글자. 상태바는 좁다 — 긴 말은 전부 `title` 로 간다. */
  text: string
  /** 툴팁. 할 말이 없으면 빈 문자열. */
  title: string
  /** 누르면 무엇을 하나. null 이면 예전처럼 표시 전용 칸이다. */
  action: 'download' | 'install' | null
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
  const plain: UpdateSeg = { text: `v${version}`, title: '', action: null, tone: null }
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
export async function runUpdateAction(
  action: 'download' | 'install',
  version: string,
  ask: (spec: DialogSpec) => Promise<DialogResult>
): Promise<void> {
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
  if (r === 'confirm') void window.ev?.app?.updateInstall?.()
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
export function useUpdatePrompt(enabled: boolean, ask?: (spec: DialogSpec) => Promise<DialogResult>): void {
  const st = useUpdateState()
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !ask) return
    const v = promptVersion(st, readSnoozed())
    if (!v || asked.current === v) return
    asked.current = v
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
  }, [enabled, ask, st])
}
