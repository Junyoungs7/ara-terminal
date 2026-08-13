import type { ConnectionProfile, RemoteStats } from '@shared/types'
import type { ConnState } from '../store/profiles'
import type { Session } from '../store/sessions'
import { t } from '../i18n'

// 하단 상태바 (design-system §4.1).
//
// R4.2: `호스트: localhost` 하드코딩을 활성 세션 실데이터로 바꾼다. 수집 로직은 새로 만들지 않는다 —
// SSH 는 serverKey(=프로필명)로 찾은 프로필의 user@host:port + 연결 상태(useProfiles.conn),
// 로컬은 세션 이름 + OSC7 cwd(F7 에서 이미 추적 중인 값)를 그대로 표시만 한다.
// 클릭 동작은 넣지 않는다(범위 밖) — 표시 전용 바다.

// W1 F10: 원격 리소스 게이지 한 칸. pct 는 막대 길이, text 는 옆에 찍는 값.
export type Gauge = { key: 'cpu' | 'mem' | 'gpu'; pct: number; text: string }

export type StatusModel = {
  // 좌측 첫 칸. dot 은 SSH 연결 상태(로컬·유휴는 없음).
  primary: string
  dot: ConnState[string] | null
  cwd: string | null
  idle: boolean
  // 텔레메트리가 들어왔을 때만 채워진다(SSH=원격 /proc 폴링, FB-0008: 로컬=os 모듈 폴링 — 표시는 같은 모양).
  gauges: Gauge[]
}

const KB_PER_GIB = 1024 * 1024
const gib = (kb: number): string => (kb / KB_PER_GIB).toFixed(1)

// 원격 리소스 → 게이지 목록(순수). GPU 는 nvidia-smi 가 있는 서버에서만 온다.
export function gaugesOf(stats: RemoteStats | null): Gauge[] {
  if (!stats) return []
  const out: Gauge[] = [{ key: 'cpu', pct: stats.cpuPct, text: `${stats.cpuPct}%` }]
  if (stats.memTotalKb > 0) {
    out.push({
      key: 'mem',
      pct: Math.round((stats.memUsedKb / stats.memTotalKb) * 100),
      text: `${gib(stats.memUsedKb)}/${gib(stats.memTotalKb)}G`
    })
  }
  if (stats.gpuPct !== undefined) out.push({ key: 'gpu', pct: stats.gpuPct, text: `${stats.gpuPct}%` })
  return out
}

// 활성 세션 → 상태바에 찍을 값(순수 — 단위 테스트 대상).
export function statusModel(
  session: Session | null,
  profile: ConnectionProfile | undefined,
  conn: ConnState,
  cwd: string | null,
  stats: RemoteStats | null = null
): StatusModel {
  if (!session) return { primary: t('statusbar.idle'), dot: null, cwd: null, idle: true, gauges: [] }
  if (session.type === 'ssh') {
    // 프로필을 못 찾는 경우(삭제된 프로필의 살아 있는 세션)는 서버 그룹 키로 폴백한다.
    const primary = profile ? `${profile.username}@${profile.host}:${profile.port}` : session.serverKey
    return { primary, dot: (profile && conn[profile.id]) || 'connected', cwd, idle: false, gauges: gaugesOf(stats) }
  }
  // FB-0008: 로컬 세션도 게이지를 받는다(내 PC의 CPU/메모리) — gaugesOf 는 stats 가 없으면 그냥 빈 배열.
  return { primary: session.title, dot: null, cwd, idle: false, gauges: gaugesOf(stats) }
}

export function StatusBar({
  version,
  session,
  profile,
  conn,
  cwd,
  sessionCount,
  stats = null,
  children
}: {
  version: string
  session: Session | null
  profile: ConnectionProfile | undefined
  conn: ConnState
  cwd: string | null
  sessionCount: number
  // W1 F10 / FB-0008: 활성 세션의 리소스(SSH=원격 폴링, 로컬=내 PC 폴링). 없으면 게이지 칸이 통째로 빠진다.
  stats?: RemoteStats | null
  // W4 F23: MCP "AI 조종 중" 인디케이터. 다른 세그먼트 앞(sb-right 맨 앞)에 얹는다 — 자체 상태를
  // 들고 있는 컴포넌트라 여기서는 슬롯만 내준다(다른 게이지처럼 props 로 값을 받지 않는다).
  children?: React.ReactNode
}) {
  const m = statusModel(session, profile, conn, cwd, stats)
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
            <div className={'bar ' + g.key}>
              <i style={{ width: `${g.pct}%` }} />
            </div>
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
        <div className="sb-seg">
          <span className="lbl">{t('statusbar.encoding')}</span>
          <span className="val">UTF-8</span>
        </div>
        <div className="sb-seg">
          <span className="lbl">{t('app.name')}</span>
          <span className="val">v{version}</span>
        </div>
      </div>
    </div>
  )
}
