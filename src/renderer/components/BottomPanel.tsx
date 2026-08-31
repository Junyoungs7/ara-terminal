import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { t } from '../i18n'
import { IconClose } from './icons'
import { BOTTOM_IDS, type BottomId } from '@shared/types'
import { holdTermResize } from '../terminal/resizeGate'

// #78(2026-08-15) — 터미널 **아래** 패널.
//
// 왜 만들었나: 우측 레일 여섯 중 절반이 **가로가 필요한 표**였다 — 포트 목록은 주소·포트·프로세스
// 3열을 280px 에, 세션 기록은 로그 한 줄을 340px 에 욱여넣고 있었다. 그래서 같은 성격의
// 프로세스·서비스 표는 아예 레일을 포기하고 **떠 있는 창**으로 빠져나갔다(서버 콘솔) —
// 같은 문제를 서로 다른 두 방법으로 푼 셈이고, 그 결과 창 종류가 셋이 됐다.
//
// 하단은 **세로만 먹는다.** 터미널 80칸에 영향이 없어서 우측 레일과 같이 열어도 된다
// (레일이 하나만 열리는 #79 규칙은 우측에만 적용된다).
//
// **IntelliJ 툴윈도우 방식(2026-08-17 준영님 정정).**
//   "우측 사이드바 하단에 하단바 아이콘을 만들어주고, 그걸 클릭하면 하단바를 사용하고
//    그 하단바에 이 기능 버튼들을 탭으로 만들어달라는거였어."
//
// 하루 동안 두 번 잘못 짚었다. 처음엔 도구 여덟을 상태바 아이콘으로 흩었고(→ 같은 목록이
// 화면에 두 번), 그다음엔 탭줄을 아예 상주시켰다(→ 하단바를 끌 수 없게 됐다).
// 원하신 구조는 **토글 하나 + 그 안의 탭**이다:
//
//   · 액티비티 바 맨 아래 [하단바] 아이콘 = 하단바를 켜고 끈다.
//   · 켜면 이 패널이 뜨고, 도구 여덟이 그 안에서 **탭**으로 갈린다.
//   · 끄면 탭줄까지 통째로 사라진다 — 안 쓰는 사람의 화면에는 아무것도 없다.
//
// 탭은 **내용을 바꾼다**(끄지 않는다). 끄는 자리는 그 아이콘과 이 패널의 [×] 둘이다.

const LABEL: Record<BottomId, string> = {
  monitor: 'sidebar.tab.monitor',
  sys: 'sysm.title',
  // #84: 서버 콘솔에서 내려온 표 다섯. 라벨은 런치패드 타일과 같은 키를 쓴다 — 같은 것을
  // 두 이름으로 부르면 "런치패드의 그 프로세스"와 "하단의 이 프로세스"가 달라 보인다.
  ps: 'console.tool.ps',
  svc: 'console.tool.svc',
  disk: 'console.tool.disk',
  pkg: 'console.tool.pkg',
  ctr: 'console.tool.ctr',
  k8s: 'console.tool.k8s',
  log: 'log.title',
  applog: 'applog.title'
}

/**
 * 가장 낮췄을 때 남는 높이 = **탭 줄만**. 2026-08-22 준영님 제보 14번: "하단 바를 아래로 쭉
 * 내리면 포트 모니터·시스템 모니터 등 해당 탭바만 보이게까지 내릴 수 있게." 예전 120px 은
 * 표 두어 줄이 억지로 남는 어정쩡한 높이였다 — 접을 거면 탭만 남기고 접는 게 낫다.
 * (--row-tabbar 32 + 아래 테두리 1 + 여유 1)
 */
const MIN_H = 34
const DEFAULT_H = 260
/**
 * 끌어 올릴 때 **위에 남길 여백**. 2026-08-22 준영님 제보 5번("하단바를 내리면 탭 아래까지
 * 내릴 수 있도록"): 예전 값이 200px 이라 터미널이 늘 그만큼 남아, 표를 크게 보려면 [최대화]를
 * 눌러 전부 덮는 수밖에 없었다(그 사이 크기가 없었다).
 * 타이틀바(36) + 탭바(32) + 여유 — 탭이 가려지지 않을 만큼만 남긴다. 그 아래로는 사용자가 정한다.
 */
const MIN_ABOVE = 76

type Props = {
  /** 열린 탭. null 이면 하단바 자체가 꺼져 있다(이 컴포넌트가 아무것도 그리지 않는다). */
  tab: BottomId | null
  /** 탭 클릭 = 그 도구로 갈아탄다(끄는 것은 액티비티 바의 [하단바] 토글과 이 패널의 [×]). */
  onTab: (id: BottomId) => void
  onClose: () => void
  /**
   * #84: 보여 줄 탭과 그 순서. 액티비티 바의 항목 설정(순서·숨김)을 그대로 받는다 —
   * 여덟 탭이 좁으면 설정에서 안 쓰는 것을 끄면 된다(하단만의 새 설정을 만들지 않는다).
   * 지금 열려 있는 탭은 숨겨져 있어도 그린다 — 보고 있는 것이 갑자기 사라지면 안 된다.
   */
  ids?: readonly BottomId[]
  /** 지금 보고 있는 서버 이름(SSH 세션일 때만). 하단이 어느 서버 것인지 늘 보이게 한다. */
  server?: string
  /**
   * 잠깐 강조할 탭(2026-08-26). 아라가 "여기 보세요" 하고 연 자리를 **눈이 찾을 수 있게** 한다 —
   * 패널만 조용히 열리면 사용자는 답만 읽고 화면이 바뀐 걸 모른다.
   */
  flash?: BottomId | null
  /**
   * 탭별 내용. **한 번 연 탭은 마운트를 유지**하고 숨기기만 한다(#87 ⑤, 2026-08-16) —
   * 프로세스 표를 정렬·검색해 놓고 로그를 잠깐 봤다 오면 처음부터인 것이 실제로 거슬렸다.
   * 떠 있는 창 시절에는 그렇게 했었다(#74). 안 보이는 탭이 원격에 명령을 보내지 않는 것은
   * `active` 로 막는다 — 그 계약이 있어서 마운트를 유지해도 안전하다.
   */
  children: (tab: BottomId, active: boolean) => ReactNode
}

export function BottomPanel({ tab, onTab, onClose, ids, server, flash, children }: Props): JSX.Element | null {
  // 높이는 세션 수명 동안만 산다(우측 레일·떠 있는 창과 같은 규칙 — 레이아웃 설정이 아니다).
  const [h, setH] = useState(DEFAULT_H)
  // #87 ④: 최대화 토글. 표를 크게 볼 때마다 경계를 끄는 것은 번거롭다(떠 있는 창에는 있던 것).
  const [maxed, setMaxed] = useState(false)
  // #87 ⑤: 한 번이라도 연 탭. 상태(검색어·정렬·경로)를 지키려고 마운트를 유지한다.
  const openedRef = useRef<BottomId[]>([])
  const hRef = useRef(h)
  hRef.current = h

  /** 지금 붙들고 있는 게이트. 끄는 도중 이 컴포넌트가 사라져도 풀 수 있게 밖에 둔다(아래 참고). */
  const heldRef = useRef<(() => void) | null>(null)
  useEffect(() => () => heldRef.current?.(), [])

  /**
   * 위쪽 경계를 끌어 높이 조절. 조작감은 사이드바 `.sb-resizer` 와 같다 — 다만 **포인터 캡처**를
   * 쓴다(2026-08-31 준영님 제보).
   *
   * 예전에는 `window` 의 mousedown/mouseup 짝으로 게이트를 붙들었다. 그런데 `mouseup` 은
   * **OS 가 마우스 캡처를 뺏어 가면 영영 안 온다**(Alt+Tab·알림·UAC·화면 잠금 — Chromium 은
   * 그때 mouseup 을 지어내지 않는다). 한 번만 그러면 `held` 가 1 에 눌러앉아 그때부터
   * **열려 있는 모든 터미널이 다시는 안 맞춰진다** — 앱을 껐다 켜야 낫는 영구 고장이고,
   * 증상은 프롬프트가 하단바 밑으로 내려가 안 보이는 것이다.
   *
   * `setPointerCapture` 는 커서가 창 밖으로 나가도 이 요소로 이벤트를 계속 보내 주고, 놓는 순간
   * `lostpointercapture` 를 준다. **재서 확인했다**(Electron 38 / Chromium, CDP 실입력):
   *   놓기 → `pointerdown → GOTCAPTURE → pointermove(요소 밖에서도) → pointerup → LOSTCAPTURE`
   * 다만 **캡처 요소가 DOM 에서 사라지면 `lostpointercapture` 가 안 온다**(같은 실측) — 그래서
   * 위 `heldRef` 언마운트 cleanup 은 여벌이 아니라 **없으면 새는 자리**다. OS 가 캡처를 통째로 뺏는
   * 경우(Alt+Tab·UAC·잠금)도 이벤트가 온다는 보장이 없어 `window` 의 `blur` 를 하나 더 깐다 —
   * 일찍 풀려서 손해 보는 것은 그 드래그 한 번의 프레임뿐이고, 늦게(=영영) 안 풀리면 앱을
   * 껐다 켜야 한다. 실패는 싼 쪽으로 기울인다.
   * 캡처를 **먼저** 잡고 그다음에 붙드는 순서라, `setPointerCapture` 가 던져도 게이트는 안 샌다.
   *
   * ⚠ 하네스 주의: Electron 의 `webContents.sendInputEvent` 가 만드는 포인터는 `pointerType` 이
   * 비어 있어 **캡처가 안 잡힌다**(실측). 이 손잡이를 검사로 끌려면 Playwright 의 `page.mouse`
   * (CDP `Input.dispatchMouseEvent`)를 써야 한다 — 합성 `MouseEvent` 로는 아예 시작도 안 된다.
   *
   * `.sb-resizer`(사이드바)는 mouse 로 남긴다: 게이트를 붙들지 않아 mouseup 을 놓쳐도 터미널이
   * 망가지지 않고(`.resizing` 클래스가 남을 뿐), 스모크가 위 방식(합성 `MouseEvent`)으로 그쪽을
   * 끈다(`tests/smoke-boot.cjs`) — 같이 바꾸면 이 라운드가 릴리스 하네스까지 건드리게 된다.
   */
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const y0 = e.clientY
    const h0 = hRef.current
    el.setPointerCapture(e.pointerId)
    // 하단바가 터미널을 **밀어내므로**(2026-08-22) 끄는 동안 터미널 높이가 매 프레임 바뀐다.
    // 그때마다 xterm 을 다시 맞추면 분할 칸 수만큼 곱해진다 — 놓을 때 한 번만 흘린다.
    const release = holdTermResize()
    heldRef.current = release
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return
      // 위로 끌면 커진다. 터미널이 아주 얇아지지 않게 위쪽 여백을 남긴다.
      const next = h0 + (y0 - ev.clientY)
      setH(Math.max(MIN_H, Math.min(window.innerHeight - MIN_ABOVE, next)))
    }
    const end = (): void => {
      release() // 두 번 불려도 안전하다(holdTermResize 가 released 로 막는다)
      heldRef.current = null
      el.removeEventListener('pointermove', move)
      el.removeEventListener('lostpointercapture', end)
      window.removeEventListener('blur', end)
    }
    // 캡처 중에는 이 포인터의 이벤트가 전부 el 로 온다 — window 에 걸 이유가 없다.
    el.addEventListener('pointermove', move)
    el.addEventListener('lostpointercapture', end)
    window.addEventListener('blur', end)
  }, [])

  // 한 번이라도 연 탭 — 접어도 목록에서 빼지 않는다. 마운트를 유지해 상태(검색어·정렬·경로)를 지킨다.
  if (tab && !openedRef.current.includes(tab)) openedRef.current = [...openedRef.current, tab]

  if (!tab) return null

  // 설정이 없으면 전부(기본 순서). 열린 탭이 숨김 목록에 있어도 그 탭만은 남긴다.
  const base = ids ?? BOTTOM_IDS
  const shownIds = base.includes(tab) ? base : [tab, ...base]

  return (
    // 2026-08-22: 하단바가 터미널을 **밀어낸다**(덮지 않는다 — 가려서 프롬프트가 안 보였다).
    // 경계를 끄는 동안의 리플로우는 resizeGate 가 막는다(startResize 참고).
    <div className={'bottom-panel' + (maxed ? ' maxed' : '')} style={maxed ? undefined : { height: h }}>
      <div className="bp-resizer" role="separator" title={t('bottom.resize')} onPointerDown={startResize} />
      <div className="bp-tabs" role="tablist" aria-label={t('bottom.label')}>
        {/* 탭만 스크롤한다(2026-08-16). `.bp-tabs` 통째로 overflow 를 걸면 **닫기 버튼까지**
            스크롤 밖으로 밀려나 탭이 많을 때 패널을 못 닫는다 — 서버명·최대화·닫기는 밖에 남긴다.
            이 div 가 flex:1 이라 옛 .sb-tab-spacer 역할도 겸한다. */}
        <div className="bp-tabscroll">
          {shownIds.map((id) => (
            <button
              key={id}
              type="button"
              className={'bp-tab' + (id === tab ? ' on' : '') + (id === flash ? ' flash' : '')}
              role="tab"
              aria-selected={id === tab}
              data-bottom={id}
              onClick={() => onTab(id)}
            >
              {t(LABEL[id])}
            </button>
          ))}
        </div>
        {/* #84·#91: 하단은 **지금 세션의 서버**를 따라간다(여기에 서버 선택 UI 는 없다).
            그러면 어느 서버 것인지가 화면에 남아야 한다 — 세션 탭을 보고 유추하게 두면
            "이 프로세스 목록이 어느 서버였지"가 된다(작업대 창은 제목줄에 늘 찍는다). */}
        {server && <span className="con-srv bp-srv">{server}</span>}
        {/* 최대화는 닫기와 **다른 클래스**여야 한다(bp-max). 처음에 bp-close 를 돌려 썼더니
            `.bottom-panel .bp-close` 로 닫던 e2e 세 개가 최대화를 눌러 버렸다 — 모양이 같다고
            이름을 같이 쓰면, 그 이름으로 무언가를 고르는 쪽이 조용히 엉뚱한 것을 집는다. */}
        <button
          type="button"
          className="bp-max"
          title={t(maxed ? 'explorer.restore' : 'explorer.maximize')}
          onClick={() => setMaxed((v) => !v)}
        >
          {/* 크기는 `.bp-max svg`(13px)가 정한다 — §8.4 "SVG 태그에 px 를 박지 않는다". */}
          {maxed ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button type="button" className="bp-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      {/* #87 ⑤: 연 적 있는 탭을 전부 그리되 보이는 것 하나만 남긴다(나머지는 display:none).
          active=false 인 탭은 폴링을 멈춘다 — 그 계약이 마운트 유지의 전제다.
          접혀 있으면 본문 자체를 안 그린다 — 그때는 모든 탭이 active=false 라 폴링도 없다. */}
      <div className="bp-body">
        {openedRef.current.map((id) => (
          <div key={id} className="bp-pane" style={id === tab ? undefined : { display: 'none' }}>
            {children(id, id === tab)}
          </div>
        ))}
      </div>
    </div>
  )
}
