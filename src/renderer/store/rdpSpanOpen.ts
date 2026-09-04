// 다중 모니터로 붙는 길. 컴포넌트 밖에 두는 이유는 하나 — 모니터가 한 장일 때의 안내와
// "이미 열려 있음" 안내를 한 곳에서 내기 위해서다(호출측이 다이얼로그를 갖고 있지 않다).
//
// 2026-09-04: 헤더 [다중 모니터] 버튼이 아니라 **프로필 설정**이 이 길을 부른다(Shell 의
// openRdpProfile). 그 서버를 어떻게 쓰는지의 성질이지 접속할 때마다 고르는 것이 아니다.
//
// 모니터 고르기 UI 는 없다: **전부 펼친다**. 3장 이상에서 일부만 고르고 싶다는 요구가 나오면
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
 * `single` = 펼칠 모니터가 없다 → **호출측이 보통 탭으로 열어야 한다**(안내는 여기서 이미 냈다).
 * `opened` = 창이 떴거나 있던 창이 앞으로 왔다 → 탭을 또 열면 같은 서버에 두 번 붙는 꼴이 된다.
 * `failed` = 그 밖의 거절(사유는 안내로 나갔다).
 */
export type SpanOutcome = 'opened' | 'single' | 'failed'

/** 모니터 전체에 펼친 창을 연다. */
export async function spanRdp(profileId: string, name: string): Promise<SpanOutcome> {
  const api = window.ev?.rdp
  if (!api || !profileId) return 'failed'
  const { displays } = await api.displays()
  // 한 장뿐이면 창을 띄우지 않는다 — 펼칠 곳이 없는데 창이 뜨면 "왜 탭이 아니지"가 된다.
  if (displays.length < 2) {
    notify(t('rdp.span.single'))
    return 'single'
  }
  const res = await api.openSpan(profileId, name, [])
  if (!res.ok) {
    notify(res.message)
    // "이미 열어 두었습니다"도 여기로 온다 — main 이 그 창을 앞으로 가져왔으므로 탭을 열면 안 된다.
    return 'opened'
  }
  // 크기가 다른 모니터를 나란히 쓰면 감싸는 사각형에 남는 자리가 생긴다 — 원격 바탕화면은 거기까지
  // 그려지지만 아무 모니터에도 안 보인다. 조용히 두면 "창이 사라졌다"로 오해한다.
  // (어긋난 배치는 이제 원인이 아니다 — planSpan 이 사각형을 맞붙여 깔아 어긋남을 안 따라간다.)
  if (res.plan.deadRatio > 0.02) notify(t('rdp.span.dead'))
  return 'opened'
}
