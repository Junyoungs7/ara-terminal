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
// 클립보드는 텍스트 양방향으로 연동돼 있다(이미지·파일은 아직).
import { useCallback, useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../store/clipboardWrite'
import { registerPasteTarget } from '../store/pasteFiles'
import { t } from '../i18n'
import { Dropdown } from './Dropdown'
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
  clipboardSignature,
  pickClipboardText,
  remapKeyCode,
  shouldAnnounceClipboard,
  resLabel,
  resolveSize,
  scancodeOf,
  type RdpKeyMode
} from './rdpInput'

// 키 변환 모드 ↔ 드롭다운 라벨(Dropdown 은 문자열만 다룬다 — 해상도와 같은 방식).
const keyModeLabel = (m: RdpKeyMode): string => t(`rdp.keys.${m}`)

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
  /** 탭 뷰에서만 온다. [다중 모니터] 버튼을 헤더에 낸다. */
  onSpan?: () => void
  /** 다중 모니터 창에서만 온다. 헤더에 [닫기] 를 낸다(테두리가 없어 OS 닫기 버튼이 없다). */
  onCloseWindow?: () => void
}

type Phase = 'creds' | 'connecting' | 'connected' | 'error'

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

// 원격이 커서 모양을 바꿀 때 호출된다. 인자 형태가 버전마다 조금씩 다를 수 있어 방어적으로 읽는다
// — 커서 하나 때문에 세션이 끊기면 안 된다.
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
  onSpan,
  onCloseWindow
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const relayRef = useRef<string | null>(null)
  // 입력 전달에도 쓰므로 applyInputs 까지 참조에 담는다.
  const sessionRef = useRef<RdpSession | null>(null)
  const modRef = useRef<RdpMod | null>(null)
  // 'connecting' 으로 시작한다 — 첫 시도가 자동이라 'creds' 로 시작하면 저장된 비밀번호가 있어도
  // 입력 폼이 한 프레임 번쩍인다.
  const [phase, setPhase] = useState<Phase>('connecting')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  // 기본은 "창 크기에 맞춤" — 열자마자 칸을 꽉 채운다(고정 해상도는 고르는 사람만 쓴다).
  const [res, setRes] = useState(t('rdp.res.fit'))
  // Mac 호스트면 자동으로 켠다 — 준영님 요구는 "맥북으로 접속하면 알아서 Windows 배열이 되는 것"이다.
  const [keyMode, setKeyMode] = useState<RdpKeyMode>(() => defaultRdpKeyMode(navigator.userAgent))
  // 전송 상태 한 줄(받기·보내기 공통). null 이면 진행 중인 것이 없다.
  const [xfer, setXfer] = useState<{ label: string; pct: number } | null>(null)
  const [dropping, setDropping] = useState(false)
  // 원격 클립보드에 올라온 파일 목록. 버튼은 **항상 있고** 이게 비면 비활성이다 —
  // 원격↔원격 복사마다 버튼이 튀어나오던 게 소음이었다(준영님 지적).
  const [remoteFiles, setRemoteFiles] = useState<RdpFileInfo[]>([])
  const providerRef = useRef<RdpProvider | null>(null)
  // 클립보드 소유권 추적. announced = 우리가 원격에 마지막으로 알린 것, fromRemote = 원격이 준 것.
  // 이 둘이 없으면 포커스마다 로컬 클립보드를 다시 알려 **원격에서 방금 복사한 것을 덮어쓴다**.
  const announcedRef = useRef<string | null>(null)
  const fromRemoteRef = useRef<string | null>(null)

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

  useEffect(() => cleanup, [cleanup])

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
        provider.uploadFiles(files)
        setXfer({ label: t('rdp.file.announced').replace('{n}', String(files.length)), pct: 100 })
        return true
      }
    })
  }, [])

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
        // 원격이 파일을 복사하면 목록이 올라온다 — 바로 받지 않고 헤더에 버튼만 띄운다
        // (사용자가 원격에서 Ctrl+C 했다고 로컬 디스크에 파일이 쏟아지면 안 된다).
        provider.on('files-available', ((files: RdpFileInfo[]) => {
          // 원격이 방금 파일을 복사했다 = 지금 클립보드 주인은 원격이다. 우리가 알렸던 기록은
          // 무효가 됐으므로 지운다(로컬에서 새로 복사하면 그때 다시 알려 주인을 되찾는다).
          announcedRef.current = null
          setRemoteFiles(files)
        }) as never)
        provider.on('download-progress', ((p: { fileName: string; percentage: number }) =>
          setXfer({ label: `${t('rdp.file.receiving')} ${p.fileName}`, pct: p.percentage })) as never)
        provider.on('upload-progress', ((p: { fileName: string; percentage: number }) =>
          setXfer({ label: `${t('rdp.file.sending')} ${p.fileName}`, pct: p.percentage })) as never)
        provider.on('error', ((e: { message: string }) => {
          setXfer(null)
          setError(e.message)
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
        // 클립보드 양방향. 원격에서 Ctrl+C 를 누르면 이 콜백으로 내용이 올라오고, 원격이 붙여넣기를
        // 하려 할 때 forceClipboardUpdate 로 우리 것을 요구한다. Ctrl+C/V 자체는 그냥 키 입력이라
        // (원격이 처리한다) 여기서 가로챌 것이 없다 — 데이터만 이 채널로 오간다.
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
          // 원격이 이제 텍스트를 들고 있다 = 아까 복사해 둔 파일 목록은 무효다. 안 지우면 탐색기
          // 붙여넣기가 만료된 클립보드 락을 향해 요청하다 조용히 실패한다.
          setRemoteFiles([])
          // main 경유(writeClipboard). 이건 **원격이 밀어 주는** 쓰기라 창이 뒤에 있을 때 오기 쉬운데,
          // navigator.clipboard 는 그때 거부한다 — RDP 에서 복사하고 알트탭한 뒤 붙이면 빈 채였다.
          void writeClipboard(text)
        })
        builder.forceClipboardUpdateCallback(() => {
          void navigator.clipboard
            ?.readText()
            .then((t) => pushTextToRemote(t))
            .catch(() => {})
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
        // run() 이 끝나면 원격이 세션을 닫은 것이다.
        cleanup()
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

  // 로컬 텍스트를 원격에 올린다(조건 없이). 원격이 붙여넣기를 하려고 우리에게 내용을 요구할 때
  // (forceClipboardUpdate) 쓰는 경로 — 그때는 원격이 이미 우리를 주인으로 알고 묻는 것이다.
  const pushTextToRemote = useCallback(async (text: string) => {
    const session = sessionRef.current
    const mod = modRef.current
    if (!session?.onClipboardPaste || !mod || !text) return
    try {
      const data = new mod.ClipboardData()
      data.addText('text/plain', text)
      await session.onClipboardPaste(data)
    } catch {
      /* 세션이 방금 끊긴 경우 — 클립보드 하나 때문에 화면을 깨지 않는다 */
    }
  }, [])

  // 원격 → 로컬은 **다운로드**다(붙여넣기가 아니다 — 방향 규칙을 한 가지로 통일했다).
  // 저장 위치를 직접 고르게 하는 것도 그 규칙의 일부다. 하나씩 순차로 받는다 — 동시에 받으면
  // 원격 클립보드 락이 만료되며 뒤쪽이 실패한다(패키지 문서의 lock expired 안내).
  const receiveFiles = useCallback(async () => {
    const provider = providerRef.current
    const files = remoteFiles.filter((f) => !f.isDirectory)
    if (!provider || files.length === 0) return
    const dir = await window.ev.sftp.pickSaveDir()
    if (!dir) return
    for (const f of files) {
      try {
        const blob = await provider.downloadFile(f, remoteFiles.indexOf(f)).completion
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const res = await window.ev.fs.saveBytes({ dir, sub: f.path, name: f.name, bytes })
        if (!res.ok) {
          setError(res.message)
          break
        }
      } catch (e) {
        setError((e as Error).message)
        break
      }
    }
    setXfer(null)
    setRemoteFiles([])
  }, [remoteFiles])

  // 로컬 → 원격. 여기서 하는 일은 "원격 클립보드에 이 파일들이 있다"고 알리는 것까지다 —
  // 실제 바이트는 사용자가 원격에서 붙여넣을 때 원격이 요청하고 provider 가 조각내 보낸다.
  const sendFiles = useCallback(async () => {
    const provider = providerRef.current
    if (!provider) return
    const picked = await provider.showFilePicker({ multiple: true }).catch(() => [])
    if (picked.length === 0) return
    provider.uploadFiles(picked)
    setXfer({ label: t('rdp.file.announced').replace('{n}', String(picked.length)), pct: 100 })
  }, [])

  // 로컬 클립보드 → 원격(포커스 시). **정말 바뀐 로컬 복사만** 알린다 — 무조건 알리면 원격에서
  // 방금 복사한 파일을 덮어써서 [원격 파일 받기] 가 깨진다(준영님 질문으로 드러난 실제 결함).
  //
  // RDP 클립보드는 방향별로 하나뿐이고 마지막에 복사한 쪽이 주인이다. 그래서 "로컬 것인지 원격
  // 것인지"를 구분하는 게 아니라, 우리가 주인을 가져갈 자격이 있을 때만(= 로컬에서 새로 복사했을 때만)
  // 알리는 것이 정답이다.
  const syncClipboardToRemote = useCallback(async () => {
    if (!sessionRef.current) return
    // 경로만 먼저 읽는다(싸다) — 바이트는 정말 알릴 때만 읽는다.
    const paths = (await window.ev.clipboard.readFiles().catch(() => ({ paths: [] as string[] }))).paths
    const text = paths.length === 0 ? ((await navigator.clipboard?.readText().catch(() => '')) ?? '') : ''
    const sig = clipboardSignature({ paths, text })
    if (!shouldAnnounceClipboard(sig, announcedRef.current, fromRemoteRef.current)) return

    // 파일은 여기서 올리지 않는다 — 위 registerPasteTarget 이 진짜 paste 에서 받는다.
    // 여기서는 "원격이 우리 것을 요구할 때 줄 텍스트"만 준비한다.
    if (paths.length > 0) return
    await pushTextToRemote(text)
    announcedRef.current = sig
    // 우리가 주인을 가져갔으므로 원격의 파일 목록은 더 이상 유효하지 않다.
    setRemoteFiles([])
  }, [pushTextToRemote])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    const provider = providerRef.current
    setDropping(false)
    if (!provider) return
    e.preventDefault()
    const dropped = await provider.handleDrop(e.nativeEvent as unknown).catch(() => [])
    if (dropped.length === 0) return
    provider.uploadFiles(dropped)
    setXfer({ label: t('rdp.file.announced').replace('{n}', String(dropped.length)), pct: 100 })
  }, [])

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

  return (
    <div className="rdp-view">
      <div className="rdp-hd">
        <span className="rdp-name">{name}</span>
        <span className="rdp-state">{t(`rdp.state.${phase}`)}</span>
        {fixedSize ? (
          // 다중 모니터 창: 크기는 모니터 배치가 정한다 — 고를 여지가 없으니 값만 보여 준다.
          <span className="rdp-res fixed" title={t('rdp.span.fixed')}>
            {resLabel(fixedSize)}
          </span>
        ) : (
          <span className="rdp-res" title={t('rdp.res.title')}>
            <Dropdown
              value={res}
              options={[...RDP_RESOLUTIONS.map(resLabel), t('rdp.res.fit')]}
              onChange={pickRes}
              ariaLabel={t('rdp.res.title')}
            />
          </span>
        )}
        <span className="rdp-keys" title={t('rdp.keys.title')}>
          <Dropdown
            value={keyModeLabel(keyMode)}
            options={RDP_KEY_MODES.map(keyModeLabel)}
            onChange={(v) => setKeyMode(RDP_KEY_MODES.find((m) => keyModeLabel(m) === v) ?? 'off')}
            ariaLabel={t('rdp.keys.title')}
          />
        </span>
        {phase === 'connected' && (
          <span className="rdp-files">
            <button
              type="button"
              disabled={remoteFiles.filter((f) => !f.isDirectory).length === 0}
              onClick={() => void receiveFiles()}
              title={t('rdp.file.recv.title')}
            >
              {t('rdp.file.recv')}
              {remoteFiles.filter((f) => !f.isDirectory).length > 0 && (
                <span className="rf-n">{remoteFiles.filter((f) => !f.isDirectory).length}</span>
              )}
            </button>
            <button type="button" onClick={() => void sendFiles()} title={t('rdp.file.send.title')}>
              {t('rdp.file.send')}
            </button>
          </span>
        )}
        {phase === 'connected' && (
          <span className="rdp-combos">
            <button type="button" onClick={() => sendCombo('ctrlAltDel')} title={t('rdp.combo.ctrlAltDel')}>
              Ctrl+Alt+Del
            </button>
            <button type="button" onClick={() => sendCombo('altTab')} title={t('rdp.combo.altTab')}>
              Alt+Tab
            </button>
            <button type="button" onClick={() => sendCombo('win')} title={t('rdp.combo.win')}>
              Win
            </button>
          </span>
        )}
        {onSpan && (
          <button type="button" className="rdp-span-btn" onClick={onSpan} title={t('rdp.span.title')}>
            {t('rdp.span')}
          </button>
        )}
        {/* 탭 뷰에는 닫기 버튼을 두지 않는다 — 종료는 탭 닫기로 통일한다(세션의 홈은 탭이다).
            다중 모니터 창은 테두리가 없어 OS 닫기 버튼이 없으므로 여기가 유일한 출구다. */}
        {onCloseWindow && (
          <button type="button" className="rdp-span-close" onClick={onCloseWindow} title={t('rdp.span.close.title')}>
            {t('rdp.span.close')}
          </button>
        )}
      </div>
      {xfer && (
        <div className="rdp-xfer">
          <span className="rx-label">{xfer.label}</span>
          <span className="rx-track">
            <span className="rx-fill" style={{ width: `${xfer.pct}%` }} />
          </span>
          <span className="rx-pct">{xfer.pct}%</span>
        </div>
      )}
      <div className={'rdp-body' + (dropping ? ' dropping' : '')} ref={bodyRef}>
        <canvas
          ref={canvasRef}
          width={RDP_WIDTH}
          height={RDP_HEIGHT}
          className={'rdp-canvas' + (phase === 'connected' ? ' on' : '')}
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
            {phase === 'connecting' && <div className="rdp-msg">{t('rdp.state.connecting')}</div>}
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
