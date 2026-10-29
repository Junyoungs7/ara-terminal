import { useEffect, useState } from 'react'
import type { ConnectionProfile, HostStats, RemoteStats } from '@shared/types'
import { parseOverview, type Overview } from '@shared/remoteCatalog'
import type { UpdateState } from '@shared/ipc'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { t } from '../i18n'
import { sparkArea, sparkPoints, useHostStats, type Sample } from '../store/sysMonitor'
import { updateSeg } from '../store/updateNotify'

// 하단 상태바 (design-system §4.1).
//
// R4.2: `호스트: localhost` 하드코딩을 활성 세션 실데이터로 바꾼다. 수집 로직은 새로 만들지 않는다 —
// SSH 는 serverKey(=프로필명)로 찾은 프로필의 user@host:port + 연결 상태(useProfiles.conn),
// 로컬은 세션 이름 + OSC7 cwd(F7 에서 이미 추적 중인 값)를 그대로 표시만 한다.
// 클릭 동작은 넣지 않는다(범위 밖) — 표시 전용 바다.

/**
 * W1 F10: 원격 리소스 게이지 한 칸.
 *
 * 2026-08-18(제보 ③): `series` 가 붙었다 — 막대 하나로는 "지금 40%"만 알고 **올라가는 중인지
 * 내려가는 중인지**를 모른다. 서버를 보는 사람이 실제로 알고 싶은 건 그 방향이다.
 * 값은 하단 [시스템 모니터]와 **같은 이력**을 나눠 쓴다(폴러도 이력도 두 벌이 아니다).
 */
export type Gauge = { key: 'cpu' | 'mem' | 'gpu'; pct: number; text: string; series: number[] }

export type StatusModel = {
  // 좌측 첫 칸. dot 은 SSH 연결 상태(로컬·유휴는 없음).
  primary: string
  dot: ConnState[string] | null
  cwd: string | null
  idle: boolean
  // 텔레메트리가 들어왔을 때만 채워진다(SSH=원격 /proc 폴링, FB-0008: 로컬=os 모듈 폴링 — 표시는 같은 모양).
  gauges: Gauge[]
}

// 스파크라인 뷰박스(상태바 한 줄 안에 들어가는 크기 — CSS 가 실제 px 을 정한다).
const SPARK_W = 60
const SPARK_H = 14

const KB_PER_GIB = 1024 * 1024
const gib = (kb: number): string => (kb / KB_PER_GIB).toFixed(1)

/**
 * 원격 리소스 → 게이지 목록(순수). GPU 는 nvidia-smi 가 있는 서버에서만 온다.
 *
 * `history` 는 하단 [시스템 모니터]가 쓰는 그 시계열이다. 없으면(아직 한 바퀴도 안 돌았으면)
 * 현재 값 하나로 채운다 — 선이 한 점이라도 있어야 자리가 안 흔들린다.
 */
export function gaugesOf(stats: RemoteStats | null, history: readonly Sample[] = []): Gauge[] {
  if (!stats) return []
  const series = (pick: (s: Sample) => number | undefined, now: number): number[] => {
    const vs = history.map(pick).filter((v): v is number => typeof v === 'number')
    return vs.length > 0 ? vs : [now]
  }
  const cpu = stats.cpuPct
  const out: Gauge[] = [
    { key: 'cpu', pct: cpu, text: `${cpu}%`, series: series((x) => x.cpuPct, cpu) }
  ]
  if (stats.memTotalKb > 0) {
    const pct = Math.round((stats.memUsedKb / stats.memTotalKb) * 100)
    out.push({
      key: 'mem',
      pct,
      text: `${gib(stats.memUsedKb)}/${gib(stats.memTotalKb)}G`,
      series: series((x) => x.memPct, pct)
    })
  }
  if (stats.gpuPct !== undefined) {
    const gpu = stats.gpuPct
    out.push({ key: 'gpu', pct: gpu, text: `${gpu}%`, series: series((x) => x.gpuPct, gpu) })
  }
  return out
}

/** 값이 없는 칸 — 자리는 그대로 두고 이것만 찍는다(칸 폭이 흔들리지 않게). */
export const NA = '—'

/** 가동 시간 짧은 표기(시안 Z-final `12d 3h`). 못 읽었으면 —. */
export function uptimeShort(sec: number | null | undefined): string {
  if (sec == null) return NA
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

/**
 * Windows 빌드 번호 → 기능 업데이트 이름. os.release() 는 `10.0.22631` 처럼 빌드만 주고 "23H2" 를 안 준다.
 * 표에 없는 새 빌드는 가장 가까운 아래 이름 대신 **빌드 번호**를 찍는다(틀린 이름보다 낫다).
 */
const WIN_BUILDS: ReadonlyArray<[number, string]> = [
  [26200, '11 25H2'],
  [26100, '11 24H2'],
  [22631, '11 23H2'],
  [22621, '11 22H2'],
  [22000, '11 21H2'],
  [19045, '10 22H2'],
  [19044, '10 21H2'],
  [19043, '10 21H1'],
  [19042, '10 20H2'],
  [19041, '10 2004']
]

/** 내 PC OS 짧은 표기(상태바 OS 칸). platform·release 는 main 의 process.platform·os.release(). */
export function osLabel(platform: string, release: string): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2])
    if (!Number.isFinite(build)) return 'Windows'
    const hit = WIN_BUILDS.find(([b]) => b === build)
    if (hit) return `Windows ${hit[1]}`
    return `Windows ${build >= 22000 ? '11' : '10'} (${build})`
  }
  if (platform === 'darwin') {
    // Darwin 20 = macOS 11, 이후 한 단씩.
    const major = Number(release.split('.')[0])
    return major >= 20 ? `macOS ${major - 9}` : 'macOS'
  }
  return release ? `Linux ${release.split('-')[0]}` : 'Linux'
}

/** 내 PC 이름 칸 — `계정@호스트`. 계정을 못 읽었으면 호스트만. */
export function localPrimary(h: HostStats): string {
  return h.user ? `${h.user}@${h.hostname}` : h.hostname
}

/**
 * 2.0 상태바의 OS·가동 칸 — **활성 탭 기준.** SSH 면 그 서버(작업대 개요와 같은 `sys.overview` 한 번),
 * 로컬 탭이거나 세션이 없으면 내 PC(다듬기 R3 — 시스템 모니터와 같은 sys:data 폴러). 못 읽었으면 —.
 */
export function hostFacts(session: Session | null, ov: Overview | null, host: HostStats | null = null): { os: string; uptime: string } {
  if (session?.type === 'ssh') return { os: ov?.distro || NA, uptime: uptimeShort(ov?.uptimeSec) }
  if (!host) return { os: NA, uptime: NA }
  return { os: osLabel(host.platform, host.osRelease), uptime: uptimeShort(host.uptimeSec) }
}

/** 창이 보이는지 — 숨거나 최소화되면 Chromium 이 visibilityState 를 hidden 으로 바꾼다(ExplorerWindow 와 같은 규칙). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

/**
 * 눌리는 버전 칸의 class. tone 이 없으면(평소 — 누르면 확인) 색 열쇠를 안 단다 — 예전엔 `upd null` 이 찍혔다.
 * 좁은 창에서 버전 칸을 접는 규칙의 예외는 tone 이 있을 때만이다(shell.css `.sb-seg.ver.upd.<tone>`).
 */
export function verSegClass(tone: 'available' | 'downloading' | 'ready' | null): string {
  return 'sb-seg ver upd' + (tone ? ' ' + tone : '')
}

/** 개요를 못 읽었을 때 다시 묻기까지(다듬기 R2, 리뷰 B8). 접속 직후 셸이 덜 떴을 때 한 번 실패하곤 한다. */
export const OVERVIEW_RETRY_MS = 1500

/**
 * 서버 개요를 읽는다 — 실패하면 **한 번만** 다시 묻는다(그래도 못 읽으면 null → 칸은 —).
 * 예전엔 한 번 실패하면 그 세션 동안 OS·가동 칸이 내내 — 였다(리뷰 B8).
 */
export async function loadOverview(
  run: () => Promise<{ ok: boolean; out?: string } | undefined>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Overview | null> {
  for (let i = 0; i < 2; i++) {
    if (i > 0) await wait(OVERVIEW_RETRY_MS)
    const r = await run().catch(() => undefined)
    if (r?.ok) return parseOverview(r.out ?? '')
  }
  return null
}

/**
 * SSH 세션의 서버 개요(배포판·가동 시간). 폴링하지 않는다 — 배포판은 안 변하고 가동 시간은 일·시
 * 단위라(ServerOverview 와 같은 판단) **세션이 바뀔 때 한 번** 읽는다. 세션별로 기억해 탭을 오가도 다시 안 읽는다.
 * **연결된 뒤에만** 묻는다 — 접속 중에 물으면 실패가 정해져 있다.
 */
function useOverview(session: Session | null, connected: boolean): Overview | null {
  const [cache, setCache] = useState<Record<string, Overview>>({})
  const id = session?.type === 'ssh' ? session.id : null
  useEffect(() => {
    if (!id || !connected || cache[id]) return
    let alive = true
    void loadOverview(() => window.ev?.remote?.run(id, 'sys.overview') ?? Promise.resolve(undefined)).then((ov) => {
      if (alive && ov) setCache((c) => ({ ...c, [id]: ov }))
    })
    return () => {
      alive = false
    }
  }, [id, connected, cache])
  return id ? (cache[id] ?? null) : null
}

// 활성 세션 → 상태바에 찍을 값(순수 — 단위 테스트 대상).
// 다듬기 R3: `host`(내 PC)가 오면 세션이 없을 때도·로컬 탭에서도 `계정@호스트` + 내 PC 게이지를 찍는다.
// SSH 탭은 그대로 그 서버다.
export function statusModel(
  session: Session | null,
  profile: ConnectionProfile | undefined,
  conn: ConnState,
  cwd: string | null,
  stats: RemoteStats | null = null,
  history: readonly Sample[] = [],
  host: HostStats | null = null,
  hostHistory: readonly Sample[] = []
): StatusModel {
  if (!session) {
    if (host) return { primary: localPrimary(host), dot: null, cwd: null, idle: true, gauges: gaugesOf(host, hostHistory) }
    return { primary: t('statusbar.idle'), dot: null, cwd: null, idle: true, gauges: [] }
  }
  if (session.type === 'ssh') {
    // 프로필을 못 찾는 경우(삭제된 프로필의 살아 있는 세션)는 서버 그룹 키로 폴백한다.
    const primary = profile ? `${profile.username}@${profile.host}:${profile.port}` : session.serverKey
    return { primary, dot: (profile && conn[profile.id]) || 'connected', cwd, idle: false, gauges: gaugesOf(stats, history) }
  }
  // FB-0008: 로컬 세션도 게이지를 받는다(내 PC의 CPU/메모리) — gaugesOf 는 stats 가 없으면 그냥 빈 배열.
  if (host) return { primary: localPrimary(host), dot: null, cwd, idle: false, gauges: gaugesOf(host, hostHistory) }
  return { primary: session.title, dot: null, cwd, idle: false, gauges: gaugesOf(stats, history) }
}

export function StatusBar({
  version,
  session,
  profile,
  conn,
  cwd,
  sessionCount,
  stats = null,
  history = [],
  children,
  update = null,
  onUpdateAction
}: {
  version: string
  session: Session | null
  profile: ConnectionProfile | undefined
  conn: ConnState
  cwd: string | null
  sessionCount: number
  // W1 F10 / FB-0008: 활성 세션의 리소스(SSH=원격 폴링, 로컬=내 PC 폴링). 없으면 게이지 칸이 통째로 빠진다.
  stats?: RemoteStats | null
  /** 제보 ③: 게이지를 그래프로 그리는 데 쓰는 시계열(하단 [시스템 모니터]와 같은 이력). */
  history?: readonly Sample[]
  // W4 F23: MCP "AI 조종 중" 인디케이터. 다른 세그먼트 앞(sb-right 맨 앞)에 얹는다 — 자체 상태를
  // 들고 있는 컴포넌트라 여기서는 슬롯만 내준다(다른 게이지처럼 props 로 값을 받지 않는다).
  children?: React.ReactNode
  // 2026-08-17 준영님 제보 ③: 하단 도구 여덟을 여는 아이콘 줄(BottomDock). **맨 오른쪽 끝**이라
  // children(McpIndicator)과 같은 슬롯에 넣을 수 없어 자리를 따로 둔다.
  dock?: React.ReactNode
  /**
   * #98 업데이트 상태(2026-09-04). **새 칸을 만들지 않는다** — 아래 버전 칸이 이미 버전 이야기를
   * 하는 자리라 그 자리가 바뀐다. 안 주면 예전처럼 `v{version}` 만 보인다(떼어낸 창이 그 경우다:
   * main 이 `update:state` 를 본창으로만 보낸다).
   */
  update?: UpdateState | null
  /** 위 칸을 눌렀을 때. `ready` 의 확인 받기는 호출측(runUpdateAction)이 한다. */
  onUpdateAction?: (action: 'download' | 'install' | 'check') => void
}) {
  // 다듬기 R3: 로컬 탭·세션 없음이면 내 PC 를 켜자마자 보여 준다. 창이 숨거나 최소화되면 구독을 끊어
  // 폴러가 멈춘다(main 이 구독자를 센다 — 시스템 모니터 [로컬] 탭과 같은 폴러를 나눠 쓴다).
  const visible = usePageVisible()
  const local = !session || session.type === 'local'
  const host = useHostStats(local && visible)
  const m = statusModel(session, profile, conn, cwd, stats, history, local ? host.stats : null, host.history)
  const facts = hostFacts(session, useOverview(session, m.dot === 'connected'), local ? host.stats : null)
  const u = updateSeg(update ?? null, version)
  // 2.0 4단계: 라벨 없는 값 위주(시안 Z-final) — 호스트·인코딩·버전 칸의 라벨을 뺐다. 선택자(.lbl·.val)는 그대로.
  const verBody = <span className="val">{u.text}</span>
  const gauge = (key: Gauge['key']) => m.gauges.find((g) => g.key === key)
  const cpu = gauge('cpu')
  return (
    <div className="statusbar">
      <div className={'sb-seg host' + (m.idle ? ' idle' : '')}>
        {m.dot && <span className={'sb-dot ' + m.dot} />}
        <span className="val">{m.primary}</span>
      </div>
      {/* 2.0: 활성 탭 기준 서버 정보 — 칸은 늘 같은 자리에 서고, 값이 없으면 — 만 찍는다(시안 Z-final).
          세션이 없을 때는 내 PC 를 말한다(다듬기 R3) — 경로 칸만 뺀다(셸이 없으니 경로도 없다).
          내 PC 값이 아직 안 왔으면(첫 표본 전) 예전처럼 유휴 한 칸만. */}
      {(!m.idle || m.gauges.length > 0) && (
        <>
          {!m.idle && (
            <div className="sb-seg cwd" title={m.cwd ?? undefined}>
              <span className="lbl">{t('statusbar.cwd')}</span>
              <span className={'val' + (m.cwd ? '' : ' na')}>{m.cwd ?? NA}</span>
            </div>
          )}
          <div className="sb-seg os">
            <span className="lbl">{t('statusbar.os')}</span>
            <span className={'val' + (facts.os === NA ? ' na' : '')}>{facts.os}</span>
          </div>
          {/* W1 F10 / FB-0008 리소스 게이지. CPU 는 흐름(스파크라인), MEM·GPU 는 막대(시안 Z-final). */}
          <div className="sb-seg gauge-seg cpu">
            <span className="lbl">CPU</span>
            <div className="gauge">
              {/* 폴링이 한 바퀴 돌 때마다 점이 하나 늘고 왼쪽으로 흐른다 — 값이 어디로 가는
                  중인지가 보인다. 그리는 함수는 하단 [시스템 모니터]와 같은 것을 쓴다. */}
              <svg className="sb-spark cpu" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
                {cpu && <polygon points={sparkArea(cpu.series, SPARK_W, SPARK_H)} />}
                {cpu && <polyline points={sparkPoints(cpu.series, SPARK_W, SPARK_H)} />}
              </svg>
              <span className={'val' + (cpu ? '' : ' na')}>{cpu?.text ?? NA}</span>
            </div>
          </div>
          {(['mem', 'gpu'] as const).map((key) => {
            const g = gauge(key)
            return (
              <div key={key} className={'sb-seg gauge-seg ' + key}>
                <span className="lbl">{key.toUpperCase()}</span>
                <div className="gauge">
                  <span className="sb-mbar" aria-hidden>
                    <i style={{ width: `${g?.pct ?? 0}%` }} />
                  </span>
                  <span className={'val' + (g ? '' : ' na')}>{g?.text ?? NA}</span>
                </div>
              </div>
            )
          })}
          <div className="sb-seg uptime">
            <span className="lbl">{t('statusbar.uptime')}</span>
            <span className={'val' + (facts.uptime === NA ? ' na' : '')}>{facts.uptime}</span>
          </div>
        </>
      )}
      <div className="sb-right">
        {children}
        {/* 좁아지면 접히는 두 칸(2026-08-17). 늘 참인 값이라 급할 때 볼 이유가 없다 —
            자리를 두고 다투면 도구 버튼에 양보한다. 2.0 순서: UTF-8 · 세션 n · 버전(시안 Z-final). */}
        <div className="sb-seg enc">
          <span className="val">UTF-8</span>
        </div>
        <div className="sb-seg">
          <span className="lbl">{t('statusbar.sessions')}</span>
          <span className="val">{sessionCount}</span>
        </div>
        {/* #98: 버전 칸이 곧 업데이트 알림이다(2026-09-04). 받을 것이 있으면 눌리는 버튼이 되고,
            없으면 예전 그대로 `v{version}` 만 보인다. `error`·`checking` 은 여기까지 안 온다 —
            사내망 밖에서 하루 네 번 상태바가 빨개지면 안 된다(updateSeg 주석). */}
        {u.action ? (
          <button
            type="button"
            className={verSegClass(u.tone)}
            /* 설정 서랍의 [받기]·[설치] 와 **다른 이름**이다 — 같은 동작이라도 자리가 다르면
               선택자도 달라야 한다(안 그러면 e2e 가 엉뚱한 버튼을 누른다). 붙여 만들지 않는 이유는
               따로 있다: 점으로 끝나는 리터럴은 scan-i18n 이 키 접두어로 삼는다. */
            data-action={
              u.action === 'download'
                ? 'statusbar.update.download'
                : u.action === 'check'
                  ? 'statusbar.update.check'
                  : 'statusbar.update.install'
            }
            title={u.title}
            onClick={() => onUpdateAction?.(u.action as 'download' | 'install' | 'check')}
          >
            {verBody}
          </button>
        ) : (
          <div className={'sb-seg ver' + (u.tone ? ' upd ' + u.tone : '')} title={u.title || undefined}>
            {verBody}
          </div>
        )}
      </div>
    </div>
  )
}
