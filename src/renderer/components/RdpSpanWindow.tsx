// 다중 모니터 RDP 창의 알맹이. 앱 렌더러를 해시(#rdpwin)로 갈라 쓴다(EditorWindow 와 같은 방식).
//
// 이 창은 **창이 있는 전체화면**이다(2026-09-04). 전에는 테두리 없이 모니터를 통째로 덮었고, 나갈
// 길이 없어 헤더를 캔버스 위에 띄워 두고 마우스를 맨 위로 올려야 나오게 했다 — 그 자리가 원격
// 브라우저의 제목 표시줄과 같아 준영님이 "잡기 힘들다"고 하셨다. 이제 진짜 제목 표시줄이 있으므로
// 헤더는 **늘 보이는 한 줄**로 자리를 차지한다(mstsc 의 고정한 연결 막대와 같다).
//
// 헤더가 자리를 차지하면 그만큼 원격 화면이 짧아진다 — 그 높이(SPAN_HEADER_H)는 main 이 계획을
// 세울 때 이미 빼 놓았다(shared/rdpSpan.ts). 여기서 CSS 로 높이를 바꾸면 그 계산이 어긋난다.
//
// 나가는 길: 제목 표시줄의 [X] · Alt+F4 · Alt+Tab 으로 비켜 두기(kiosk 가 아니라 OS 가 처리한다).
import { useCallback, useEffect, useRef, useState } from 'react'
import { RdpView } from './RdpView'
import type { SpanMonitor, SpanPlan } from '@shared/rdpSpan'
import { openMirror, type MirrorHandle } from '../store/rdpMirror'
import type { RdpInputBridge } from './RdpView'

/** 원격에 알릴 모니터 사각형(공식 패키지의 monitorLayout 이 받는 모양). */
type MonitorRect = { left: number; top: number; right: number; bottom: number; primary?: boolean }

const monitorRectsOf = (plan: SpanPlan): MonitorRect[] =>
  plan.monitors.map((m) => ({ ...m.rdp, primary: m.primary }))

export type RdpSpanTarget = { profileId: string; name: string; size: [number, number]; monitors: number }

/**
 * `#rdpwin?profile=..&name=..&w=..&h=..&monitors=..` 를 읽는다. 형식이 아니면 null(= 보통 앱 창).
 * 순수 함수 — 단위 테스트 대상이다(잘못 읽으면 창이 0x0 으로 접속을 시도한다).
 */
export function parseRdpWinHash(hash: string): RdpSpanTarget | null {
  if (!hash.startsWith('#rdpwin?')) return null
  const q = new URLSearchParams(hash.slice('#rdpwin?'.length))
  const profileId = q.get('profile') ?? ''
  const w = Number(q.get('w'))
  const h = Number(q.get('h'))
  if (!profileId || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  const monitors = Number(q.get('monitors'))
  return {
    profileId,
    name: q.get('name') ?? '',
    size: [Math.round(w), Math.round(h)],
    monitors: Number.isFinite(monitors) && monitors > 0 ? Math.round(monitors) : 1
  }
}

export function RdpSpanWindow({ target }: { target: RdpSpanTarget }): JSX.Element {
  // 모니터별 좌표. main 이 창을 열 때 계산해 둔 것을 받아 온다 — 없으면(구버전·경합) 경계 없이
  // 큰 화면 한 장으로 붙는다. 접속을 막지는 않는다.
  const [rects, setRects] = useState<MonitorRect[] | null>(null)
  const [planReady, setPlanReady] = useState(false)
  // 이 창이 덮는 모니터(= 주 모니터)와 나머지. 나머지는 자식 창으로 하나씩 연다.
  const [host, setHost] = useState<SpanMonitor | null>(null)
  const othersRef = useRef<SpanMonitor[]>([])
  const mirrorsRef = useRef<MirrorHandle[]>([])
  const bridgeRef = useRef<RdpInputBridge | null>(null)

  useEffect(() => {
    let alive = true
    void window.ev?.rdp
      .spanPlan(target.profileId)
      .then((r) => {
        if (!alive) return
        setRects(r.plan ? monitorRectsOf(r.plan) : null)
        if (!r.plan) return
        const primary = r.plan.monitors.find((m) => m.primary) ?? r.plan.monitors[0] ?? null
        setHost(primary)
        othersRef.current = primary ? r.plan.monitors.filter((m) => m.id !== primary.id) : []
      })
      .finally(() => alive && setPlanReady(true))
    return () => {
      alive = false
    }
  }, [target.profileId])

  useEffect(() => {
    document.title = target.name
  }, [target.name])

  // 접속이 붙으면 나머지 모니터마다 창을 연다. 자식 창은 이 캔버스를 잘라 보여 주는 껍데기고,
  // 세션·입력은 전부 이 창이 갖는다(store/rdpMirror.ts).
  const onCanvasReady = useCallback(
    (canvas: HTMLCanvasElement) => {
      for (const h of mirrorsRef.current) h.stop()
      mirrorsRef.current = othersRef.current
        .map((m) => openMirror(canvas, m, bridgeRef, target.name))
        .filter((h): h is MirrorHandle => h !== null)
    },
    [target.name]
  )

  // 이 창이 닫히면 자식 창도 함께 닫는다 — 남으면 세션 없는 정지 화면이 모니터를 덮고 있게 된다.
  // (OS 쪽에서 닫히면 이 정리가 안 돈다 — main 도 같은 일을 한다. rdp/RdpWindows.ts 의 kids)
  useEffect(
    () => () => {
      for (const h of mirrorsRef.current) h.stop()
      mirrorsRef.current = []
    },
    []
  )

  const close = useCallback(() => {
    for (const h of mirrorsRef.current) h.stop()
    mirrorsRef.current = []
    void window.ev?.rdp.closeSpan(target.profileId)
  }, [target.profileId])

  return (
    <div className="rdp-span">
      {/* 계획을 받기 전에는 RdpView 를 만들지 않는다 — RDP 는 접속 시점 구성이 세션 구성이라,
          경계 없이 붙어 버리면 되돌리는 길이 재접속뿐이다. 기다림은 IPC 한 번(수 ms)이다. */}
      {planReady && (
        <div
          className="rdp-span-slice"
          // 캔버스는 원격 전체 크기다. 이 창은 자기 모니터 몫만 보여 준다 — 컨테이너로 잘라 내고
          // 캔버스를 음수만큼 밀어 그 구역이 창 왼쪽 위에 오게 한다(복사 없이 공짜로 잘린다).
          style={host ? ({ '--sx': `${-host.slice.x}px`, '--sy': `${-host.slice.y}px` } as React.CSSProperties) : undefined}
        >
          <RdpView
            profileId={target.profileId}
            name={target.name}
            fixedSize={target.size}
            {...(rects ? { monitorRects: rects } : {})}
            inputBridgeRef={bridgeRef}
            onCanvasReady={onCanvasReady}
            onClose={close}
          />
        </div>
      )}
    </div>
  )
}
