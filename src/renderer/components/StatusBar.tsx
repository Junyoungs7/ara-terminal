import type { ConnectionProfile, RemoteStats } from '@shared/types'
import type { UpdateState } from '@shared/ipc'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { t } from '../i18n'
import { sparkArea, sparkPoints, type Sample } from '../store/sysMonitor'
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

// 활성 세션 → 상태바에 찍을 값(순수 — 단위 테스트 대상).
export function statusModel(
  session: Session | null,
  profile: ConnectionProfile | undefined,
  conn: ConnState,
  cwd: string | null,
  stats: RemoteStats | null = null,
  history: readonly Sample[] = []
): StatusModel {
  if (!session) return { primary: t('statusbar.idle'), dot: null, cwd: null, idle: true, gauges: [] }
  if (session.type === 'ssh') {
    // 프로필을 못 찾는 경우(삭제된 프로필의 살아 있는 세션)는 서버 그룹 키로 폴백한다.
    const primary = profile ? `${profile.username}@${profile.host}:${profile.port}` : session.serverKey
    return { primary, dot: (profile && conn[profile.id]) || 'connected', cwd, idle: false, gauges: gaugesOf(stats, history) }
  }
  // FB-0008: 로컬 세션도 게이지를 받는다(내 PC의 CPU/메모리) — gaugesOf 는 stats 가 없으면 그냥 빈 배열.
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
  const m = statusModel(session, profile, conn, cwd, stats, history)
  const u = updateSeg(update ?? null, version)
  // 업데이트를 말하는 동안에는 브랜드 라벨을 뺀다 — 상태바는 좁고, 지금 할 말은 "A.R.A" 가 아니다.
  const verBody = (
    <>
      {!u.tone && <span className="lbl">{t('app.name')}</span>}
      <span className="val">{u.text}</span>
    </>
  )
  const label = m.idle ? t('statusbar.state') : session?.type === 'ssh' ? t('statusbar.host') : t('statusbar.shell')
  return (
    <div className="statusbar">
      <div className={'sb-seg host' + (m.idle ? ' idle' : '')}>
        {m.dot && <span className={'sb-dot ' + m.dot} />}
        <span className="lbl">{label}</span>
        <span className="val">{m.primary}</span>
      </div>
      {m.cwd && (
        <div className="sb-seg cwd" title={m.cwd}>
          <span className="lbl">{t('statusbar.cwd')}</span>
          <span className="val">{m.cwd}</span>
        </div>
      )}
      {/* W1 F10 / FB-0008 리소스 게이지(목업 하단 바 스타일). 활성 세션(SSH·로컬)에 폴링 값이 오면 나타난다. */}
      {m.gauges.map((g) => (
        <div key={g.key} className="sb-seg gauge-seg">
          <span className="lbl">{g.key.toUpperCase()}</span>
          <div className="gauge">
            {/* 폴링이 한 바퀴 돌 때마다 점이 하나 늘고 왼쪽으로 흐른다 — 값이 어디로 가는
                중인지가 보인다. 그리는 함수는 하단 [시스템 모니터]와 같은 것을 쓴다. */}
            <svg className={'sb-spark ' + g.key} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden>
              {/* 아래를 채운다(제보 18) — 14px 높이에서는 선 하나보다 면이 훨씬 빨리 읽힌다. */}
              <polygon points={sparkArea(g.series, SPARK_W, SPARK_H)} />
              <polyline points={sparkPoints(g.series, SPARK_W, SPARK_H)} />
            </svg>
            <span className="val">{g.text}</span>
          </div>
        </div>
      ))}
      <div className="sb-right">
        {children}
        <div className="sb-seg">
          <span className="lbl">{t('statusbar.sessions')}</span>
          <span className="val">{sessionCount}</span>
        </div>
        {/* 좁아지면 접히는 두 칸(2026-08-17). 늘 참인 값이라 급할 때 볼 이유가 없다 —
            자리를 두고 다투면 도구 버튼에 양보한다. */}
        <div className="sb-seg enc">
          <span className="lbl">{t('statusbar.encoding')}</span>
          <span className="val">UTF-8</span>
        </div>
        {/* #98: 버전 칸이 곧 업데이트 알림이다(2026-09-04). 받을 것이 있으면 눌리는 버튼이 되고,
            없으면 예전 그대로 `v{version}` 만 보인다. `error`·`checking` 은 여기까지 안 온다 —
            사내망 밖에서 하루 네 번 상태바가 빨개지면 안 된다(updateSeg 주석). */}
        {u.action ? (
          <button
            type="button"
            className={'sb-seg ver upd ' + u.tone}
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
