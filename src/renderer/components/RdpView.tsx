// F25 앱 내장 RDP 뷰 — IronRDP(Rust)를 WASM 으로 컴파일한 클라이언트를 캔버스에 그린다.
// 외부 게이트웨이 없이 main 의 loopback 릴레이(RdpRelay.ts)에 붙는다. 접속 대상은 main 이 프로필로
// 정하므로 이 컴포넌트는 profileId 와 비밀번호만 넘긴다.
//
// 패키지: **@devolutions/iron-remote-desktop-rdp**(벤더 공식, GitHub Actions 배포).
// 2026-08-09 에 electerm/ironrdp-wasm(제3자 리패키지)에서 갈아탔다 — 공급망을 벤더로 되돌리고,
// wasm 이 base64 로 내장돼 있어 자산 경로 문제(dev 서버에서 .wasm 요청이 index.html 로 폴백되던
// 것)가 아예 사라진다. Session/SessionBuilder 표면은 같고, 다른 점은 둘뿐이다:
//   · 클래스가 Backend 네임스페이스 밑에 있다(Backend.SessionBuilder …)
//   · 확장이 문자열 ident 대신 타입 있는 팩토리다(enableCredssp(true) 등)
//
// 비밀번호는 프로필에 저장해 두면 바로 붙고, 없으면 화면에서 받는다(2026-08-07).
// 클립보드는 텍스트 양방향이고, 파일은 윈도우 클립보드(CF_HDROP)와 이어져 있다(#205 — main/rdp/rdpClipboard.ts).
// 이미지는 아직.
import { Check } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readClipboard, writeClipboard } from '../store/clipboardWrite'
import { filePaths, registerPasteTarget } from '../store/pasteFiles'
import type { RdpPhase } from '../store/sessionState'
import { t } from '../i18n'
import { ContextMenu, type MenuItem } from '../interactions/ContextMenu'
import { IconChevronDown } from './icons'
import { PasswordInput } from './PasswordInput'
import {
  KEY_COMBOS,
  RDP_DEFAULT,
  RDP_KEY_MODES,
  RDP_RESOLUTIONS,
  canvasPoint,
  defaultRdpKeyMode,
  fixedResolution,
  rdpButtonOf,
  afterRemoteCopy,
  autoReceivePlan,
  clipboardSignature,
  ownFilesSig,
  pathsSig,
  pickClipboardText,
  remapKeyCode,
  shouldAnnounceClipboard,
  shouldUploadPasted,
  resLabel,
  resolveSize,
  scancodeOf,
  type RdpKeyMode
} from './rdpInput'

// 키 변환 모드 ↔ 사람이 읽는 라벨(옵션 메뉴의 현재값·항목 양쪽에 쓴다).
const keyModeLabel = (m: RdpKeyMode): string => t(`rdp.keys.${m}`)

// 조합키 라벨은 번역하지 않는다 — 키 이름 자체가 라벨이다(버튼 시절과 같은 글자).
const COMBO_LABEL: Record<string, string> = {
  ctrlAltDel: 'Ctrl+Alt+Del',
  altTab: 'Alt+Tab',
  win: 'Win'
}

// 고른 항목에만 체크. 안 고른 항목도 빈 칸을 넘겨 라벨 왼쪽 줄을 맞춘다(.ci-ic 가 폭을 잡는다).
const check = (on: boolean): JSX.Element => (on ? <Check /> : <span />)

/**
 * 지금 로컬 클립보드의 지문(포커스 동기화와 원격 복사 때의 스냅숏이 같은 모양을 쓴다). 경로는 Electron 의
 * 싼 검사라 첫 경로 하나뿐이고, 파일이 없을 때만 텍스트를 읽는다(파일 우선 — clipboardSignature).
 */
async function readLocalClip(): Promise<{ paths: string[]; text: string; sig: string | null }> {
  const paths = (await window.ev.clipboard.readFiles().catch(() => ({ paths: [] as string[] }))).paths
  const text = paths.length === 0 ? await readClipboard() : ''
  return { paths, text, sig: clipboardSignature({ paths, text }) }
}

/** 옵션 버튼과 그 아래 메뉴 사이 간격(Dropdown 의 목록 배치와 같은 값). */
const MENU_GAP = 4

/**
 * [옵션] 리스트의 내용 — **순수 함수**(단위 테스트 대상).
 *
 * 2026-09-01 준영님: *"창크기 맞춤·키 변환 없음·파일 받기·보내기·단축키·다중 모니터는 그냥 옵션
 * 버튼 하나로 리스트 형태로"*. 좁은 창에서 헤더 버튼들이 줄바꿈·잘리던 것을 접는 것이 목적인데,
 * 접으면 **버튼이 몸으로 말하던 것이 사라진다** — 그래서 셋의 성격이 리스트에서 모양으로 갈린다:
 *
 *  · **고르는 것**(해상도 · 키 변환) — 서브메뉴 + 오른쪽에 **지금 값**(hint). 하위 항목엔 체크.
 *    닫아 둔 채로도 알 수 있게 [옵션] 버튼의 툴팁이 같은 값을 말한다.
 *  · **하는 것**(파일 받기·보내기 · 단축키 보내기) — 오른쪽이 비어 있고 누르면 실행.
 *  · **못 하는 것** — 비활성 + 오른쪽에 **켜지는 조건**. 버튼이던 시절에는 hover 툴팁이 하던
 *    말인데(`rdp.file.recv.title`), 접으면 hover 할 버튼 자체가 없다. 조건을 눈에 보이게 적고
 *    (`rdp.file.recv.need`) 원문은 행의 title 로 남긴다.
 *
 * 여기서 항목이 하나 빠지면 그 기능은 앱에서 **닿을 길이 없어진다**(다른 진입점이 없다) —
 * tests/rdpOptions.test.ts 가 목록과 비활성 사유를 못 박는 이유다.
 *
 * 2026-09-04: [다중 모니터] 를 이 목록에서 **뺐다.** 누를 때마다 고르는 것이 아니라 **서버의 성질**
 * 이라(그 서버는 늘 두 화면으로 쓴다) 연결 정보 쪽으로 옮겼다 — ConnectionModal 의 [다중 모니터]
 * 체크. 여기 있던 시절에는 이미 붙어 있는 탭 위에서 눌러 **세션을 하나 더** 만드는 길이기도 했다.
 */
export function rdpOptionItems(s: {
  connected: boolean
  res: string
  keyMode: RdpKeyMode
  recvCount: number
  /** 다중 모니터 창에서만. 있으면 해상도는 읽기 전용이다(모니터 배치가 정한 값). */
  fixedSize?: [number, number]
}): MenuItem[] {
  return [
    s.fixedSize
      ? // 다중 모니터 창: 크기는 모니터 배치가 정한다 — 고를 여지가 없으니 값만 보여 준다.
        { id: 'res', label: t('rdp.opt.res'), hint: resLabel(s.fixedSize), title: t('rdp.span.fixed'), disabled: true }
      : {
          id: 'res',
          label: t('rdp.opt.res'),
          hint: s.res,
          title: t('rdp.res.title'),
          submenu: [...RDP_RESOLUTIONS.map(resLabel), t('rdp.res.fit')].map((o) => ({
            id: `res:${o}`,
            label: o,
            icon: check(o === s.res)
          }))
        },
    {
      id: 'keys',
      label: t('rdp.opt.keys'),
      hint: keyModeLabel(s.keyMode),
      title: t('rdp.keys.title'),
      submenu: RDP_KEY_MODES.map((m) => ({ id: `keys:${m}`, label: keyModeLabel(m), icon: check(m === s.keyMode) }))
    },
    // 붙기 전에는 보낼 것도 받을 것도, 원격에 보낼 키도 없다 — 버튼 시절과 같은 조건이다.
    ...(s.connected
      ? [
          {
            id: 'recv',
            label: t('rdp.file.recv'),
            hint:
              s.recvCount > 0 ? t('rdp.file.recv.n').replace('{n}', String(s.recvCount)) : t('rdp.file.recv.need'),
            title: t('rdp.file.recv.title'),
            disabled: s.recvCount === 0
          },
          // #205: [파일 받기] 는 이제 클립보드로 받는다(탐색기 Ctrl+V). 폴더를 골라 받는 옛 동작은 보조로 남긴다
          // — 저장할 자리를 이미 아는 사람에게는 붙여넣기 한 번이 더 걸음이다.
          {
            id: 'recvSave',
            label: t('rdp.file.recvSave'),
            title: t('rdp.file.recvSave.title'),
            disabled: s.recvCount === 0
          },
          { id: 'send', label: t('rdp.file.send'), title: t('rdp.file.send.title') },
          {
            id: 'combo',
            label: t('rdp.opt.combo'),
            submenu: Object.entries(COMBO_LABEL).map(([k, label]) => ({
              id: `combo:${k}`,
              label,
              title: t(`rdp.combo.${k}`)
            }))
          }
        ]
      : [])
  ]
}

// 해상도는 rdpInput.ts 가 정의한다(순수 로직 — 단위 테스트 대상). 캔버스는 고른 해상도로 그리고
// CSS 가 비율을 유지한 채 칸에 맞춰 축소한다.
const [RDP_WIDTH, RDP_HEIGHT] = RDP_DEFAULT

type Props = {
  profileId: string
  name: string
  onClose: () => void
  /**
   * 다중 모니터 창에서만 온다. 이 크기로 접속하고 해상도 선택은 감춘다 — 창 크기가 모니터 배치로
   * 이미 정해져 있어 사용자가 고를 여지가 없다(`shared/rdpSpan.ts` 가 계산한 값).
   */
  fixedSize?: [number, number]
  /**
   * 다중 모니터 창에서만 온다. 원격에 알릴 모니터 경계(MS-RDPBCGR TS_UD_CS_MONITOR).
   * 이게 있어야 원격이 모니터를 여러 장으로 보고 최대화·작업표시줄이 모니터별로 논다.
   */
  monitorRects?: { left: number; top: number; right: number; bottom: number; primary?: boolean }[]
  /**
   * 접속이 붙은 뒤 한 번 불린다. 다중 모니터 창이 이 캔버스를 모니터별 자식 창에 나눠 그린다
   * (같은 프로세스라 캔버스끼리 직접 복사할 수 있다 — 실측).
   */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void
  /** 다중 모니터 창이 자식 창의 입력을 흘려보낼 통로를 받아 간다. */
  inputBridgeRef?: { current: RdpInputBridge | null }
  /**
   * 접속 단계가 바뀔 때마다. **탭 뷰에서만** 온다 — 칸 머리·탭의 점이 이걸 보고 색을 정한다(#166).
   * 이 통로가 없어서 RDP 는 끊겨도 점이 초록이었다(RdpView 안에만 phase 가 있었다).
   * 다중 모니터 창에는 탭도 칸 머리도 없어 넘기지 않는다(그쪽은 헤더의 글자가 같은 말을 한다).
   */
  onPhase?: (phase: Phase) => void
}

// 단계 이름은 store/sessionState.ts 가 갖는다 — 칸 머리 점이 이 값을 보고 색을 정하므로
// (#166) 두 벌로 갈리면 "끊겼는데 초록"이 다시 생긴다.
type Phase = RdpPhase

/**
 * 다중 모니터 자식 창이 입력을 흘려보내는 통로.
 *
 * 자식 창은 화면만 복사해 보여 주는 껍데기다 — 세션은 이 창 하나가 갖는다. 그래서 자식 창에서
 * 누른 마우스·키는 여기로 와야 한다. 좌표는 **원격 좌표계로 이미 환산해서** 넘긴다(자식 창이
 * 자기 모니터의 슬라이스 원점을 알고 있다).
 */
export type RdpInputBridge = {
  mouse: (kind: 'move' | 'down' | 'up', x: number, y: number, button?: number) => void
  wheel: (deltaY: number, deltaX: number, mode: number) => void
  key: (code: string, pressed: boolean) => void
}

// wasm 모듈·세션에서 우리가 쓰는 부분만 좁게 본다(전체 타입을 끌고 오면 동적 import 와 얽힌다).
// 입력·클립보드에 쓰는 클래스만 Backend 에서 꺼내 이 모양으로 좁힌다.
type RdpMod = {
  InputTransaction: new () => { addEvent(e: never): void }
  ClipboardData: new () => { addText(mime: string, text: string): void }
  DeviceEvent: {
    keyPressed(scancode: number): unknown
    keyReleased(scancode: number): unknown
    mouseButtonPressed(button: number): unknown
    mouseButtonReleased(button: number): unknown
    mouseMove(x: number, y: number): unknown
    wheelRotations(vertical: boolean, amount: number, unit: number): unknown
  }
}
// 파일 전송(MS-RDPECLIP). 청킹·조립·진행률·클립보드 락은 공식 패키지의 RdpFileTransferProvider 가
// 전부 맡는다 — 우리가 하는 일은 "어디서 와서 어디로 가는가"뿐이다.
type RdpFileInfo = { name: string; path?: string; size: number; lastModified: number; isDirectory?: boolean }
type RdpProvider = {
  getBuilderExtensions(): unknown[]
  setSession(s: unknown): void
  on(ev: string, cb: (...a: never[]) => void): void
  downloadFile(f: RdpFileInfo, i: number): { transferId: number; completion: Promise<Blob> }
  uploadFiles(files: unknown[]): unknown
  isUploadInProgress(): boolean
  showFilePicker(o?: { multiple?: boolean }): Promise<File[]>
  handleDrop(e: unknown): Promise<unknown[]>
  handleDragOver(e: unknown): void
  dispose(): void
}

type RdpSession = {
  shutdown?: () => void
  onClipboardPaste?: (data: unknown) => Promise<void>
  applyInputs?: (tx: unknown) => void
  releaseAllInputs?: () => void
  resize?: (w: number, h: number) => void
}

// IronRDP 는 표준 Error 가 아니라 IronError(wasm 객체)를 던진다 — 그대로 문자열화하면
// "[object Object]" 가 되어 원인을 알 수 없다. kind()/backtrace() 를 꺼내 사람이 읽을 문구로 만든다.
const KIND_KEY: Record<number, string> = {
  0: 'rdp.err.general',
  1: 'rdp.err.wrongPassword',
  2: 'rdp.err.logonFailure',
  3: 'rdp.err.accessDenied',
  4: 'rdp.err.cleanPath',
  5: 'rdp.err.proxyConnect',
  6: 'rdp.err.negotiation'
}

/**
 * 원격이 커서 모양을 바꿀 때 호출된다. 인자 형태가 버전마다 조금씩 다를 수 있어 방어적으로 읽는다
 * — 커서 하나 때문에 세션이 끊기면 안 된다.
 *
 * ⚠️ **지금 이 콜백은 한 번도 불리지 않는다**(2026-09-02 제보 "커서가 안 바뀐다" · #167 에서 가름).
 * 원격 탓이 아니다: 클라이언트는 Pointer 캐시를 non-zero 로 광고하므로 서버는 포인터 업데이트를
 * 보내 온다. 버리는 쪽은 **우리가 쓰는 wasm 빌드**다 — `ironrdp-web` 의 `build_config` 가
 * `enable_server_pointer: false` 로 박아 두었고(`TODO(#327): expose these options from the WASM
 * module`), 그 값이 `ActiveStage` 로 내려가 `if (!self.enable_server_pointer) return` 에서
 * 포인터 출력을 통째로 걸러 낸다. JS/TS 쪽에는 그 값을 바꿀 손잡이가 없다(빌더 메서드도, 확장도
 * 없다 — index.d.ts 확인). 고치려면 `vendor/ara-multimonitor.patch` 에 그 한 줄
 * (`enable_server_pointer: true`, `pointer_software_rendering` 은 false 유지)을 더해 wasm 을
 * 다시 빌드해야 한다. 그때까지 아래 본문은 잠들어 있지만 **지우면 안 된다** — 빌더가 이 콜백을
 * 필수로 요구한다(`set_cursor_style_callback missing`).
 */
function cursorStyleCallback(canvas: HTMLCanvasElement) {
  return (style: unknown, data?: unknown, hotspotX?: unknown, hotspotY?: unknown): void => {
    try {
      const kind = typeof style === 'string' ? style : 'default'
      if (kind === 'hidden') canvas.style.cursor = 'none'
      else if (kind === 'url' && typeof data === 'string') {
        const x = typeof hotspotX === 'number' ? hotspotX : 0
        const y = typeof hotspotY === 'number' ? hotspotY : 0
        canvas.style.cursor = `url(${data}) ${x} ${y}, default`
      } else canvas.style.cursor = kind === 'default' ? 'default' : kind
    } catch {
      canvas.style.cursor = 'default'
    }
  }
}

/**
 * wasm 클라이언트 로딩(동적 import + wasm 인스턴스화)만 따로 뗀다.
 *
 * 2026-08-21 준영님 제보 20번("rdp에서 비밀번호 입력해도 Failed to fetch"): 이 단계가 접속 본문과
 * 같은 try 안에 있어서, 실패해도 화면에는 브라우저가 던진 "Failed to fetch" 한 줄만 남았다. 그건
 * **서버 문제가 아니라 앱이 클라이언트를 못 불러온 것**이고(패키지가 wasm 을 base64 data: URL 로
 * 내장하고 fetch 로 읽는다 — index.html 의 CSP connect-src data: 가 그 통로다), 그 구분이 화면에
 * 없으면 원인을 좁힐 수가 없다. 저장된 비밀번호가 없으면 첫 자동 시도는 이 줄에 닿기 전에 입력
 * 화면으로 빠지므로, 준영님이 본 오류는 **입력한 직후 이 단계를 처음 지날 때** 난 것이다.
 */
async function loadRdpClient() {
  // wasm 이 base64 로 내장된 6MB 청크라 필요할 때만 불러온다(앱 첫 로딩을 무겁게 하지 않는다).
  const mod = await import('@devolutions/iron-remote-desktop-rdp')
  // init 이 wasm 인스턴스화까지 한다 — 경로 인자가 없다(내장 data: URL 을 스스로 쓴다).
  // 로그 수준은 error: 접속 실패 원인은 봐야 하고, info 이상은 프레임마다 콘솔을 채운다.
  await mod.init('error')
  return mod
}

function describeRdpError(e: unknown): string {
  if (e instanceof Error) return e.message
  const err = e as { kind?: () => number; backtrace?: () => string }
  if (typeof err?.kind === 'function') {
    let head = t('rdp.err.general')
    try {
      head = t(KIND_KEY[err.kind()] ?? 'rdp.err.general')
    } catch {
      /* wasm 객체가 이미 해제된 경우 */
    }
    let trace = ''
    try {
      trace = err.backtrace?.() ?? ''
    } catch {
      /* backtrace 없음 */
    }
    return trace ? `${head}\n${trace}` : head
  }
  return String(e)
}

export function RdpView({
  profileId,
  name,
  onClose,
  fixedSize,
  monitorRects,
  onCanvasReady,
  inputBridgeRef,
  onPhase
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const relayRef = useRef<string | null>(null)
  /**
   * **이 칸이 이미 사라졌나** — 우리가 끈 것을 원격이 끊었다고 보고하지 않기 위한 래치
   * (2026-09-02 준영님 제보 ④: *"rdp 세션 연결 창을 끌 때 「끄겠습니까?」 팝업이 2번 뜨는 경우"*).
   *
   * 순서가 그렇게 만든다: 탭 ✕ → **팝업 ①** → [종료] → 세션이 목록에서 빠짐 → 이 컴포넌트
   * 언마운트 → cleanup 이 `session.shutdown()` → **그래서** 아래 `await session.run()` 이 돌아옴
   * → 그 자리의 `onClose()` 가 `closeTab` 을 다시 불러 **팝업 ②**. 동시가 아니라 차례로 뜬다 —
   * ①을 확인해야 ②를 만드는 언마운트가 일어나기 때문이다.
   *
   * **왜 RDP 만인가**: 터미널에는 이미 같은 래치가 있다(`closedByUser` + `session.onExit`).
   * RDP 는 pty 가 없어 `onExit` 를 안 타고 자기 콜백으로 따로 올라오는데 **그 갈래에만 규율이
   * 없었다.** R3-5 의 `fired` 래치와 같은 자리다.
   *
   * "두 번째를 무시"가 아니다 — **우리가 만든 종료는 보고하지 않고**, 원격이 먼저 끊었을 때만
   * `onClose()` 한다(그 경우 동작은 그대로다).
   */
  const goneRef = useRef(false)
  // 입력 전달에도 쓰므로 applyInputs 까지 참조에 담는다.
  const sessionRef = useRef<RdpSession | null>(null)
  const modRef = useRef<RdpMod | null>(null)
  // 'connecting' 으로 시작한다 — 첫 시도가 자동이라 'creds' 로 시작하면 저장된 비밀번호가 있어도
  // 입력 폼이 한 프레임 번쩍인다.
  const [phase, setPhase] = useState<Phase>('connecting')
  // 단계를 위로 올린다(#166) — 이 값이 여기 갇혀 있어서 칸 머리 점이 끊겨도 초록이었다.
  useEffect(() => onPhase?.(phase), [phase, onPhase])
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 기본은 "창 크기에 맞춤" — 열자마자 칸을 꽉 채운다(고정 해상도는 고르는 사람만 쓴다).
  const [res, setRes] = useState(t('rdp.res.fit'))
  // Mac 호스트면 자동으로 켠다 — 준영님 요구는 "맥북으로 접속하면 알아서 Windows 배열이 되는 것"이다.
  const [keyMode, setKeyMode] = useState<RdpKeyMode>(() => defaultRdpKeyMode(navigator.userAgent))
  // 전송 상태 한 줄(받기·보내기 공통). null 이면 진행 중인 것이 없다.
  // pct 가 null 이면 진행이 아니라 알림 한 줄이다(클립보드 결과·상한 안내) — 막대를 안 그린다.
  const [xfer, setXfer] = useState<{ label: string; pct: number | null } | null>(null)
  const [dropping, setDropping] = useState(false)
  // 원격 클립보드에 올라온 파일 목록. 버튼은 **항상 있고** 이게 비면 비활성이다 —
  // 원격↔원격 복사마다 버튼이 튀어나오던 게 소음이었다(준영님 지적).
  const [remoteFiles, setRemoteFiles] = useState<RdpFileInfo[]>([])
  // 옵션 메뉴가 열린 자리(뷰포트 좌표). null 이면 닫혀 있다.
  const [optMenu, setOptMenu] = useState<{ x: number; y: number } | null>(null)
  const optBtnRef = useRef<HTMLButtonElement>(null)
  const providerRef = useRef<RdpProvider | null>(null)
  // 클립보드 소유권 추적. announced = 우리가 원격에 마지막으로 알린 것, fromRemote = 원격이 준 것.
  // 이 둘이 없으면 포커스마다 로컬 클립보드를 다시 알려 **원격에서 방금 복사한 것을 덮어쓴다**.
  const announcedRef = useRef<string | null>(null)
  const fromRemoteRef = useRef<string | null>(null)
  // 로컬 파일을 원격에 알린 **전체 경로 목록**의 지문(#205). announcedRef 는 Electron 이 주는 첫 경로
  // 하나로 만든 싼 지문이라 paste 이벤트의 전체 목록과 맞춰 볼 수 없다. 같은 묶음을 두 번 알리면
  // provider 가 앞의 것을 supersede 해 **붙여넣기 중인 전송이 끊긴다** — 그걸 막는 자물쇠다.
  const localFilesRef = useRef<string | null>(null)
  // 원격 파일을 자동으로 받는 중인 수(R15). 0 이 아니면 로컬 클립보드는 아직 **옛 로컬 것**이다 —
  // 포커스·paste 가 그걸 원격에 알리면 원격의 복사를 빼앗는다. 복사가 겹치면 받기도 겹쳐서 수로 센다.
  const receivingRef = useRef(0)
  // 원격이 마지막으로 파일을 복사한 순간의 로컬 클립보드 지문(files-available 주석). paste 이벤트가 이걸
  // 보고 옛 로컬 파일을 원격 안의 Ctrl+V 에 끼워 넣지 않는다. announcedRef 와 따로 두는 이유: 알린 묶음이
  // 실패하면 paste 가 다시 알려야 하는데(provider 'error'), 그 판정까지 이 기록이 막으면 안 된다.
  const seenLocalRef = useRef<string | null>(null)
  // 파일 목록을 알리고 원격의 답(format-list-response)을 기다리는 중인가. 텍스트를 알려도 같은 답이
  // 오므로, 이게 없으면 텍스트의 답이 파일 상태 줄을 덮는다.
  const awaitingAnswerRef = useRef(false)

  // 원격 클립보드에 파일을 **알리는** 한 곳(R15). paste 이벤트·포커스·드롭·[파일 보내기] 넷이 모두 지난다.
  // "알렸다"는 우리가 보냈다는 뜻일 뿐이고 원격이 받아들였는지는 format-list-response 가 말한다 — 그래서
  // 상태 줄을 단계로 남긴다: 알림 → 원격 수락/거절 → 내용 요청(보내는 중 n%) → 보냄. 원격 붙여넣기가
  // 안 될 때 **줄이 어디서 멈췄나**가 원인을 가른다. 오류 신고의 화면 캡처에 이 줄이 실린다.
  const advertise = useCallback((files: unknown[], n: number) => {
    const provider = providerRef.current
    if (!provider) return
    awaitingAnswerRef.current = true
    setXfer({ label: t('rdp.file.announced').replace('{n}', String(n)), pct: null })
    // 마지막에 부른다 — 알리기부터 실패하면 provider 가 곧바로 error 를 쏘는데, 그 줄이 위 줄에 덮이면 안 된다.
    provider.uploadFiles(files)
  }, [])

  // 고른 항목 → 실제 픽셀. 다중 모니터 창에서는 모니터 배치가 크기를 정하므로 라벨을 무시한다.
  const sizeOf = useCallback(
    (label: string): [number, number] => fixedSize ?? resolveSize(label, bodyRef.current),
    [fixedSize]
  )

  // 릴레이·세션 정리는 한 곳에서. 언마운트·오류·닫기가 모두 여기를 지난다.
  const cleanup = useCallback(() => {
    try {
      sessionRef.current?.shutdown?.()
    } catch {
      /* 이미 끝난 세션 */
    }
    sessionRef.current = null
    try {
      providerRef.current?.dispose()
    } catch {
      /* 이미 정리됨 */
    }
    providerRef.current = null
    setRemoteFiles([])
    setXfer(null)
    if (relayRef.current) {
      void window.ev?.rdp.relayStop(relayRef.current)
      relayRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      goneRef.current = true // 우리가 끄는 중이다 — 아래 run() 이 돌아와도 보고하지 않는다
      cleanup()
    },
    [cleanup]
  )

  // 클립보드 파일 → 원격. 진짜 paste 이벤트라 **여러 개가 다 오고 File 핸들이라 스트리밍된다**
  // (예전엔 main 이 바이트를 읽어 올려 총합 64MB 상한이 있었다 — 그 상한이 사라졌다).
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    return registerPasteTarget({
      el,
      onFiles: (files) => {
        const provider = providerRef.current
        if (!provider || files.length === 0) return false
        // 이미 알린 묶음·원격이 가져가는 중인 묶음·우리가 원격에서 받아 올린 파일은 다시 알리지 않는다
        // (shouldUploadPasted 주석). 알리지 않아도 true — 캔버스의 붙여넣기는 원격의 몫이다.
        const paths = filePaths(files)
        const upload = shouldUploadPasted(paths, {
          locked: localFilesRef.current,
          fromRemote: fromRemoteRef.current,
          seen: seenLocalRef.current,
          receiving: receivingRef.current > 0,
          uploading: provider.isUploadInProgress()
        })
        if (!upload) return true
        localFilesRef.current = pathsSig(paths)
        advertise(files, files.length)
        return true
      }
    })
  }, [advertise])

  // 릴레이 쪽 실패는 클라이언트엔 "general error" 로만 보인다 — main 이 올려 주는 실제 사유를
  // 받아 두었다가 오류 화면에 함께 보여준다(이게 없으면 원인을 알 방법이 없다).
  const relayReasonRef = useRef<string | null>(null)
  useEffect(() => {
    const off = window.ev?.rdp.onRelayClosed((e) => {
      if (e.relayId === relayRef.current) relayReasonRef.current = e.reason
    })
    return () => off?.()
  }, [])

  // pw=null 은 "저장된 비밀번호가 있으면 그걸로 붙고, 없으면 입력을 받는다"(첫 시도).
  // 문자열이면 사용자가 방금 입력한 값이다 — 저장값보다 우선한다(저장값이 틀렸을 때의 탈출구).
  const connect = useCallback(
    async (pw: string | null) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const [w, h] = sizeOf(res)
      canvas.width = w
      canvas.height = h
      setPhase('connecting')
      setError(null)
      const relay = await window.ev?.rdp.relay(profileId)
      if (!relay || !relay.ok) {
        setError(relay && !relay.ok ? relay.message : t('rdp.err.relay'))
        setPhase('error')
        return
      }
      relayRef.current = relay.relayId
      // 저장된 것도 입력한 것도 없다 → 입력 화면으로. 릴레이는 로컬 리스너일 뿐이라(서버로는 아직
      // 아무것도 나가지 않았다) 여기서 접고 다시 열어도 원격에 흔적이 남지 않는다.
      const secret = pw ?? relay.password ?? null
      if (secret === null) {
        cleanup()
        setPhase('creds')
        return
      }
      // 클라이언트 로딩 실패는 접속 실패와 구분해서 말한다(제보 20번 — loadRdpClient 주석 참고).
      const mod = await loadRdpClient().catch((e: unknown) => {
        cleanup()
        setError(`${t('rdp.err.client')}\n${describeRdpError(e)}`)
        setPhase('error')
        return null
      })
      if (!mod) return
      try {
        const builder = new mod.Backend.SessionBuilder()
        // 파일 전송 provider — 확장은 connect() **전에** 등록해야 CLIPRDR 채널이 열린다.
        const provider = new mod.RdpFileTransferProvider({ chunkSize: 64 * 1024 }) as unknown as RdpProvider
        providerRef.current = provider
        for (const ext of provider.getBuilderExtensions()) builder.extension(ext as never)
        // 원격이 파일을 복사하면 목록이 올라온다 — 목록만 적어 두고, 받는 것은 아래 자동 받기 effect 가 한다
        // (R15 · 상한 100MB · 폴더 제외. 예전엔 [파일 받기] 를 눌러야 받았다).
        provider.on('files-available', ((files: RdpFileInfo[]) => {
          // 원격이 방금 파일을 복사했다 = 지금 클립보드 주인은 원격이다. 이 순간의 로컬 클립보드는
          // **이미 본 것**으로 적는다 — 예전엔 announcedRef 를 지워서, 자동으로 못 받았을 때(상한·폴더·실패)
          // 캔버스를 누르기만 해도 옛 로컬 파일이 원격 클립보드를 빼앗았다(방금 원격에서 복사한 것이 조용히
          // 사라진다). 이제 로컬 클립보드가 **실제로 바뀐 뒤에만** 다시 알린다. 텍스트의 fromRemoteRef 와 같은 원리다.
          // 대가: 같은 파일을 로컬에서 다시 복사하면 지문이 같아 알아채지 못한다(paste 길의 두 번째 Ctrl+V 가 받는다).
          // 스냅숏은 IPC 한 번 뒤에 적힌다 — 그 틈(수 ms)의 포커스는 옛 기록으로 판정된다.
          localFilesRef.current = null
          void readLocalClip().then(({ sig }) => {
            const rec = afterRemoteCopy(sig)
            announcedRef.current = rec.announced
            seenLocalRef.current = rec.seen
          })
          setRemoteFiles(files)
        }) as never)
        provider.on('download-progress', ((p: { fileName: string; percentage: number }) =>
          setXfer({ label: `${t('rdp.file.receiving')} ${p.fileName}`, pct: p.percentage })) as never)
        provider.on('upload-progress', ((p: { fileName: string; percentage: number }) =>
          setXfer({ label: `${t('rdp.file.sending')} ${p.fileName}`, pct: p.percentage })) as never)
        // 원격의 답 — true=받아들임(CB_RESPONSE_OK), false=거절. 파일을 알리고 기다리던 답일 때만 적는다.
        // ⚠️ 텍스트를 알린 직후 파일을 알리면 텍스트의 답이 파일의 답으로 읽힐 수 있다(드물다 — 둘 다 사용자 동작이다).
        provider.on('format-list-response', ((ok: boolean) => {
          if (!awaitingAnswerRef.current) return
          awaitingAnswerRef.current = false
          setXfer({ label: t(ok ? 'rdp.file.accepted' : 'rdp.file.rejected'), pct: null })
        }) as never)
        provider.on('upload-complete', ((f: File) =>
          setXfer({ label: `${t('rdp.file.sent')} ${f.name}`, pct: null })) as never)
        // 전송 실패는 **상태 줄에** 적는다. 예전엔 setError 로 갔는데 그 글은 오류 화면(phase='error')에서만
        // 보여서, 붙어 있는 동안의 실패(원격 거절 · 60초 안에 요청 없음 · 원격 클립보드 바뀜)가 전부 사라졌다.
        provider.on('error', ((e: { message: string; direction?: string }) => {
          awaitingAnswerRef.current = false
          // 알린 묶음이 죽었다 — 자물쇠를 풀어 다음 Ctrl+V 의 paste 이벤트가 다시 알릴 수 있게 한다. 안 풀면
          // 그 묶음은 다시 복사할 때까지 안 간다(provider 는 실패한 묶음을 retained 로 남기지 않는다).
          if (e.direction === 'upload') localFilesRef.current = null
          setXfer({ label: `${t('rdp.file.xferFail')} ${e.message}`, pct: null })
        }) as never)
        builder.username(relay.username)
        builder.password(secret)
        builder.destination(relay.destination)
        builder.proxyAddress(relay.url)
        // 릴레이가 발급한 1회용 토큰(없으면 클라이언트가 "auth_token missing" 으로 거부한다).
        builder.authToken(relay.token)
        builder.desktopSize(new mod.Backend.DesktopSize(canvas.width, canvas.height))
        builder.renderCanvas(canvas)
        // 아래 콜백들은 선택이 아니라 **필수**다 — 하나라도 없으면 connect() 가
        // "…_callback missing" 으로 즉시 거부한다(빌더가 완전한 구성을 요구한다).
        builder.setCursorStyleCallback(cursorStyleCallback(canvas))
        builder.setCursorStyleCallbackContext(canvas)
        builder.canvasResizedCallback(() => {
          /* 원격이 해상도를 바꾸면 캔버스는 wasm 이 직접 조정한다 — 여기선 할 일이 없다. */
        })
        // 클립보드 양방향. 원격에서 Ctrl+C 를 누르면 이 콜백으로 내용이 올라온다. 반대 방향은 **우리가 먼저
        // 알려 둔 것**만 원격이 붙여넣을 수 있다(CLIPRDR: 형식 목록을 받아 둔 뒤 붙여넣을 때 데이터를 요청한다).
        // forceClipboardUpdate 는 붙여넣을 때마다 오는 요구가 아니라 채널이 준비될 때 "지금 가진 것을 알려
        // 달라"는 한 번이다(업스트림 ironrdp-web 기준 — 우리 패키지는 wasm 이라 여기서 직접 확인하지 못했다).
        // Ctrl+C/V 자체는 그냥 키 입력이라(원격이 처리한다) 여기서 가로챌 것이 없다 — 데이터만 이 채널로 오간다.
        builder.remoteClipboardChangedCallback((data: unknown) => {
          const d = data as { items?: () => { mimeType(): string; value(): unknown }[] }
          if (typeof d?.items !== 'function') return
          let text: string | null = null
          try {
            text = pickClipboardText(d.items())
          } catch {
            return /* wasm 객체가 이미 해제됨 */
          }
          // 텍스트가 없으면 파일 목록만 온 것이다 — files-available 가 처리하므로 여기선 손대지 않는다.
          if (!text) return
          // 원격이 준 것을 로컬에 써 넣는다. 그 지문을 남겨 두지 않으면 다음 포커스에서
          // 이걸 그대로 원격에 되돌려 보내며(에코) 주인이 무의미하게 뒤집힌다.
          fromRemoteRef.current = clipboardSignature({ text })
          // 원격이 주인을 가져갔다 — files-available 와 같은 이유로 우리가 알린 기록을 지운다. 안 지우면
          // 같은 파일을 로컬에서 다시 복사했을 때 "이미 알렸다"로 걸러져 원격에 안 간다(에코는 fromRemote 가 막는다).
          announcedRef.current = null
          localFilesRef.current = null
          // 원격이 이제 텍스트를 들고 있다 = 아까 복사해 둔 파일 목록은 무효다. 안 지우면 탐색기
          // 붙여넣기가 만료된 클립보드 락을 향해 요청하다 조용히 실패한다.
          setRemoteFiles([])
          // main 경유(writeClipboard). 이건 **원격이 밀어 주는** 쓰기라 창이 뒤에 있을 때 오기 쉬운데,
          // navigator.clipboard 는 그때 거부한다 — RDP 에서 복사하고 알트탭한 뒤 붙이면 빈 채였다.
          void writeClipboard(text)
        })
        builder.forceClipboardUpdateCallback(() => {
          // main 경유(readClipboard). 여기가 **로컬→원격 붙여넣기가 죽어 있던 자리**다:
          // `navigator.clipboard.readText()` 는 권한 핸들러가 clipboard-read 를 거절해 늘 실패했고,
          // 그 실패를 빈 `.catch()` 가 삼켰다 — 원격이 요구해도 우리는 아무것도 못 보냈다.
          //
          // #205: 파일이 있으면 파일을 알린다(파일 우선 — clipboardSignature 의 규칙). ⚠️ 이 콜백은 원격이
          // 붙여넣을 때마다 오는 게 아니라 **CLIPRDR 채널이 준비될 때**(접속 직후 · 업스트림 기준) 온다 — 접속 전에 복사해 둔
          // 것을 알리는 자리다. 접속 중의 새 복사는 포커스 동기화(syncClipboardToRemote)가 맡는다.
          void (async () => {
            const paths = (await window.ev.clipboard.readFiles().catch(() => ({ paths: [] as string[] }))).paths
            if (paths.length > 0) return announceLocalFiles(clipboardSignature({ paths }))
            await pushTextToRemote(await readClipboard())
          })()
        })
        // 최신 Windows 서버는 NLA 를 요구한다 — 끄면 접속 자체가 거절된다.
        builder.extension(mod.enableCredssp(true))
        // Display Control 채널. 해상도 드롭다운이 session.resize() 로 접속 중 해상도를 바꾸는데,
        // 이 확장을 켜지 않으면 그 채널이 열리지 않아 조용히 무시된다(옛 패키지는 기본 on 이었다).
        builder.extension(mod.displayControl(true))
        // 다중 모니터 경계(TS_UD_CS_MONITOR). 이게 있어야 원격이 모니터를 여러 장으로 보고
        // 최대화·작업표시줄·창 스냅이 모니터별로 논다. 없으면 큰 화면 한 장으로 본다.
        // 업스트림 패키지에는 이 함수가 없다(vendor/README.md) — 없으면 조용히 건너뛴다.
        if (monitorRects && typeof mod.monitorLayout === 'function') {
          builder.extension(mod.monitorLayout(monitorRects))
        }
        const session = await builder.connect()
        modRef.current = mod.Backend as unknown as RdpMod
        sessionRef.current = session as unknown as RdpSession
        onCanvasReady?.(canvas)
        // provider 는 세션이 생긴 뒤에야 확장을 호출할 수 있다.
        provider.setSession(session)
        canvas.focus()
        setPhase('connected')
        setPassword('') // 화면 상태에도 남기지 않는다.
        await session.run()
        // run() 이 끝나면 원격이 세션을 닫은 것이다 — **다만 우리가 끈 것이 아닐 때만.**
        // 이 칸이 이미 사라졌으면 그 종료는 우리 cleanup 이 만든 것이라 보고하지 않는다(goneRef).
        cleanup()
        if (goneRef.current) return
        /**
         * **끊긴 것을 phase 로도 말한다**(#166). `onClose()` 는 탭을 닫자고 제안할 뿐이고,
         * 종료 확인을 **취소하면 이 칸이 그대로 남는다** — 그때 phase 가 'connected' 로 굳어
         * 있으면 죽은 세션에 초록 점이 붙는다. 준영님이 보신 "끊겨도 초록"의 가장 순수한 자리다.
         * 오류 화면의 [재시도] 가 그대로 재접속 길이 된다(닫았다 다시 열 필요가 없다).
         */
        setError(t('rdp.err.closed'))
        setPhase('error')
        onClose()
      } catch (e) {
        cleanup()
        const head = describeRdpError(e)
        // 릴레이가 남긴 사유가 있으면 그게 진짜 원인이다(클라이언트 문구는 "general error" 뿐).
        const reason = relayReasonRef.current
        setError(reason ? `${head}\n${t('rdp.err.relayReason')}: ${reason}` : head)
        relayReasonRef.current = null
        setPhase('error')
      }
    },
    [profileId, res, sizeOf, cleanup, onClose]
  )

  // 붙기를 기다린 시간(초). 2026-09-02 준영님: *"rdp 연결 중 시간이 걸리면 연결 중이다라는 걸
  // 표시해 주면 좋을 것 같아."* — 문구("연결 중…")는 이미 오버레이에 있었다. 없던 것은 **아직
  // 살아 있다는 신호**다: 한 줄이 가만히 있으면 멈춘 것과 구분이 안 된다.
  //
  // ⚠️ 진행률은 만들지 않는다 — 얼마나 걸릴지 모르면서 채우는 막대는 거짓말이다(BootSplash 규율).
  // 반면 **얼마나 기다렸는지는 사실**이라 그대로 적을 수 있다. 초 단위로만 세고 분으로 안 접는
  // 이유도 같다(`agoText` 는 60초부터 `1m` 으로 굳는데, 그러면 숫자가 멈춰 목적이 사라진다).
  const [waitSec, setWaitSec] = useState(0)
  useEffect(() => {
    if (phase !== 'connecting') return
    setWaitSec(0)
    const id = setInterval(() => setWaitSec((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [phase])

  // 첫 시도는 자동이다 — 저장된 비밀번호가 있으면 탭을 여는 순간 바로 붙고, 없으면 입력 화면이 뜬다.
  // res 등이 바뀌어 connect 신원이 갱신돼도 다시 시도하지 않게 ref 로 한 번만 잠근다.
  const autoTried = useRef(false)
  useEffect(() => {
    if (autoTried.current) return
    autoTried.current = true
    void connect(null)
  }, [connect])

  // 해상도 변경. 접속 중에는 Display Control 채널로 서버에 요청한다 — RDP 8.1 이상 서버만
  // 반응한다(구형 서버는 조용히 무시되고 다음 접속부터 적용된다).
  const pickRes = useCallback(
    (label: string) => {
      setRes(label)
      if (phase !== 'connected') return
      const [w, h] = sizeOf(label)
      try {
        sessionRef.current?.resize?.(w, h)
      } catch {
        /* 세션 종료 중 */
      }
    },
    [phase, sizeOf]
  )

  // 창 맞춤은 **이름 그대로 창을 따라간다.** 접속 시점 크기로 굳으면(RDP 는 접속 시 해상도가 세션
  // 해상도다) 창을 키워도 저해상도가 늘어나 보이는데, 기본값이 된 이상 그대로 둘 수 없다.
  // 숨은 칸(display:none → 0px)에서 붙은 세션이 보이는 순간 제 크기를 찾는 길이기도 하다.
  // 고정 해상도를 고른 사람은 창을 줄여도 그 해상도를 원한 것이므로 건드리지 않는다.
  useEffect(() => {
    const host = bodyRef.current
    if (!host || fixedSize || phase !== 'connected' || fixedResolution(res)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      // 창을 끄는 동안 매 프레임 이벤트가 온다 — 손을 놓은 뒤 한 번만 서버에 요청한다.
      clearTimeout(timer)
      timer = setTimeout(() => {
        const [w, h] = resolveSize(res, bodyRef.current)
        // 실제 원격 해상도(=캔버스)와 같으면 보낼 것이 없다. 구형 서버가 요청을 무시하면 캔버스가
        // 그대로라 다음 크기 변화 때 다시 시도하게 되는데, 그게 맞다(포기하지 않는다).
        const canvas = canvasRef.current
        if (!canvas || (canvas.width === w && canvas.height === h)) return
        try {
          sessionRef.current?.resize?.(w, h)
        } catch {
          /* 세션 종료 중 */
        }
      }, 400)
    })
    ro.observe(host)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [phase, res, fixedSize])

  // 탐색기에서 복사한 파일 → 원격 클립보드(#205). 바이트는 main 이 읽어 준다 — 경로에서 디스크 기반
  // File 을 만들 길이 없어서다. 합계 100MB 를 넘으면 올리지 않고 드래그를 안내한다(드롭은 진짜 File 이다).
  // 실패·초과여도 announcedRef 는 적는다: 같은 클립보드로 포커스마다 PowerShell 을 다시 띄우지 않고,
  // DLP 에 막힌 것을 자동으로 되풀이하지 않는다. 새로 복사하면 지문이 바뀌어 다시 시도된다.
  const announceLocalFiles = useCallback(async (sig: string | null) => {
    announcedRef.current = sig
    const res = await window.ev.rdp
      .clipReadLocal()
      .catch((e: unknown) => ({ ok: false as const, message: String(e), tooBig: undefined }))
    const provider = providerRef.current
    if (!provider) return
    if (!res.ok) {
      setXfer({ label: res.tooBig ? t('rdp.file.tooBig') : `${t('rdp.file.readFail')} ${res.message}`, pct: null })
      return
    }
    if (res.files.length === 0) return
    // 그사이 paste 이벤트가 같은 묶음을 먼저 알렸으면 다시 알리지 않는다(localFilesRef 주석).
    const filesSig = pathsSig(res.files.map((f) => f.path))
    if (filesSig === localFilesRef.current) return
    localFilesRef.current = filesSig
    // 우리가 주인을 가져갔으므로 원격의 파일 목록은 더 이상 유효하지 않다.
    setRemoteFiles([])
    // IPC 로 건너온 Uint8Array 는 타입상 SharedArrayBuffer 일 수도 있어 BlobPart 로 안 받아진다 — 실제로는
    // 구조적 복제가 만든 평범한 ArrayBuffer 다. 드롭이 주는 File 과 모양이 같다(이름·크기·lastModified —
    // provider 의 normalizeToDroppedFiles 가 둘을 같은 DroppedFile 로 편다).
    advertise(
      res.files.map((f) => new File([f.bytes as Uint8Array<ArrayBuffer>], f.name, { lastModified: f.lastModified })),
      res.files.length
    )
  }, [advertise])

  // 로컬 텍스트를 원격에 올린다(조건 없이). 부르는 자리는 둘이다 — 채널이 준비될 때(forceClipboardUpdate)와
  // 포커스 동기화(syncClipboardToRemote). 원격이 붙여넣는 순간에 불리는 경로는 아니다 — 원격은 이미 받아 둔
  // 목록에서 데이터를 요청할 뿐이라, 붙여넣기 **전에** 여기가 한 번 돌아 있어야 한다.
  const pushTextToRemote = useCallback(async (text: string) => {
    const session = sessionRef.current
    const mod = modRef.current
    if (!session?.onClipboardPaste || !mod || !text) return
    try {
      const data = new mod.ClipboardData()
      data.addText('text/plain', text)
      await session.onClipboardPaste(data)
    } catch (e) {
      // ⚠️ **삼키지 않는다.** #165(로컬→원격 붙여넣기가 통째로 죽어 있던 사고) 때 원인이 몇 주간
      // 안 보인 자리가 바로 여기다 — 빈 catch 였고, 채널이 안 열렸을 때 wasm 이 던지는
      // "Clipboard backend error" 가 그대로 사라졌다. 화면은 안 깨고(붙여넣기 하나 때문에 세션을
      // 끊지 않는다) 콘솔에는 반드시 남긴다.
      console.warn('[rdp] 클립보드를 원격에 보내지 못했습니다:', e)
    }
  }, [])

  // 원격 → 로컬. R15 부터 'clip' 은 원격이 복사하면 **자동으로** 받는다(아래 effect · 준영님 결정
  // "mobaxterm 처럼 누르지 않게"). 합계 100MB 를 넘거나 폴더가 섞이면 자동으로 받지 않고 [파일 받기]·
  // [폴더에 저장] 으로 떨어진다(autoReceivePlan). 하나씩 순차로 받는다 — 동시에 받으면 원격 클립보드 락이
  // 만료되며 뒤쪽이 실패한다(패키지 문서의 lock expired 안내).
  //
  // #205 받는 곳이 둘이다:
  //  · 'clip'(기본) — 임시 폴더에 받아 **윈도우 클립보드에 파일로** 올린다 → 탐색기에서 Ctrl+V.
  //    mobaxterm 이 하는 모양이다(다른 개발자 피드백). 폴더 안의 파일(path 가 있는 것)은 뺀다 —
  //    클립보드에 올리려면 폴더 구조를 임시 폴더에 다시 세워 폴더째 올려야 하는데, 그 조립은 아직 없다.
  //    평평하게 펴서 올리면 같은 이름이 부딪히고 구조가 조용히 사라진다. 그건 'dir' 이 한다.
  //  · 'dir' — 저장 폴더를 골라 그 자리에 쓴다(옛 동작 그대로 · 하위 폴더 유지).
  //
  // 실패는 상태 줄에 적는다(예전엔 setError 라 붙어 있는 동안 보이지 않았다 — provider 'error' 주석).
  const receiveFiles = useCallback(async (to: 'clip' | 'dir', list: RdpFileInfo[]) => {
    const provider = providerRef.current
    const files = list.filter((f) => !f.isDirectory && (to === 'dir' || !f.path))
    if (!provider) return
    if (files.length === 0) {
      if (to === 'clip' && list.length > 0) setXfer({ label: t('rdp.file.clipFolder'), pct: null })
      return
    }
    const dir = to === 'dir' ? await window.ev.sftp.pickSaveDir() : null
    if (to === 'dir' && !dir) return
    // 받는 동안 로컬 클립보드는 아직 옛 것이다 — 포커스·paste 가 그걸 원격에 알리지 못하게 잠근다(receivingRef).
    receivingRef.current++
    try {
      const got: { name: string; bytes: Uint8Array }[] = []
      let fail: string | null = null
      for (const f of files) {
        try {
          const blob = await provider.downloadFile(f, list.indexOf(f)).completion
          const bytes = new Uint8Array(await blob.arrayBuffer())
          if (!dir) {
            got.push({ name: f.name, bytes })
            continue
          }
          const res = await window.ev.fs.saveBytes({ dir, sub: f.path, name: f.name, bytes })
          if (!res.ok) {
            fail = res.message
            break
          }
        } catch (e) {
          fail = (e as Error).message
          break
        }
      }
      setRemoteFiles([])
      // 🔴 실패하면 다시 시도하지 않는다 — DLP 가 막았을 수 있다. 사유를 그대로 보인다.
      if (fail !== null) return setXfer({ label: `${t('rdp.file.xferFail')} ${fail}`, pct: null })
      if (dir) return setXfer(null)
      const res = await window.ev.rdp.clipPut(got)
      if (!res.ok) return setXfer({ label: `${t('rdp.file.clipFail')} ${res.message}`, pct: null })
      // 되먹임 고리를 끊는 지문. 방금 우리가 올린 것이 다음 포커스·Ctrl+V 때 "로컬에서 새로 복사한 파일"로
      // 보여 원격에 되돌아가지 않게 한다 — 동기화·paste 두 길이 모두 이 지문(ownFilesSig)으로 맞춰 본다.
      // 자물쇠(receivingRef)를 풀기 **전에** 적는다 — 풀린 뒤 한 틈이라도 지문이 비면 그 틈에 되돌아간다.
      fromRemoteRef.current = ownFilesSig(res.paths)
      setXfer({ label: t('rdp.file.clipped').replace('{n}', String(res.paths.length)), pct: null })
    } finally {
      receivingRef.current--
    }
  }, [])

  // 자동 받기(R15). 원격이 파일을 복사하면(files-available → remoteFiles) 버튼 없이 받아 로컬 클립보드에
  // 올린다. 상한·폴더에 걸리면 받지 않고 한 줄로 알린다 — 그때는 [옵션] 의 [파일 받기]·[폴더에 저장] 이 남는다.
  // 받고 나면 receiveFiles 가 목록을 비우므로 이 effect 는 빈 목록으로 한 번 더 돌고 그냥 끝난다.
  useEffect(() => {
    const plan = autoReceivePlan(remoteFiles)
    if (plan === 'none') return
    if (plan === 'auto') void receiveFiles('clip', remoteFiles)
    else setXfer({ label: t(plan === 'folder' ? 'rdp.file.autoFolder' : 'rdp.file.autoTooBig'), pct: null })
  }, [remoteFiles, receiveFiles])

  // 로컬 → 원격. 여기서 하는 일은 "원격 클립보드에 이 파일들이 있다"고 알리는 것까지다 —
  // 실제 바이트는 사용자가 원격에서 붙여넣을 때 원격이 요청하고 provider 가 조각내 보낸다.
  const sendFiles = useCallback(async () => {
    const provider = providerRef.current
    if (!provider) return
    const picked = await provider.showFilePicker({ multiple: true }).catch(() => [])
    if (picked.length === 0) return
    advertise(picked, picked.length)
  }, [advertise])

  // 로컬 클립보드 → 원격(포커스 시). **정말 바뀐 로컬 복사만** 알린다 — 무조건 알리면 원격에서
  // 방금 복사한 파일을 덮어써서 [원격 파일 받기] 가 깨진다(준영님 질문으로 드러난 실제 결함).
  //
  // RDP 클립보드는 방향별로 하나뿐이고 마지막에 복사한 쪽이 주인이다. 그래서 "로컬 것인지 원격
  // 것인지"를 구분하는 게 아니라, 우리가 주인을 가져갈 자격이 있을 때만(= 로컬에서 새로 복사했을 때만)
  // 알리는 것이 정답이다.
  //
  // #205 파일도 여기서 알린다. 예전엔 진짜 paste 이벤트(registerPasteTarget)에서만 올렸는데, 그러면
  // **첫 Ctrl+V 가 빈손이다**(추론 — 실기 확인 필요): keydown 이 V 스캔코드를 원격에 먼저 보내고 paste
  // 이벤트는 그 뒤에 온다 — 원격은 우리가 파일 목록을 알리기 전에 붙여넣기를 끝낸다. 원격은 붙여넣기
  // **전에** 받은 형식 목록에서만 데이터를 요청하므로, 캔버스로 돌아온 순간(포커스) 알려 둬야 첫 번에 붙는다.
  // PowerShell 은 Electron 의 싼 검사(프로세스 없음)가 "새로 복사한 파일이 있다"고 할 때만 뜬다 —
  // 포커스마다 뜨지 않는다.
  const syncClipboardToRemote = useCallback(async () => {
    if (!sessionRef.current) return
    // 경로만 먼저 읽는다(싸다) — 바이트는 정말 알릴 때만 읽는다.
    const { paths, text, sig } = await readLocalClip()
    if (!shouldAnnounceClipboard(sig, announcedRef.current, fromRemoteRef.current, receivingRef.current > 0)) return

    if (paths.length > 0) return announceLocalFiles(sig)
    await pushTextToRemote(text)
    announcedRef.current = sig
    // 우리가 주인을 가져갔으므로 원격의 파일 목록은 더 이상 유효하지 않다.
    setRemoteFiles([])
  }, [pushTextToRemote, announceLocalFiles])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    const provider = providerRef.current
    setDropping(false)
    if (!provider) return
    e.preventDefault()
    const dropped = await provider.handleDrop(e.nativeEvent as unknown).catch(() => [])
    if (dropped.length === 0) return
    advertise(dropped, dropped.length)
  }, [advertise])

  // 브라우저 이벤트 → RDP 입력. 세션이 붙어 있을 때만 보낸다.
  const sendEvents = useCallback((make: (m: RdpMod) => unknown[]) => {
    const session = sessionRef.current
    const mod = modRef.current
    if (!session || !mod) return
    try {
      const tx = new mod.InputTransaction()
      for (const ev of make(mod)) tx.addEvent(ev as never)
      session.applyInputs?.(tx)
    } catch {
      /* 세션이 방금 끊긴 경우 — 입력 하나 때문에 화면을 깨지 않는다 */
    }
  }, [])

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const p = canvasPoint(canvas, e.clientX, e.clientY)
      sendEvents((m) => [m.DeviceEvent.mouseMove(p.x, p.y)])
    },
    [sendEvents]
  )

  const onMouseButton = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>, pressed: boolean) => {
      const canvas = canvasRef.current
      const button = rdpButtonOf(e.button)
      if (!canvas || button === null) return
      e.preventDefault()
      canvas.focus()
      // 원격은 "지금 커서가 어디인지"를 알아야 클릭 위치가 맞는다 — 이동을 함께 보낸다.
      const p = canvasPoint(canvas, e.clientX, e.clientY)
      sendEvents((m) => [
        m.DeviceEvent.mouseMove(p.x, p.y),
        pressed ? m.DeviceEvent.mouseButtonPressed(button) : m.DeviceEvent.mouseButtonReleased(button)
      ])
    },
    [sendEvents]
  )

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      // deltaMode: 0=픽셀, 1=줄, 2=페이지. 브라우저가 준 단위를 그대로 넘긴다.
      const unit = e.deltaMode === 0 ? 0 : e.deltaMode === 1 ? 1 : 2
      sendEvents((m) => {
        const out: unknown[] = []
        if (e.deltaY !== 0) out.push(m.DeviceEvent.wheelRotations(true, -e.deltaY, unit))
        if (e.deltaX !== 0) out.push(m.DeviceEvent.wheelRotations(false, -e.deltaX, unit))
        return out
      })
    },
    [sendEvents]
  )

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>, pressed: boolean) => {
      // 누름·뗌이 같은 스캔코드여야 원격에서 키가 눌린 채 고착되지 않는다 — 변환은 양쪽 같은 표를 탄다.
      const code = scancodeOf(remapKeyCode(e.code, keyMode))
      if (code === null) return
      // 원격이 받아야 하므로 브라우저·앱 단축키로 새어 나가지 않게 막는다.
      // 단 Ctrl+V 만은 기본 동작을 살린다 — 막으면 brower paste 이벤트가 오지 않아 클립보드
      // 파일을 못 받는다(스캔코드는 아래에서 우리가 따로 보내므로 원격도 Ctrl+V 를 받는다).
      const isPaste = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v'
      if (!isPaste) e.preventDefault()
      e.stopPropagation()
      sendEvents((m) => [pressed ? m.DeviceEvent.keyPressed(code) : m.DeviceEvent.keyReleased(code)])
    },
    [sendEvents, keyMode]
  )

  // 자식 창(다른 모니터)의 입력을 이 세션으로 흘린다. 전송은 기존 sendEvents 한 곳을 그대로 탄다 —
  // 경로가 갈라지면 한쪽만 고쳐지는 사고가 난다.
  useEffect(() => {
    if (!inputBridgeRef) return
    inputBridgeRef.current = {
      mouse: (kind, x, y, button) =>
        sendEvents((m) => {
          if (kind === 'move') return [m.DeviceEvent.mouseMove(x, y)]
          if (button === undefined) return []
          // 클릭 위치를 원격이 알아야 하므로 이동을 함께 보낸다(탭 뷰와 같은 규칙).
          return [
            m.DeviceEvent.mouseMove(x, y),
            kind === 'down' ? m.DeviceEvent.mouseButtonPressed(button) : m.DeviceEvent.mouseButtonReleased(button)
          ]
        }),
      wheel: (deltaY, deltaX, mode) =>
        sendEvents((m) => {
          const out: unknown[] = []
          if (deltaY !== 0) out.push(m.DeviceEvent.wheelRotations(true, -deltaY, mode))
          if (deltaX !== 0) out.push(m.DeviceEvent.wheelRotations(false, -deltaX, mode))
          return out
        }),
      key: (code, pressed) => {
        const sc = scancodeOf(remapKeyCode(code, keyMode))
        if (sc === null) return
        sendEvents((m) => [pressed ? m.DeviceEvent.keyPressed(sc) : m.DeviceEvent.keyReleased(sc)])
      }
    }
    return () => {
      inputBridgeRef.current = null
    }
  }, [inputBridgeRef, sendEvents, keyMode])

  // Alt+Tab·Ctrl+Alt+Del 같은 조합은 Windows·앱이 먼저 가로채 원격까지 오지 않는다 — 버튼으로 보낸다.
  const sendCombo = useCallback(
    (name: keyof typeof KEY_COMBOS) => {
      const codes = KEY_COMBOS[name].map(scancodeOf).filter((c): c is number => c !== null)
      if (codes.length === 0) return
      sendEvents((m) => [
        ...codes.map((c) => m.DeviceEvent.keyPressed(c)),
        ...[...codes].reverse().map((c) => m.DeviceEvent.keyReleased(c))
      ])
      canvasRef.current?.focus()
    },
    [sendEvents]
  )

  // 포커스를 잃으면 눌린 키가 원격에 남는다(Alt+Tab 후 Alt 가 눌린 상태로 고착) — 전부 뗀다.
  const onBlur = useCallback(() => {
    try {
      sessionRef.current?.releaseAllInputs?.()
    } catch {
      /* 세션 종료 중 */
    }
  }, [])

  // 받을 수 있는 것은 파일뿐이다(폴더는 이 경로로 못 내려받는다) — 배지·비활성 판정이 같은 수를 본다.
  const recvCount = remoteFiles.filter((f) => !f.isDirectory).length
  const optionItems = rdpOptionItems({
    connected: phase === 'connected',
    res,
    keyMode,
    recvCount,
    ...(fixedSize ? { fixedSize } : {})
  })

  // 닫으면 포커스를 버튼으로 되돌린다 — 안 그러면 ESC 후 Tab 이 화면 맨 앞부터 다시 돈다.
  // 조합키는 실행 뒤 스스로 캔버스에 포커스를 준다(sendCombo) — 이 다음에 불리므로 그쪽이 이긴다.
  // preventScroll: 다중 모니터 창의 캔버스는 창보다 크고(원격 전체 크기를 잘라 쓴다) 컨테이너가
  // 그것을 감추고 있다 — 스크롤이 일어나면 그만큼 화면이 밀린다.
  const closeOptMenu = useCallback(() => {
    setOptMenu(null)
    optBtnRef.current?.focus({ preventScroll: true })
  }, [])

  const pickOption = (id: string): void => {
    if (id.startsWith('res:')) pickRes(id.slice('res:'.length))
    else if (id.startsWith('keys:')) {
      const m = RDP_KEY_MODES.find((x) => x === id.slice('keys:'.length))
      if (m) setKeyMode(m)
    } else if (id.startsWith('combo:')) sendCombo(id.slice('combo:'.length))
    else if (id === 'recv') void receiveFiles('clip', remoteFiles)
    else if (id === 'recvSave') void receiveFiles('dir', remoteFiles)
    else if (id === 'send') void sendFiles()
  }

  return (
    <div className="rdp-view">
      <div className="rdp-hd">
        {/* 이름·상태는 **다중 모니터 창에만** 둔다(2026-09-01 준영님: "그 하단에 연결됨, 서버 이름은
            필요 없어 보이고"). 탭 뷰에서는 탭(2.0 부터 칸 머리 없음)이 같은 `session.title` 을 이미 적고,
            안 붙은 상태는 본문 오버레이가 더 크게 말한다 — 여기 한 줄은 순전히 중복이었다.
            다중 모니터 창에는 탭도 칸 머리도 없어 여기가 유일한 자리다. */}
        {fixedSize && (
          <>
            <span className="rdp-name">{name}</span>
            <span className="rdp-state">{t(`rdp.state.${phase}`)}</span>
          </>
        )}
        {/* 좁은 창에서 헤더 버튼 여섯이 줄바꿈·잘렸다 — 버튼 하나 + 리스트로 접는다.
            메뉴는 앱의 유일한 메뉴 컴포넌트(ContextMenu)를 그대로 쓴다. 접힌 값은 이 버튼의
            툴팁이 말한다(열지 않고도 지금 해상도·키 배열을 알 수 있어야 한다). */}
        <button
          type="button"
          ref={optBtnRef}
          className="rdp-opt-btn"
          aria-haspopup="menu"
          aria-expanded={optMenu !== null}
          title={`${t('rdp.opt.title')} — ${fixedSize ? resLabel(fixedSize) : res} · ${keyModeLabel(keyMode)}`}
          onClick={(e) => {
            if (optMenu) return setOptMenu(null)
            const r = e.currentTarget.getBoundingClientRect()
            setOptMenu({ x: r.left, y: r.bottom + MENU_GAP })
          }}
        >
          {t('rdp.opt')}
          {/* 원격이 파일을 복사했다는 신호. 접힌 항목의 배지를 버튼으로 끌어올리지 않으면
              "받을 것이 생겼다"를 알 길이 사라진다(버튼 시절 .rf-n 이 하던 일이다). */}
          {recvCount > 0 && <span className="rf-n">{recvCount}</span>}
          <IconChevronDown />
        </button>
        {/* 어느 뷰에도 닫기 버튼을 두지 않는다 — 탭 뷰의 종료는 탭 닫기이고(세션의 홈은 탭이다),
            다중 모니터 창은 2026-09-04 에 테두리를 되찾아 **제목 표시줄의 [X]** 가 그 일을 한다.
            출구가 둘이면 어느 쪽이 무엇을 닫는지가 새 질문이 된다. */}
      </div>
      {/* 메뉴는 헤더 **밖**에 둔다(2026-09-01 — 접히던 헤더 안에 두면 transform 조상 때문에
          position:fixed 가 어긋났다). 헤더는 이제 접히지 않지만, 메뉴가 헤더 상자에 갇히지 않는
          편이 좁은 창에서 안전하다 — 그대로 둔다. */}
      <ContextMenu
        open={optMenu !== null}
        x={optMenu?.x ?? 0}
        y={optMenu?.y ?? 0}
        items={optionItems}
        onPick={(id) => {
          closeOptMenu()
          pickOption(id)
        }}
        onClose={closeOptMenu}
      />
      {xfer && (
        <div className="rdp-xfer">
          <span className="rx-label">{xfer.label}</span>
          {xfer.pct !== null && (
            <>
              <span className="rx-track">
                <span className="rx-fill" style={{ width: `${xfer.pct}%` }} />
              </span>
              <span className="rx-pct">{xfer.pct}%</span>
            </>
          )}
        </div>
      )}
      <div className={'rdp-body' + (dropping ? ' dropping' : '')} ref={bodyRef}>
        <canvas
          ref={canvasRef}
          width={RDP_WIDTH}
          height={RDP_HEIGHT}
          // fit = 창 맞춤(고정 해상도도 다중 모니터도 아닐 때). 그때만 캔버스가 칸을 채운다 —
          // 서버가 해상도 변경 요청을 무시해도 화면이 작은 채로 남지 않는다(제보 ⑤).
          className={
            'rdp-canvas' +
            (phase === 'connected' ? ' on' : '') +
            (!fixedSize && !fixedResolution(res) ? ' fit' : '')
          }
          // 캔버스는 기본적으로 키 이벤트를 못 받는다 — tabIndex 가 있어야 포커스된다.
          tabIndex={0}
          onMouseMove={onMouseMove}
          onMouseDown={(e) => onMouseButton(e, true)}
          onMouseUp={(e) => onMouseButton(e, false)}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={onWheel}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onFocus={() => void syncClipboardToRemote()}
          onDragOver={(e) => {
            if (!providerRef.current) return
            providerRef.current.handleDragOver(e.nativeEvent as unknown)
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => void onDrop(e)}
          onBlur={onBlur}
        />
        {phase !== 'connected' && (
          <div className="rdp-overlay">
            {phase === 'creds' && (
              <form
                className="rdp-creds"
                onSubmit={(e) => {
                  e.preventDefault()
                  void connect(password)
                }}
              >
                <div className="rdp-msg">{t('rdp.creds.msg')}</div>
                {/* 2026-08-21 준영님: 눈 표시로 실제 값을 확인할 수 있어야 한다(연결 관리자와 같은 칸). */}
                <PasswordInput
                  value={password}
                  autoFocus
                  placeholder={t('rdp.creds.password')}
                  ariaLabel={t('rdp.creds.password')}
                  onChange={setPassword}
                />
                <button type="submit" className="rdp-go">
                  {t('rdp.creds.connect')}
                </button>
              </form>
            )}
            {/* 인증 대기·오류와 같은 카드에 담는다 — 이 상태만 맨 줄이라 있는지 없는지 눈에 안
                들어왔다. 초는 1초 뒤부터 붙어서(바로 붙는 접속에는 안 나온다) 줄 높이도 안 흔든다. */}
            {phase === 'connecting' && (
              <div className="rdp-wait">
                <div className="rdp-msg">
                  {t('rdp.state.connecting')}
                  {waitSec > 0 && <span className="rdp-sec">{waitSec}s</span>}
                </div>
              </div>
            )}
            {phase === 'error' && (
              <div className="rdp-err">
                <div className="rdp-msg rdp-trace">{error}</div>
                <button type="button" className="rdp-go" onClick={() => setPhase('creds')}>
                  {t('rdp.retry')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
