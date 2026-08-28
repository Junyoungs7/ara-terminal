import { useCallback, useEffect, useRef, useState } from 'react'
import type { PortForward, RemotePort, RemoteStats } from '@shared/types'

// W1 F9/F10 원격 텔레메트리 단일 구독. [모니터] 탭(포트 목록)과 상태바 게이지가 같은 이벤트를 쓰므로
// 구독은 여기 한 곳이다 — 두 곳에서 start 하면 폴링이 두 벌 돈다.
//
// 구독 대상은 활성 세션 하나(SSH·로컬 공통 — FB-0008: 로컬 CPU/메모리 게이지도 같은 경로로 받는다).
// 세션을 바꾸면 이전 세션은 stop 되고(그쪽 폴링 중지) 새 세션이 start 된다. 포트·포워딩은 SSH 전용이라
// isSsh 로 따로 가른다(로컬 세션엔 그 개념이 없다 — main 이 telemetry:data 에 항상 ports:[] 를 채워 보낸다).
export function useTelemetry(sessionId: string | null, isSsh: boolean) {
  const [ports, setPorts] = useState<RemotePort[]>([])
  const [stats, setStats] = useState<RemoteStats | null>(null)
  // 첫 한 바퀴가 돌아왔는가. 빈 배열 하나로는 "아직 안 왔다"와 "정말 없다"를 가를 수 없어서
  // 포트 목록이 마운트 즉시 "리슨 중인 포트가 없습니다"라고 거짓말을 했다(2026-08-28 감사 ②).
  // 세션을 바꾸면 다시 false 로 — 새 서버의 첫 바퀴도 기다려야 한다.
  const [loaded, setLoaded] = useState(false)
  // F8 활성 포워딩. push 채널을 만들지 않는다 — 아래 텔레메트리 틱에 얹어 따라오게 하고,
  // 생성·해제 직후에는 refreshForwards 로 즉시 한 번 더 읽는다(2.5초를 기다리지 않게).
  const [forwards, setForwards] = useState<PortForward[]>([])
  const aliveRef = useRef(true)

  const refreshForwards = useCallback(() => {
    void window.ev?.forward
      ?.list()
      .then((list) => {
        if (aliveRef.current) setForwards(list)
      })
      // 하네스(forward:* 미배선)에서는 목록 없이 나머지가 그대로 동작한다.
      .catch(() => {})
  }, [])

  useEffect(() => {
    aliveRef.current = true
    setPorts([])
    setStats(null)
    setForwards([])
    setLoaded(false)
    if (!sessionId) return
    const off = window.ev?.telemetry.onData(sessionId, (d) => {
      setLoaded(true)
      setPorts(d.ports)
      // 파싱 실패(비리눅스 등)로 stats 가 없어도 포트 목록은 그대로 둔다.
      if (d.stats) setStats(d.stats)
      if (isSsh) refreshForwards()
    })
    // 하네스(telemetry 미배선)에서 unhandled rejection 이 나지 않게 삼킨다.
    void window.ev?.telemetry.start(sessionId).catch(() => {})
    if (isSsh) refreshForwards()
    return () => {
      aliveRef.current = false
      off?.()
      void window.ev?.telemetry.stop(sessionId).catch(() => {})
    }
  }, [sessionId, isSsh, refreshForwards])

  // 수동 새로고침 — 전용 채널로 "지금 한 바퀴"만 부른다. 예전엔 start 를 다시 불렀는데,
  // 2026-08-21 에 start 가 **참조 계수**를 갖게 되면서(창 둘이 한 세션을 함께 본다) 그 방식은
  // 새로고침할 때마다 참조를 하나씩 흘린다 — 그러면 창을 다 닫아도 폴러가 안 멎는다.
  const refresh = useCallback(() => {
    if (sessionId) void window.ev?.telemetry.refresh(sessionId).catch(() => {})
    if (isSsh) refreshForwards()
  }, [sessionId, isSsh, refreshForwards])

  return { ports, stats, loaded, forwards, refresh, refreshForwards }
}
