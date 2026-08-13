import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiskUsage, HostStats, RemoteStats } from '@shared/types'
import { parseDf } from '@shared/remoteCatalog'

// F29 시스템 모니터 — 두 탭([로컬] / [현재 패널])이 쓰는 시계열 버퍼와 구독.
//
// 왜 히스토리를 여기서 들고 있나: main 은 "지금 값" 하나만 밀어 준다(상태바 게이지가 그거면 충분했다).
// 그래프는 지난 값이 있어야 그려지는데, 그걸 main 에 쌓으면 패널을 안 열어도 메모리를 먹는다.
// 패널이 열려 있는 동안 렌더러가 들고 있다가 닫으면 버린다 — 영속화하지 않는다(재시작하면 처음부터).

/** 표본 상한. 2.5초 간격이므로 60개 = 최근 2.5분. 그래프 폭에 비해 이보다 촘촘해도 눈에 안 보인다. */
export const HISTORY_MAX = 60

export type Sample = { cpuPct: number; memPct: number; gpuPct?: number }

/** 링버퍼 한 칸 밀어넣기. 상한을 넘으면 **가장 오래된 것부터** 버린다(그래프가 왼쪽으로 흐른다). */
export function pushSample(list: readonly Sample[], s: Sample, max: number = HISTORY_MAX): Sample[] {
  const next = [...list, s]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 0 나눗셈 방어 — 메모리 총량이 0 으로 오는 환경(파싱 실패)에서 NaN 이 그래프를 깨뜨리지 않게. */
export function memPctOf(usedKb: number, totalKb: number): number {
  if (!Number.isFinite(totalKb) || totalKb <= 0) return 0
  return Math.min(100, Math.round((usedKb / totalKb) * 100))
}

export function sampleOf(s: RemoteStats | HostStats): Sample {
  const gpu = (s as RemoteStats).gpuPct
  return {
    cpuPct: Math.max(0, Math.min(100, Math.round(s.cpuPct))),
    memPct: memPctOf(s.memUsedKb, s.memTotalKb),
    ...(typeof gpu === 'number' ? { gpuPct: Math.max(0, Math.min(100, Math.round(gpu))) } : {})
  }
}

/**
 * 표본 목록 → SVG polyline 의 points 문자열. 값은 0~100, 왼쪽이 과거.
 * 표본이 하나뿐이면 선이 안 그려지므로 같은 값을 양 끝에 둔다(빈 그래프보다 낫다).
 */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length === 0) return ''
  const vs = values.length === 1 ? [values[0]!, values[0]!] : values
  const step = w / (vs.length - 1)
  return vs.map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1)}`).join(' ')
}

/** 가상 파일시스템은 숨긴다 — F26 디스크 창과 같은 규칙(파서는 안 걸러 주고 화면이 정한다). */
const VIRTUAL_FS = /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|devpts|cgroup)/i
export function realDisks(list: readonly DiskUsage[], types?: readonly (string | undefined)[]): DiskUsage[] {
  return list.filter((d, i) => !VIRTUAL_FS.test(types?.[i] ?? '') && d.totalKb > 0)
}

/** 내 PC 통계 구독. 패널이 열려 있는 동안만 폴러가 돈다. */
export function useHostStats(active: boolean) {
  const [stats, setStats] = useState<HostStats | null>(null)
  const [history, setHistory] = useState<Sample[]>([])

  useEffect(() => {
    if (!active) return
    const off = window.ev?.sys?.onData((s) => {
      setStats(s)
      setHistory((h) => pushSample(h, sampleOf(s)))
    })
    void window.ev?.sys?.start().catch(() => {})
    return () => {
      off?.()
      void window.ev?.sys?.stop().catch(() => {})
    }
  }, [active])

  // 패널을 닫으면 버린다 — 다시 열면 처음부터 그린다(오래된 값으로 "지금"을 그리지 않는다).
  useEffect(() => {
    if (!active) {
      setHistory([])
      setStats(null)
    }
  }, [active])

  return { stats, history }
}

/**
 * 이미 흐르고 있는 stats 스트림을 시계열로 쌓는다(원격·로컬 세션 공통).
 * 새 구독을 만들지 않는 것이 핵심이다 — 상태바 게이지가 쓰는 그 값을 그대로 받아 적는다.
 * 대상 세션이 바뀌면 버린다: 이전 서버의 곡선을 새 서버 그래프에 이어 붙이면 거짓말이 된다.
 */
export function useStatsHistory(stats: RemoteStats | null, sessionId: string | null, active: boolean) {
  const [history, setHistory] = useState<Sample[]>([])
  useEffect(() => {
    setHistory([])
  }, [sessionId, active])
  useEffect(() => {
    if (!active || !stats) return
    setHistory((h) => pushSample(h, sampleOf(stats)))
  }, [stats, active])
  return history
}

/**
 * 원격(현재 패널) 시계열. CPU·메모리·GPU 는 이미 흐르고 있는 telemetry:data 를 그대로 쓴다
 * (새 폴러를 만들지 않는다 — 상태바 게이지와 같은 구독이다). 호출측이 stats 를 넘긴다.
 *
 * 디스크만 따로다: telemetry 폴링(2.5초)에 df 를 얹으면 무겁고, 디스크는 초 단위로 변하지 않는다.
 * F26 카탈로그의 disk.usage 를 느린 주기로 직접 부른다 — 파서(parseDf)도 그쪽 것을 재사용한다.
 */
export const REMOTE_DISK_MS = 30_000

export function useRemoteDisks(sessionId: string | null, isSsh: boolean, active: boolean) {
  const [disks, setDisks] = useState<DiskUsage[]>([])
  const aliveRef = useRef(true)

  const read = useCallback(() => {
    if (!sessionId || !isSsh) return
    void window.ev?.remote
      ?.run(sessionId, 'disk.usage')
      .then((r) => {
        if (!aliveRef.current || !r?.ok) return
        const rows = parseDf(r.out)
        setDisks(
          rows
            .filter((d) => !VIRTUAL_FS.test(d.type) && d.totalKb > 0)
            .map((d) => ({ mount: d.mount, totalKb: d.totalKb, usedKb: d.usedKb, usePct: d.usePct }))
        )
      })
      .catch(() => {})
  }, [sessionId, isSsh])

  useEffect(() => {
    aliveRef.current = true
    setDisks([])
    if (!active || !sessionId || !isSsh) return
    read()
    const t = setInterval(read, REMOTE_DISK_MS)
    return () => {
      aliveRef.current = false
      clearInterval(t)
    }
  }, [active, sessionId, isSsh, read])

  return { disks, refresh: read }
}
