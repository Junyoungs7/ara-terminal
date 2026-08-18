import { t } from '../i18n'

// 클립보드 쓰기 한 곳. 2026-08-13 준영님 결정("토스트로 알려줘")으로 만들었다.
//
// **실패를 삼키지 않는다.** 그전에는 다섯 군데가 전부 `.catch(() => {})` 였다 — 복사가 거부돼도
// 화면에는 아무 일도 안 일어나서, 사용자는 복사된 줄 알고 붙여넣다가 **엉뚱한(이전) 값**을 붙인다.
// 조용한 실패 중에서도 나쁜 쪽이다: 실패했다는 사실 자체가 안 보인다.
//
// 실제로 거부되는 자리는 하나다: **창에 포커스가 없으면** Chromium 이 async 클립보드 쓰기를
// 거부한다(`navigator.clipboard.writeText`). 앱을 쓰는 동안에는 늘 포커스가 있어 거의 안 나지만,
// 창이 비활성인 채로 단축키가 들어오는 경로에서는 난다 — e2e 하네스가 창을 showInactive() 로
// 띄우는데, 2026-08-13 CLIP-1 이 빨갛던 원인이 정확히 그거였다(DLP 가 아니었다).

/** 안내를 어디로 낼지. 앱은 토스트를 쓰고, 붙기 전(초기 렌더)에는 콘솔로만 — rdpSpanOpen 과 같은 결. */
let notify: (msg: string) => void = (msg) => {
  console.info('[clipboard]', msg)
}

export function setClipboardNotifier(fn: (msg: string) => void): void {
  notify = fn
}

/**
 * 클립보드에 쓴다. 성공하면 true. 거부되면 안내를 내고 false.
 *
 * @param announce 성공했을 때 "복사됨"을 띄운다(2026-08-18 준영님 제보).
 *   단축키(Ctrl+C)로 복사하면 **화면에 아무 일도 안 일어나** 됐는지 알 수 없었다 — 우클릭
 *   메뉴로 복사할 때만 토스트가 있었다. 기본값이 false 인 이유: 선택 즉시 복사(X11 관례)는
 *   드래그할 때마다 뜨면 시끄럽다. 사람이 **키를 누른** 경로에서만 켠다.
 */
export async function writeClipboard(text: string, announce = false): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    if (announce) notify(t('ctx.copied'))
    return true
  } catch {
    notify(t('clipboard.writeFailed'))
    return false
  }
}

/**
 * 클립보드를 읽는다. **빈 클립보드와 거부를 가른다** — 빈 것은 안내할 일이 아니고(사용자가 아무것도
 * 복사하지 않았을 뿐이다), 거부는 알려야 한다. 둘 다 빈 문자열로 뭉개면 "붙여넣기가 안 먹네"가 된다.
 */
export async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    notify(t('clipboard.readFailed'))
    return ''
  }
}

/**
 * "붙여넣기됨"(2026-08-18 준영님 제보). 붙여넣기는 화면에 글자가 나타나니 대개 자명하지만,
 * **비밀번호 프롬프트처럼 안 보이는 자리**에서는 붙었는지 아닌지가 이 안내 말고 단서가 없다.
 */
export function notifyPasted(): void {
  notify(t('ctx.pasted'))
}
