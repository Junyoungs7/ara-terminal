import { useState } from 'react'
import type { DiskUsage, HostStats, RemoteStats } from '@shared/types'
import { IconClose } from './icons'
import { t } from '../i18n'
import { sparkPoints, useHostStats, useRemoteDisks, type Sample } from '../store/sysMonitor'

// F29 시스템 모니터 — 준영님 요청(2026-08-11):
// "우측 버튼에 서버 정보 보기 버튼으로 클릭하면 현재 보고있는 서버, 즉 패널의 cpu, memory, gpu,
//  디스크 용량 등 시스템 정보를 그래프와 이런걸로 사이드바 형식으로 보여주고 기본적으로는 내 로컬
//  시스템의 정보를 보여주고. 탭으로 지금 보고있는 패널, 로컬 이렇게 2개를 선택해서 보여주는거지."
//
// 껍데기(헤더+닫기)는 MonitorPanel/.mon-head 와 같은 조합을 재사용한다 — 새 창 인프라를 만들지 않는다.
// 그래프는 **차트 라이브러리 없이** 인라인 SVG polyline 이다. 값 60개짜리 꺾은선 하나에
// 의존성을 얹을 이유가 없다(번들도 커진다).

type Tab = 'local' | 'panel'

function kbToHuman(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`
  if (kb >= 1024) return `${Math.round(kb / 1024)}M`
  return `${kb}K`
}

/** nvidia-smi 는 MiB 로 준다 — 화면 표기는 메모리·디스크와 같은 함수를 타야 단위가 안 갈린다. */
function mbToHuman(mb: number): string {
  return kbToHuman(mb * 1024)
}

// 사용률 톤은 F26 디스크 창과 같은 경계(90 빨강 / 75 주황)를 쓴다 — 같은 숫자가 화면마다
// 다른 색이면 사용자가 기준을 두 번 외워야 한다.
function toneOf(pct: number): string {
  if (pct >= 90) return ' bad'
  if (pct >= 75) return ' warn'
  return ''
}

function Spark({
  label,
  values,
  now,
  sub,
  unit = '%'
}: {
  label: string
  values: number[]
  now: number | null
  /** 그래프 밑 한 줄(예: `12.4G / 31.9G`). 지표 카드 **안**에 들어간다 — 밖에 두면 어느 지표의 값인지 흐려진다. */
  sub?: string
  unit?: string
}) {
  const W = 200
  const H = 34
  return (
    <div className="sysm-metric">
      <div className="sysm-mhead">
        <span className="sysm-mlabel">{label}</span>
        <span className={'sysm-mnow' + toneOf(now ?? 0)}>{now === null ? '—' : `${now}${unit}`}</span>
      </div>
      <svg className="sysm-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <polyline points={sparkPoints(values, W, H)} />
      </svg>
      {sub ? <div className="sysm-sub">{sub}</div> : null}
    </div>
  )
}

function Disks({ list }: { list: DiskUsage[] }) {
  if (list.length === 0) return <div className="sysm-empty">{t('sysm.disk.none')}</div>
  return (
    <div className="sysm-disks">
      {list.map((d) => (
        <div className="sysm-disk" key={d.mount}>
          <div className="sysm-dhead">
            <span className="sysm-dmount" title={d.mount}>
              {d.mount}
            </span>
            <span className={'sysm-dpct' + toneOf(d.usePct)}>{d.usePct}%</span>
          </div>
          <div className="sysm-dbar">
            <div className={'sysm-dfill' + toneOf(d.usePct)} style={{ width: `${d.usePct}%` }} />
          </div>
          <div className="sysm-dsub">
            {kbToHuman(d.usedKb)} / {kbToHuman(d.totalKb)}
          </div>
        </div>
      ))}
    </div>
  )
}

function Body({
  stats,
  history,
  disks,
  gpuNote
}: {
  stats: RemoteStats | HostStats | null
  history: Sample[]
  disks: DiskUsage[]
  gpuNote?: string
}) {
  const gpuSeen = history.some((s) => typeof s.gpuPct === 'number')
  const gpu = stats as RemoteStats | null
  return (
    <>
      <Spark label={t('sysm.cpu')} values={history.map((s) => s.cpuPct)} now={stats ? Math.round(stats.cpuPct) : null} />
      <Spark
        label={t('sysm.mem')}
        values={history.map((s) => s.memPct)}
        now={history.length > 0 ? (history[history.length - 1]?.memPct ?? null) : null}
        sub={stats ? `${kbToHuman(stats.memUsedKb)} / ${kbToHuman(stats.memTotalKb)}` : undefined}
      />
      {/* GPU 는 있을 때만 칸을 만든다 — 없는 칸을 "—" 로 남겨 두면 고장난 것처럼 보인다
          (상태바 게이지 gaugesOf() 가 이미 같은 규칙이다).
          메모리 줄은 nvidia-smi 가 그 값까지 준 서버에서만 붙는다(사용률만 오는 예전 형태도 있다). */}
      {gpuSeen ? (
        <Spark
          label={t('sysm.gpu')}
          values={history.map((s) => s.gpuPct ?? 0)}
          now={history[history.length - 1]?.gpuPct ?? null}
          sub={
            gpu?.gpuMemUsedMb !== undefined && gpu.gpuMemTotalMb !== undefined
              ? `${mbToHuman(gpu.gpuMemUsedMb)} / ${mbToHuman(gpu.gpuMemTotalMb)}`
              : undefined
          }
        />
      ) : gpuNote ? (
        <div className="sysm-note">{gpuNote}</div>
      ) : null}
      <div className="sysm-sec">{t('sysm.disk')}</div>
      <Disks list={disks} />
    </>
  )
}

export function SysMonitorPanel({
  open,
  onClose,
  sessionId,
  isSsh,
  serverName,
  stats,
  history
}: {
  open: boolean
  onClose: () => void
  /** 현재 패널의 세션. null 이면 [현재 패널] 탭은 안내만 낸다. */
  sessionId: string | null
  isSsh: boolean
  serverName: string
  /** 현재 세션의 실시간 통계 — 이미 흐르고 있는 telemetry 구독을 그대로 받는다(새 폴러 금지). */
  stats: RemoteStats | null
  history: Sample[]
}) {
  // 기본은 [로컬] — 준영님 지시("기본적으로는 내 로컬 시스템의 정보를 보여주고").
  const [tab, setTab] = useState<Tab>('local')
  const host = useHostStats(open && tab === 'local')
  const remote = useRemoteDisks(sessionId, isSsh, open && tab === 'panel')

  if (!open) return null
  return (
    <div className="monitor-panel sysm">
      <div className="mon-head">
        <span className="mon-name">{t('sysm.title')}</span>
        <span className="mon-close" title={t('mon.close')} onClick={onClose}>
          <IconClose />
        </span>
      </div>
      <div className="sysm-tabs" role="tablist">
        <button
          className={'sysm-tab' + (tab === 'local' ? ' active' : '')}
          role="tab"
          aria-selected={tab === 'local'}
          onClick={() => setTab('local')}
        >
          {t('sysm.tab.local')}
        </button>
        <button
          className={'sysm-tab' + (tab === 'panel' ? ' active' : '')}
          role="tab"
          aria-selected={tab === 'panel'}
          onClick={() => setTab('panel')}
        >
          {t('sysm.tab.panel')}
        </button>
      </div>
      <div className="sysm-body">
        {tab === 'local' ? (
          <>
            <div className="sysm-who">{host.stats?.hostname || t('sysm.local.me')}</div>
            <Body stats={host.stats} history={host.history} disks={host.stats?.disks ?? []} gpuNote={t('sysm.gpu.na')} />
          </>
        ) : sessionId ? (
          <>
            <div className="sysm-who">{serverName}</div>
            <Body stats={stats} history={history} disks={remote.disks} />
          </>
        ) : (
          // "세션 없음"과 "디스크 없음"은 뜻이 다르다 — 클래스를 갈라 둔다(SYSM-4 가 이 모호함에 걸렸다).
          <div className="sysm-empty sysm-nosession">{t('sysm.panel.none')}</div>
        )}
      </div>
    </div>
  )
}
