// F26 서버 콘솔 — 서비스 창(systemd 유닛). 뼈대는 ProcessTable 과 같다: watch 로 2.5초마다 목록을
// 받고, 순수 함수로 거르고 정렬하고, 쓰기는 확인 다이얼로그를 거친다. 파싱은 이미 검증된
// shared/remoteCatalog.ts 의 parseSystemctl 을 쓴다 — 두 번째 파서를 만들지 않는다.
//
// 프로세스 창과 다른 점 셋:
//  · **failed 를 기본 정렬에서 맨 위로 올린다.** 서비스 목록을 여는 이유가 대개 "뭐가 죽었나"다.
//    이름순으로 두면 죽은 유닛이 200줄 아래에 묻힌다.
//  · **systemd 가 없는 서버가 있다.** 빈 목록으로 보여 주면 "서비스가 하나도 없는 서버"로 읽히므로
//    systemdMissing(out) 이면 안내 한 줄로 갈아 끼운다(프로세스 창의 로컬 세션 안내와 같은 결).
//  · 쓰기가 셋이다(시작·정지·재시작). 셋 다 확인 다이얼로그에 **유닛 이름을 박아서** 묻고,
//    실패하면 서버가 준 문장을 그대로 보여 준다(sudo 는 붙이지 않는다).
import { useEffect, useMemo, useState } from 'react'
import { parseSystemctl, systemdMissing, type SvcAction, type SvcRow } from '@shared/remoteCatalog'
import { maskSecrets } from '@shared/maskSecrets'
import type { DialogSpec, DialogResult } from './Dialog'
import { IconRefresh, IconClose } from './icons'
import { t } from '../i18n'

// ── 순수 함수(단위 테스트 대상: tests/serverConsole.test.ts) ────────────────

export type SvcSortKey = 'unit' | 'active' | 'sub' | 'desc'
export type SvcSort = { key: SvcSortKey; desc: boolean }

/** 첫 화면 정렬 — 상태 오름차순 = 급한 것부터(아래 svcRank). */
export const DEFAULT_SVC_SORT: SvcSort = { key: 'active', desc: false }

/**
 * 상태 정렬 순위. 사전순(active < failed < inactive)이 아니라 **급한 순서**로 준다 —
 * 0 죽음 / 1 돌고 있음 / 2 그 밖(inactive·masked…). 색 강조도 이 순위 하나에서 갈린다.
 * sub 가 failed 인 유닛(active 는 activating 인데 실제로는 죽은 경우)도 죽음으로 본다.
 */
export function svcRank(row: SvcRow): number {
  if (row.active === 'failed' || row.sub === 'failed') return 0
  return row.active === 'active' ? 1 : 2
}

/** 유닛 이름·설명 부분일치(대소문자 무시). filterProcs 와 같은 결 — 좁히기만 한다. */
export function filterSvcs(rows: readonly SvcRow[], query: string): SvcRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => r.unit.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q))
}

/** 열 정렬. 같은 값이면 유닛 이름순으로 고정해 폴링 한 바퀴마다 행이 들썩이지 않게 한다. */
export function sortSvcs(rows: readonly SvcRow[], sort: SvcSort): SvcRow[] {
  const dir = sort.desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const d = sort.key === 'active' ? svcRank(a) - svcRank(b) : a[sort.key].localeCompare(b[sort.key])
    return d !== 0 ? d * dir : a.unit.localeCompare(b.unit)
  })
}

/** 열 머리 클릭. 같은 열이면 방향만 뒤집고, 다른 열은 오름차순으로 시작한다(글자는 사전순, 상태는 급한 것부터). */
export function nextSvcSort(cur: SvcSort, key: SvcSortKey): SvcSort {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: false }
}

/** 상태 점 — 죽음 빨강 / 돌고 있음 초록 / 그 밖은 흐림(색 없음). */
export function svcTone(row: SvcRow): 'ok' | 'bad' | null {
  const r = svcRank(row)
  return r === 0 ? 'bad' : r === 1 ? 'ok' : null
}

/** [아라에게 물어보기] 맥락 — 고른 행 하나뿐. 설명 칸에 무엇이 들어 있을지 모르니 마스킹을 통과시킨다. */
export function svcContext(row: SvcRow): string {
  return maskSecrets(
    [t('console.svc.ask.head'), `${row.unit} · ${row.load} · ${row.active} / ${row.sub}`, row.desc].join('\n')
  )
}

// ── 화면 ────────────────────────────────────────────────────────────────────

type Props = {
  sessionId: string | null
  /** 숨은 탭은 원격에 명령을 보내지 않는다(active=false → unwatch). */
  active: boolean
  ask: (spec: DialogSpec) => Promise<DialogResult>
  onAskAi: (text: string) => void
}

const COLS: { key: SvcSortKey; cls: string }[] = [
  { key: 'unit', cls: 'cunit' },
  { key: 'active', cls: 'cact' },
  { key: 'sub', cls: 'csub' },
  { key: 'desc', cls: 'cdesc' }
]

const ACTIONS: SvcAction[] = ['start', 'stop', 'restart']

export function ServiceTable({ sessionId, active, ask, onAskAi }: Props): JSX.Element {
  const [rows, setRows] = useState<SvcRow[]>([])
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SvcSort>(DEFAULT_SVC_SORT)
  const [selected, setSelected] = useState<string | null>(null)

  // 대상 서버가 바뀌면 목록·선택을 **즉시** 버린다. A 에서 고른 nginx.service 를 든 채 B 로 전환되면
  // B 의 같은 이름 서비스를 정지시킨다 — 프로세스 창의 PID 사고(CON-8c)와 같은 종류다.
  useEffect(() => {
    setRows([])
    setSelected(null)
    setMissing(false)
  }, [sessionId])

  useEffect(() => {
    if (!active || !sessionId) return
    const off = window.ev?.remote.onData((d) => {
      if (d.sessionId !== sessionId || d.cmdId !== 'svc.list') return
      const parsed = parseSystemctl(d.out)
      // 한 줄도 못 읽었을 때만 "systemd 가 없는 서버"를 의심한다 — 설명 칸은 자유 문자열이라
      // 정상 목록에도 'not found' 같은 낱말이 섞일 수 있다.
      setMissing(parsed.length === 0 && systemdMissing(d.out))
      setRows(parsed)
    })
    void window.ev?.remote.watch(sessionId, 'svc.list')
    return () => {
      off?.()
      void window.ev?.remote.unwatch(sessionId, 'svc.list')
    }
  }, [active, sessionId])

  const visible = useMemo(() => sortSvcs(filterSvcs(rows, query), sort), [rows, query, sort])
  const row = selected === null ? null : (rows.find((r) => r.unit === selected) ?? null)

  // 이미 구독 중인 명령에 watch 를 다시 부르면 즉시 한 바퀴 돈다(telemetry.start 와 같은 계약).
  const refresh = (): void => {
    if (sessionId) void window.ev?.remote.watch(sessionId, 'svc.list')
  }

  const act = async (action: SvcAction): Promise<void> => {
    if (!row || !sessionId) return
    const r = await ask({
      title: t('console.svc.act.title.' + action),
      message: t('console.svc.act.msg.' + action),
      detail: [
        { label: t('console.svc.col.unit'), value: row.unit },
        { label: t('console.svc.act.state'), value: `${row.active} / ${row.sub}` }
      ],
      // 시작만 되돌리기 쉽다 — 정지·재시작은 그 서비스를 쓰던 사람이 그 자리에서 끊긴다.
      ...(action === 'start' ? {} : { tone: 'danger' as const }),
      confirmLabel: t('console.svc.act.' + action),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    const res = await window.ev?.remote.run(sessionId, 'svc.action', { unit: row.unit, action })
    // 눌렀으면 결과가 곧바로 표에 보여야 한다(사용자가 새로고침을 누르게 하지 않는다).
    refresh()
    if (res?.ok && res.code === 0) return
    const why = res?.ok ? res.out.trim() : t('console.err.' + (res?.reason ?? 'exec'))
    await ask({
      title: t('console.svc.act.failTitle'),
      message: t('console.svc.act.failMsg'),
      detail: [
        { label: t('console.svc.col.unit'), value: row.unit },
        { label: t('console.svc.act.reason'), value: why || t('console.svc.act.noReason') }
      ],
      tone: 'danger',
      confirmLabel: t('dlg.ok'),
      cancelLabel: null
    })
  }

  const askAra = async (): Promise<void> => {
    if (!row) return
    const text = svcContext(row)
    const r = await ask({
      title: t('console.svc.ask.title'),
      message: t('console.svc.ask.msg'),
      detail: [{ label: t('console.svc.ask.payload'), value: text }],
      confirmLabel: t('console.svc.ask.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r === 'confirm') onAskAi(text)
  }

  return (
    <div className="con-svc">
      <div className="con-toolbar">
        <div className="con-field">
          <input
            type="text"
            value={query}
            placeholder={t('console.svc.search')}
            aria-label={t('console.svc.search')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setQuery('')
            }}
          />
          {query && (
            <span className="sclear" title={t('conn.search.clear')} onClick={() => setQuery('')}>
              <IconClose />
            </span>
          )}
        </div>
        <span className="con-count">{visible.length}</span>
        <button type="button" className="con-btn" data-action="svc.refresh" title={t('sftp.refresh')} onClick={refresh}>
          <IconRefresh />
        </button>
        <button type="button" className="con-btn" data-action="svc.ask" disabled={!row} onClick={() => void askAra()}>
          {t('console.svc.ask.btn')}
        </button>
        {ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            className={'con-btn' + (a === 'start' ? '' : ' danger')}
            data-action={'svc.' + a}
            disabled={!row}
            onClick={() => void act(a)}
          >
            {t('console.svc.act.' + a)}
          </button>
        ))}
      </div>

      {/* systemd 가 없는 서버는 표 자체를 그리지 않는다 — 빈 표는 "서비스가 없다"로 읽힌다. */}
      {missing ? (
        <div className="con-empty">{t('console.svc.noSystemd')}</div>
      ) : (
        <div className="con-tblwrap">
          <table className="con-tbl">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={c.cls + (sort.key === c.key ? ' on' : '')}
                    data-col={c.key}
                    onClick={() => setSort((s) => nextSvcSort(s, c.key))}
                  >
                    {t('console.svc.col.' + c.key)}
                    {sort.key === c.key && <span className="con-caret">{sort.desc ? '▾' : '▴'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const tone = svcTone(s)
                return (
                  <tr
                    key={s.unit}
                    className={'svc-row' + (s.unit === selected ? ' sel' : '') + (tone === 'bad' ? ' bad' : '')}
                    data-unit={s.unit}
                    title={s.desc}
                    onClick={() => setSelected(s.unit)}
                  >
                    <td className="cunit">{s.unit}</td>
                    <td className="cact">
                      <span className={'con-dot' + (tone ? ' ' + tone : '')} />
                      {s.active}
                    </td>
                    <td className="csub">{s.sub}</td>
                    <td className="cdesc">{s.desc}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="con-empty">{t('console.svc.loading')}</div>}
          {rows.length > 0 && visible.length === 0 && <div className="con-empty">{t('console.svc.noMatch')}</div>}
        </div>
      )}
    </div>
  )
}
