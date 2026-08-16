// F26 서버 콘솔 — 프로세스 창(원격 작업 관리자). 목업 ③ 카드의 표 모양.
//
// 데이터는 `ps.list` 를 2.5초마다 watch 한 결과다(포트 모니터와 같은 주기). 파싱은 이미 검증된
// shared/remoteCatalog.ts 의 parsePs 를 쓴다 — 여기서 두 번째 파서를 만들지 않는다.
//
// 이 파일이 쥐고 있는 위험한 동작은 [종료] 하나뿐이고, 그 경로는 이렇게 좁혀 두었다:
//   · 넘기는 것은 pid 와 시그널뿐이다(명령 문자열이 아니다 — 조립은 main 의 카탈로그가 한다).
//   · 확인 다이얼로그에 **PID 와 명령을 박아서** 보여 준다(엉뚱한 행을 죽이는 사고 방지).
//   · 실패하면 stderr 를 그대로 보여 준다 — 권한 부족을 "실패했습니다"로 뭉개지 않는다(sudo 는 붙이지 않는다).
//   · `-KILL` 은 TERM 이 실패한 **뒤에만** 별도 버튼으로 낸다(첫 클릭에 강제 종료가 나가지 않는다).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRowKeys } from '../store/rowKeys'
import { parsePs, type KillSignal, type ProcRow } from '@shared/remoteCatalog'
import { maskSecrets } from '@shared/maskSecrets'
import type { DialogSpec, DialogResult } from './Dialog'
import { IconRefresh, IconClose } from './icons'
import { t } from '../i18n'
import { remoteError } from '../store/remoteState'

// ── 순수 함수(단위 테스트 대상: tests/serverConsole.test.ts) ────────────────

export type ProcSortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'cmd'
export type ProcSort = { key: ProcSortKey; desc: boolean }

/** 첫 화면 정렬 — ps 가 이미 CPU 내림차순으로 주므로 그 순서를 그대로 이어받는다. */
export const DEFAULT_SORT: ProcSort = { key: 'cpu', desc: true }

/** 이 값을 넘는 CPU 는 색으로 눈에 띄게 한다(멀티코어에서 pcpu 는 100 을 넘을 수 있다). */
export const HIGH_CPU_PCT = 50

/** 명령·사용자 부분일치(대소문자 무시). PortMonitor.filterPorts 와 같은 결 — 좁히기만 한다. */
export function filterProcs(rows: readonly ProcRow[], query: string): ProcRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => r.cmd.toLowerCase().includes(q) || r.user.toLowerCase().includes(q))
}

/** 열 정렬. 같은 값이면 PID 오름차순으로 고정해 폴링 한 바퀴마다 행이 들썩이지 않게 한다. */
export function sortProcs(rows: readonly ProcRow[], sort: ProcSort): ProcRow[] {
  const dir = sort.desc ? -1 : 1
  return [...rows].sort((a, b) => {
    const d =
      sort.key === 'user' || sort.key === 'cmd'
        ? a[sort.key].localeCompare(b[sort.key])
        : a[sort.key] - b[sort.key]
    return d !== 0 ? d * dir : a.pid - b.pid
  })
}

/**
 * 열 머리를 눌렀을 때의 다음 정렬. 같은 열이면 방향만 뒤집고, 다른 열이면 그 열에서 **쓸모 있는 쪽**으로
 * 시작한다 — 숫자는 큰 것부터(누가 CPU 를 먹고 있나), 글자는 사전순.
 */
export function nextSort(cur: ProcSort, key: ProcSortKey): ProcSort {
  if (cur.key === key) return { key, desc: !cur.desc }
  return { key, desc: key !== 'user' && key !== 'cmd' }
}

/** 행 강조 — 좀비(ps STAT 에 Z)와 고CPU 만. 그 밖은 색을 쓰지 않는다(전부 강조하면 강조가 아니다). */
export function procTone(row: ProcRow): 'zombie' | 'hot' | null {
  if (row.stat.includes('Z')) return 'zombie'
  return row.cpu >= HIGH_CPU_PCT ? 'hot' : null
}

/**
 * [아라에게 물어보기] 로 보낼 맥락. **고른 행 하나뿐**이다 — 목록 전체를 보내지 않는다.
 * 명령줄에 토큰이 박혀 있을 수 있어 기존 maskSecrets 를 통과시킨다(터미널 컨텍스트 칩과 같은 규칙).
 */
export function procContext(row: ProcRow): string {
  return maskSecrets(
    [
      t('console.ps.ask.head'),
      `PID ${row.pid} · ${row.user} · CPU ${row.cpu}% · MEM ${row.mem}% · STAT ${row.stat}`,
      row.cmd
    ].join('\n')
  )
}

// ── 화면 ────────────────────────────────────────────────────────────────────

type Props = {
  sessionId: string | null
  /** 확인창이 찍을 서버 이름(2026-08-16) — 두 서버를 동시에 볼 수 있는 구조라 대상을 밝혀야 한다. */
  server?: string
  /** 숨은 탭은 원격에 명령을 보내지 않는다(탐색기의 숨은 트리가 파일시스템을 읽지 않는 것과 같은 규칙). */
  active: boolean
  ask: (spec: DialogSpec) => Promise<DialogResult>
  /** 아라 패널로 보낼 텍스트. 누를 때만 보낸다(기본 꺼짐이 아니라 명시적 제스처). */
  onAskAi: (text: string) => void
}

const COLS: { key: ProcSortKey; cls: string }[] = [
  { key: 'pid', cls: 'cpid' },
  { key: 'user', cls: 'cuser' },
  { key: 'cpu', cls: 'ccpu' },
  { key: 'mem', cls: 'cmem' },
  { key: 'cmd', cls: 'ccmd' }
]

export function ProcessTable({ sessionId, active, server, ask, onAskAi }: Props): JSX.Element {
  // #82: 표를 ↑↓ 로 훑고 Enter 로 고른다. 행은 버튼이 아니라 row 다.
  const gridRef = useRef<HTMLDivElement>(null)
  const gridKeys = useRowKeys(gridRef, { selector: '[role="row"]' })
  const [rows, setRows] = useState<ProcRow[]>([])
  // #68: 읽기 실패 사유. null 이면 정상(행이 0 이어도 로딩으로 본다).
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ProcSort>(DEFAULT_SORT)
  const [selected, setSelected] = useState<number | null>(null)

  // 대상 서버가 바뀌면 이전 서버의 목록·선택을 **즉시** 버린다. 남겨 두면 A 에서 고른 PID 를 그대로
  // B 에 종료 요청하는 사고가 난다(같은 번호가 다른 프로세스다 — 되돌릴 수 없는 종류의 실수).
  useEffect(() => {
    setRows([])
    setSelected(null)
    setErr(null)
  }, [sessionId])

  // 구독 = (이 탭이 보이는 동안) 2.5초마다 한 바퀴. 탭을 닫거나 창을 닫으면 unwatch 가 나간다.
  useEffect(() => {
    if (!active || !sessionId) return
    const off = window.ev?.remote.onData((d) => {
      if (d.sessionId !== sessionId || d.cmdId !== 'ps.list') return
      const parsed = parsePs(d.out)
      // 행이 하나라도 나왔으면 성공이다 — 행이 있는 채로 오류를 띄우지 않는다(remoteState 규칙).
      setErr(remoteError(d, parsed.length))
      if (parsed.length > 0) setRows(parsed)
    })
    void window.ev?.remote.watch(sessionId, 'ps.list')
    return () => {
      off?.()
      void window.ev?.remote.unwatch(sessionId, 'ps.list')
    }
  }, [active, sessionId])

  const visible = useMemo(() => sortProcs(filterProcs(rows, query), sort), [rows, query, sort])
  const row = selected === null ? null : (rows.find((r) => r.pid === selected) ?? null)

  // 이미 구독 중인 명령에 watch 를 다시 부르면 즉시 한 바퀴 돈다(telemetry.start 와 같은 계약).
  const refresh = (): void => {
    if (sessionId) void window.ev?.remote.watch(sessionId, 'ps.list')
  }

  // 시그널 한 번 보내기. 실패는 stderr 를 그대로 띄우고, TERM 이었을 때만 강제 종료 버튼을 붙인다.
  const send = async (target: ProcRow, signal: KillSignal): Promise<void> => {
    if (!sessionId) return
    const res = await window.ev?.remote.run(sessionId, 'ps.kill', { pid: target.pid, signal })
    if (res?.ok && res.code === 0) {
      refresh()
      return
    }
    const why = res?.ok ? res.out.trim() : t('console.err.' + (res?.reason ?? 'exec'))
    const r = await ask({
      title: t('console.ps.kill.failTitle'),
      message: t('console.ps.kill.failMsg'),
      detail: [
        ...(server ? [{ label: t('conn.fail.server'), value: server }] : []),
        { label: t('console.ps.col.pid'), value: String(target.pid) },
        { label: t('console.ps.kill.reason'), value: why || t('console.ps.kill.noReason') }
      ],
      tone: 'danger',
      confirmLabel: t('dlg.ok'),
      cancelLabel: null,
      // -KILL 은 여기서만 나온다 — TERM 이 실패한 뒤의 두 번째 선택지다.
      ...(signal === 'TERM' ? { altLabel: t('console.ps.kill.force') } : {})
    })
    if (r === 'alt') await send(target, 'KILL')
  }

  const confirmKill = async (): Promise<void> => {
    if (!row) return
    const r = await ask({
      title: t('console.ps.kill.title'),
      message: t('console.ps.kill.msg'),
      detail: [
        ...(server ? [{ label: t('conn.fail.server'), value: server }] : []),
        { label: t('console.ps.col.pid'), value: String(row.pid) },
        { label: t('console.ps.col.user'), value: row.user },
        { label: t('console.ps.col.cmd'), value: row.cmd }
      ],
      tone: 'danger',
      confirmLabel: t('console.ps.kill.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r === 'confirm') await send(row, 'TERM')
  }

  // 보낼 내용을 먼저 보여 주고, 확인했을 때만 아라 패널로 넘긴다(AI-15 컨텍스트 칩과 같은 규칙).
  const askAra = async (): Promise<void> => {
    if (!row) return
    const text = procContext(row)
    const r = await ask({
      title: t('console.ps.ask.title'),
      message: t('console.ps.ask.msg'),
      detail: [{ label: t('console.ps.ask.payload'), value: text }],
      confirmLabel: t('console.ps.ask.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r === 'confirm') onAskAi(text)
  }

  return (
    <div className="con-ps" ref={gridRef} role="grid" aria-label={t('console.tool.ps')} {...gridKeys}>
      <div className="con-toolbar">
        <div className="con-field">
          <input
            type="text"
            value={query}
            placeholder={t('console.ps.search')}
            aria-label={t('console.ps.search')}
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
        <button type="button" className="con-btn" data-action="ps.refresh" title={t('sftp.refresh')} onClick={refresh}>
          <IconRefresh />
        </button>
        <button type="button" className="con-btn" data-action="ps.ask" disabled={!row} onClick={() => void askAra()}>
          {t('console.ps.ask.btn')}
        </button>
        <button type="button" className="con-btn danger" data-action="ps.kill" disabled={!row} onClick={() => void confirmKill()}>
          {t('console.ps.kill.btn')}
        </button>
      </div>

      <div className="con-tblwrap">
        <table className="con-tbl">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={c.cls + (sort.key === c.key ? ' on' : '')}
                  data-col={c.key}
                  onClick={() => setSort((s) => nextSort(s, c.key))}
                >
                  {t('console.ps.col.' + c.key)}
                  {sort.key === c.key && <span className="con-caret">{sort.desc ? '▾' : '▴'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const tone = procTone(p)
              return (
                <tr
                  key={p.pid}
                  className={'con-row' + (p.pid === selected ? ' sel' : '') + (tone ? ' ' + tone : '')}
                  role="row"
                  tabIndex={-1}
                  aria-selected={p.pid === selected}
                  data-pid={p.pid}
                  title={p.cmd}
                  onClick={() => setSelected(p.pid)}
                >
                  <td className="cpid">{p.pid}</td>
                  <td className="cuser">{p.user}</td>
                  <td className="ccpu">{p.cpu.toFixed(1)}</td>
                  <td className="cmem">
                    <span className="con-bar">
                      <i style={{ width: `${Math.min(100, p.mem)}%` }} />
                    </span>
                    <span className="con-memv">{p.mem.toFixed(1)}</span>
                  </td>
                  <td className="ccmd">{p.cmd}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && err && <div className="con-empty bad">{err}</div>}
        {rows.length === 0 && !err && <div className="con-empty">{t('console.ps.loading')}</div>}
        {rows.length > 0 && visible.length === 0 && <div className="con-empty">{t('console.ps.noMatch')}</div>}
      </div>
    </div>
  )
}
