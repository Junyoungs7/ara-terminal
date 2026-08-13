// [다중 모니터] 버튼이 하는 일. 컴포넌트 밖에 두는 이유는 하나 — 모니터가 한 장뿐일 때의 안내와
// "이미 열려 있음" 안내를 한 곳에서 내기 위해서다(PaneGrid 는 다이얼로그를 갖고 있지 않다).
//
// 모니터 고르기 UI 는 아직 없다: **전부 펼친다**. 3장 이상에서 일부만 고르고 싶다는 요구가 나오면
// 그때 붙인다(shared/rdpSpan.ts 의 planSpan 은 이미 부분 선택을 받는다 — UI 만 없다).
import { t } from '../i18n'

/** 안내를 어디로 낼지. 앱이 토스트를 갖고 있어 그걸 쓰지만, 테스트에서는 갈아끼운다. */
let notify: (msg: string) => void = (msg) => {
  // 토스트가 붙기 전(초기 렌더)에는 콘솔로만 — 안내 하나 때문에 예외를 던지지 않는다.
  console.info('[rdp-span]', msg)
}

export function setSpanNotifier(fn: (msg: string) => void): void {
  notify = fn
}

/**
 * 모니터 전체에 펼친 창을 연다. 모니터가 한 장이면 열지 않는다 — 탭에서 보는 것과 똑같은 화면이
 * 창만 하나 더 뜨는 꼴이라 얻는 게 없다.
 */
export async function spanRdp(profileId: string, name: string): Promise<boolean> {
  const api = window.ev?.rdp
  if (!api || !profileId) return false
  const { displays } = await api.displays()
  if (displays.length < 2) {
    notify(t('rdp.span.single'))
    return false
  }
  const res = await api.openSpan(profileId, name, [])
  if (!res.ok) {
    notify(res.message)
    return false
  }
  // 어긋나게 배치된 모니터는 감싸는 사각형에 구멍이 생긴다 — 원격 바탕화면은 거기까지 그려지지만
  // 아무 모니터에도 안 보인다. 조용히 두면 "창이 사라졌다"로 오해한다.
  if (res.plan.deadRatio > 0.02) notify(t('rdp.span.dead'))
  return true
}
