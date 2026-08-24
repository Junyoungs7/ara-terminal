// F25 RDP 입력 변환 — 브라우저 이벤트를 RDP 가 이해하는 형태로 바꾼다.
//
// RDP 는 문자가 아니라 **물리 키 위치(스캔코드, PS/2 set 1)** 를 보낸다. 브라우저의 KeyboardEvent.code
// 가 바로 그 물리 위치라(레이아웃 무관) 여기서 스캔코드로 매핑한다 — key(문자)로 매핑하면 한글·기호
// 입력에서 어긋난다.
// 확장 키(방향키·Insert 등)는 0xE0 접두가 붙어 상위 바이트로 표현한다(0xE0 << 8 | code).

const E0 = 0xe000

export const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  F11: 0x57, F12: 0x58,
  // 한글 키보드 전용(한/영·한자). 없는 키보드에서는 오지 않는다.
  Lang1: 0x72, Lang2: 0x71,
  // 확장 키 — 앞에 0xE0 이 붙는다.
  NumpadEnter: E0 | 0x1c, ControlRight: E0 | 0x1d, NumpadDivide: E0 | 0x35,
  AltRight: E0 | 0x38, Home: E0 | 0x47, ArrowUp: E0 | 0x48, PageUp: E0 | 0x49,
  ArrowLeft: E0 | 0x4b, ArrowRight: E0 | 0x4d, End: E0 | 0x4f, ArrowDown: E0 | 0x50,
  PageDown: E0 | 0x51, Insert: E0 | 0x52, Delete: E0 | 0x53,
  MetaLeft: E0 | 0x5b, MetaRight: E0 | 0x5c, ContextMenu: E0 | 0x5d
}

export function scancodeOf(code: string): number | null {
  return SCANCODES[code] ?? null
}

// ── Mac 키보드 → Windows 원격 (준영님 요청 2026-08-07) ─────────────────────────────
// 수식키가 물리적으로 **다른 자리**에 있다:
//   Mac      [Ctrl][⌥ ][⌘ ] ␣ [⌘ ][⌥ ]
//   Windows  [Ctrl][Win][Alt] ␣ [Alt][Win]
// 즉 ⌘ 가 앉은 자리가 Windows 의 Alt 자리이고, ⌥ 가 앉은 자리가 Win 자리다. 스캔코드를 그대로
// 보내면 손가락이 Alt 를 누르는 자리에서 시작 메뉴가 열리고, 한/영(한국어 101키 Windows 에서는
// 우측 Alt)은 우⌥ 로 밀려난다 — 준영님이 겪은 증상 그대로다. 자리를 기준으로 ⌘↔⌥ 를 맞바꾼다.
export type RdpKeyMode = 'off' | 'mac' | 'macCtrl'
export const RDP_KEY_MODES: RdpKeyMode[] = ['off', 'mac', 'macCtrl']

const REMAP: Record<RdpKeyMode, Record<string, string>> = {
  off: {},
  // 자리 그대로: 좌⌘→Alt, 우⌘→우Alt(= 한/영), ⌥→Win.
  mac: { MetaLeft: 'AltLeft', MetaRight: 'AltRight', AltLeft: 'MetaLeft', AltRight: 'MetaRight' },
  // ⌘C·⌘V 를 Ctrl+C·Ctrl+V 로 쓰고 싶을 때. 한/영(우⌘)은 그대로 두고 ⌥ 는 Alt 로 남긴다
  // — Win 키는 헤더의 [Win] 버튼으로 보낸다.
  macCtrl: { MetaLeft: 'ControlLeft', MetaRight: 'AltRight' }
}

export function remapKeyCode(code: string, mode: RdpKeyMode): string {
  return REMAP[mode]?.[code] ?? code
}

// Mac 에서만 기본으로 켠다. Windows·Linux 호스트에서 켜면 멀쩡한 Alt·Win 을 서로 바꿔 버린다.
export function defaultRdpKeyMode(ua: string): RdpKeyMode {
  return ua.includes('Mac') ? 'mac' : 'off'
}

// ── 클립보드 ────────────────────────────────────────────────────────────────
// 원격이 올려 보내는 클립보드는 형식이 여러 개 섞여 온다(text/plain · text/html · 이미지…).
// 우리가 지금 다루는 것은 **텍스트뿐**이다 — 원격↔로컬로 오가는 게 대개 명령줄·경로·로그 한 줄이고,
// 이미지·파일은 형식 협상과 대용량 스트림이 따로 붙는 별개 작업이다.
// charset 이 붙은 형식(text/plain;charset=utf-8)도 같이 받는다.
export type RdpClipItem = { mimeType(): string; value(): unknown }

// ── 클립보드 소유권 ────────────────────────────────────────────────────────
// RDP 클립보드는 방향별로 하나뿐이고 **마지막에 복사한 쪽이 주인**이다(MS-RDPECLIP: Format List 를
// 나중에 보낸 쪽이 이긴다). mstsc 도 같다 — "로컬 것인지 원격 것인지" 구분하는 게 아니라 최신이 이긴다.
//
// 문제는 우리가 언제 "복사했다"고 알리느냐다. 캔버스에 포커스가 올 때마다 무조건 알리면,
// 원격에서 방금 복사한 파일이 (로컬 클립보드는 그대로인데도) 덮여 버린다 — 원격 파일 받기가 깨진다.
// 그래서 지문을 들고 **정말 바뀐 로컬 복사만** 알린다.
export function clipboardSignature(src: { paths?: readonly string[]; text?: string }): string | null {
  // 파일이 우선이다 — 탐색기에서 파일을 복사하면 경로 텍스트도 함께 올라오는 경우가 있는데,
  // 사용자가 복사한 것은 파일이다.
  if (src.paths && src.paths.length > 0) return 'f:' + src.paths.join('|')
  if (src.text) return 't:' + src.text
  return null
}

/**
 * 지금 로컬 클립보드를 원격에 알려야 하는가(순수 — 단위 테스트 대상).
 *  · sig 가 없으면(빈 클립보드) 알릴 것이 없다.
 *  · 우리가 이미 알린 것과 같으면 다시 알리지 않는다 — 알리는 순간 원격의 복사를 빼앗는다.
 *  · 원격이 방금 우리에게 준 것과 같으면 알리지 않는다(에코) — 원격 텍스트를 로컬 클립보드에
 *    써 넣기 때문에, 그걸 그대로 되돌려 보내면 주인이 무의미하게 뒤집힌다.
 */
export function shouldAnnounceClipboard(
  sig: string | null,
  announced: string | null,
  fromRemote: string | null
): boolean {
  if (!sig) return false
  return sig !== announced && sig !== fromRemote
}

export function pickClipboardText(items: readonly RdpClipItem[]): string | null {
  // text/plain 을 먼저 찾고, 없으면 다른 text/* 라도 받는다(html 만 오는 원격이 있다).
  for (const pass of ['text/plain', 'text/'] as const) {
    for (const item of items) {
      let mime = ''
      try {
        mime = item.mimeType()
      } catch {
        continue // wasm 객체가 이미 해제된 항목
      }
      if (!mime.startsWith(pass)) continue
      try {
        const v = item.value()
        if (typeof v === 'string' && v.length > 0) return v
      } catch {
        continue
      }
    }
  }
  return null
}

// IronRDP 는 브라우저와 같은 번호 체계(0=왼쪽,1=가운데,2=오른쪽)를 쓴다 — 재매핑하면 클릭이
// 엉뚱한 버튼으로 가거나 무시된다(초기 구현의 실제 원인). 유효 범위만 거른다.
export function rdpButtonOf(button: number): number | null {
  return button === 0 || button === 1 || button === 2 ? button : null
}

// Alt+Tab 같은 조합은 Windows 가 먼저 가로채 앱까지 오지 않는다 — 버튼으로 직접 보낼 수 있게
// 스캔코드 순서를 정의한다(누름 순서대로 넣고, 뗄 때는 역순).
export const KEY_COMBOS: Record<string, string[]> = {
  altTab: ['AltLeft', 'Tab'],
  ctrlAltDel: ['ControlLeft', 'AltLeft', 'Delete'],
  win: ['MetaLeft'],
  altF4: ['AltLeft', 'F4'],
  ctrlEsc: ['ControlLeft', 'Escape']
}

// 원격 해상도 선택지. **기본은 "창 크기에 맞춤"** 이다(2026-08-24 준영님 결정 — 접속마다 고르지
// 않게 통일). 예전에 창 맞춤을 기본에서 뺐던 이유는 접속 시점 크기가 그대로 굳어(RDP 는 접속 시
// 해상도가 세션 해상도다) 창을 키워도 저해상도가 늘어나 보였기 때문인데, 이제 RdpView 가 창 크기를
// 계속 따라가며 Display Control 로 다시 요청한다 — 그 이유가 사라졌다.
// 아래 값은 목록의 한 항목이자 **칸을 잴 수 없을 때의 최후 값**이다(고를 수 있는 기본값이 아니다).
export const RDP_DEFAULT: [number, number] = [1920, 1080]
export const RDP_RESOLUTIONS: [number, number][] = [
  [1280, 720],
  [1366, 768],
  [1600, 900],
  RDP_DEFAULT,
  [2560, 1440]
]
export const resLabel = ([w, h]: [number, number]): string => `${w} × ${h}`

// RDP 해상도는 4의 배수가 안전하다(일부 서버가 어중간한 폭에서 화면을 깨뜨린다).
export function round4(n: number): number {
  return Math.max(640, Math.floor(n / 4) * 4)
}

// 고른 라벨 → 고정 해상도. 목록에 없으면 null("창 크기에 맞춤" — 호출부가 칸 크기를 잰다).
export function fixedResolution(label: string): [number, number] | null {
  return RDP_RESOLUTIONS.find((r) => resLabel(r) === label) ?? null
}

// 라벨 + 칸 → 실제 픽셀. 고정 해상도는 창이 어떻게 바뀌든 그대로고, 창 맞춤일 때만 칸을 잰다.
// 칸이 없거나(마운트 전) 숨어 있으면 round4 가 640 으로 받치고, 아예 못 재면 RDP_DEFAULT 로 간다.
export function resolveSize(label: string, host: { clientWidth: number; clientHeight: number } | null): [number, number] {
  const fixed = fixedResolution(label)
  if (fixed) return fixed
  return host ? [round4(host.clientWidth), round4(host.clientHeight)] : RDP_DEFAULT
}

// 캔버스 표시 크기와 실제 해상도가 다를 수 있다(CSS 스케일) — 원격 좌표계로 환산한다.
export function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  const sx = r.width === 0 ? 1 : canvas.width / r.width
  const sy = r.height === 0 ? 1 : canvas.height / r.height
  const x = Math.round((clientX - r.left) * sx)
  const y = Math.round((clientY - r.top) * sy)
  return {
    x: Math.min(Math.max(x, 0), canvas.width - 1),
    y: Math.min(Math.max(y, 0), canvas.height - 1)
  }
}
