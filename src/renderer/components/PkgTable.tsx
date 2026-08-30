import { ChevronDown, ChevronUp } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { parsePkgProbe, PROBE_BINS, type PkgRow } from '@shared/remoteCatalog'
import { IconRefresh, IconClose } from './icons'
import { t } from '../i18n'

// F26 R3 설치된 프로그램 — 준영님: "설치되어 있는 프로그램 및 버전, 설치 날짜 등. 예를 들어
// node, nginx, npm 등".
//
// 왜 dpkg -l / rpm -qa 가 아닌가: 준영님이 예로 드신 node 는 사내에서 nvm 으로 까는 일이 흔하고,
// nvm·asdf·직접 빌드로 깐 것은 **패키지 목록에 아예 없다.** 그것만 보면 "node 가 설치돼 있지
// 않습니다"라고 거짓말을 하게 된다. 그래서 PATH 에서 직접 찾아 실행해 버전을 받는다.
//
// 폴링하지 않는다 — 설치 목록은 초 단위로 변하지 않는다. 탭을 열 때와 [새로고침] 때만 읽는다.
//
// 2026-08-24: 목록(div)이던 것을 **다른 탭과 같은 표**(.con-tbl)로 바꿨다(준영님 요청). 열 머리를
// 눌러 정렬하는 것까지 프로세스·서비스·디스크와 같은 규격이다 — 하단 패널에서 도구를 옮겨 다닐 때
// 표가 저마다 다르게 생겼을 이유가 없다.

/** 설치일은 **실행 파일 mtime** 이다(패키지 설치일과 정확히 같지 않다 — 화면이 그 사실을 밝힌다). */
function dateOf(ms: number | null): string {
  if (ms === null) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── 순수 함수(단위 테스트 대상: tests/serverConsole.test.ts) ────────────────

export type PkgSortKey = 'bin' | 'version' | 'path' | 'date'
export type PkgSort = { key: PkgSortKey; desc: boolean }

/** 첫 화면은 이름순 — 찾는 프로그램이 어디 있는지 아는 정렬이다(설치일순은 눌러서 본다). */
export const DEFAULT_PKG_SORT: PkgSort = { key: 'bin', desc: false }

export function filterPkgs(rows: readonly PkgRow[], q: string): PkgRow[] {
  const s = q.trim().toLowerCase()
  if (s === '') return rows.slice()
  return rows.filter((r) => r.bin.toLowerCase().includes(s) || r.version.toLowerCase().includes(s))
}

/**
 * 열 정렬. 같은 값이면 이름순으로 고정해 새로고침마다 행이 들썩이지 않게 한다(서비스 표와 같은 규칙).
 * 설치일을 모르는 행(mtime 을 못 읽은 것)은 **어느 방향으로 정렬하든 맨 아래**다 — 빈 값이 최신인
 * 척하며 위로 올라오면 "언제 깔았나"를 보려고 누른 정렬이 거짓말을 한다.
 */
export function sortPkgs(rows: readonly PkgRow[], sort: PkgSort): PkgRow[] {
  const dir = sort.desc ? -1 : 1
  return [...rows].sort((a, b) => {
    if (sort.key === 'date') {
      if (a.installedAt === b.installedAt) return a.bin.localeCompare(b.bin)
      if (a.installedAt === null) return 1
      if (b.installedAt === null) return -1
      return (a.installedAt - b.installedAt) * dir || a.bin.localeCompare(b.bin)
    }
    const k = sort.key === 'bin' ? 'bin' : sort.key === 'path' ? 'path' : 'version'
    return a[k].localeCompare(b[k]) * dir || a.bin.localeCompare(b.bin)
  })
}

/** 열 머리 클릭. 같은 열이면 방향만 뒤집고, 다른 열은 오름차순으로 시작한다(nextSvcSort 와 같은 결). */
export function nextPkgSort(cur: PkgSort, key: PkgSortKey): PkgSort {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: false }
}

/** 없는 것도 보기: 조사했지만 안 나온 이름들 — "안 깔려 있다"도 답이다. */
export function missingBins(rows: readonly PkgRow[]): string[] {
  const found = new Set(rows.map((r) => r.bin))
  return PROBE_BINS.filter((b) => !found.has(b))
}

// ── 화면 ────────────────────────────────────────────────────────────────────

const COLS: { key: PkgSortKey; cls: string }[] = [
  { key: 'bin', cls: 'pkg-bin' },
  { key: 'version', cls: 'pkg-ver' },
  { key: 'path', cls: 'pkg-path' },
  { key: 'date', cls: 'pkg-date' }
]

export function PkgTable({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const [rows, setRows] = useState<PkgRow[]>([])
  const [q, setQ] = useState('')
  const [showMissing, setShowMissing] = useState(false)
  const [sort, setSort] = useState<PkgSort>(DEFAULT_PKG_SORT)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')

  const load = useCallback(() => {
    if (!sessionId) return
    setState('loading')
    void window.ev?.remote
      ?.run(sessionId, 'pkg.probe')
      .then((r) => {
        if (!r?.ok) {
          setState('error')
          return
        }
        setRows(parsePkgProbe(r.out))
        setState('idle')
      })
      .catch(() => setState('error'))
  }, [sessionId])

  // 세션이 바뀌면 이전 서버의 목록을 즉시 버린다(F26 R1 CON-8c 와 같은 규칙 — 다른 서버 내용을
  // 이 서버 것인 양 보여 주면 안 된다).
  useEffect(() => {
    setRows([])
    setQ('')
    if (active && sessionId) load()
  }, [sessionId, active, load])

  const shown = useMemo(() => sortPkgs(filterPkgs(rows, q), sort), [rows, q, sort])
  const missing = useMemo(() => missingBins(rows), [rows])

  return (
    <div className="con-pkg" role="grid" aria-label={t('console.tool.pkg')}>
      <div className="con-toolbar">
        <div className="con-field">
          <input
            type="text"
            value={q}
            placeholder={t('console.pkg.search')}
            aria-label={t('console.pkg.search')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') setQ('')
            }}
          />
          {q && (
            <span className="sclear" title={t('conn.search.clear')} onClick={() => setQ('')}>
              <IconClose />
            </span>
          )}
        </div>
        <span className="con-count">{shown.length}</span>
        <label className="con-check">
          <input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} />
          {t('console.pkg.showMissing')}
        </label>
        <button
          type="button"
          className="con-btn"
          data-action="pkg.refresh"
          title={t('sftp.refresh')}
          onClick={load}
        >
          <IconRefresh />
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
                  onClick={() => setSort((s) => nextPkgSort(s, c.key))}
                >
                  {t('console.pkg.col.' + c.key)}
                  {sort.key === c.key && (
                    <span className="con-caret">{sort.desc ? <ChevronDown /> : <ChevronUp />}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr className="pkg-row" key={r.bin} role="row" data-bin={r.bin}>
                <td className="pkg-bin">{r.bin}</td>
                <td className="pkg-ver" title={r.version}>
                  {r.version || '—'}
                </td>
                <td className="pkg-path" title={r.path}>
                  {r.path}
                </td>
                <td className="pkg-date" title={t('console.pkg.dateNote')}>
                  {dateOf(r.installedAt)}
                </td>
              </tr>
            ))}
            {/* 없는 것은 표 아래에 흐리게 붙는다 — 정렬 대상이 아니다("안 깔림"에는 버전도 날짜도 없다). */}
            {showMissing &&
              missing.map((b) => (
                <tr className="pkg-row missing" key={`x-${b}`} data-bin={b}>
                  <td className="pkg-bin">{b}</td>
                  <td className="pkg-ver">{t('console.pkg.absent')}</td>
                  <td className="pkg-path" />
                  <td className="pkg-date" />
                </tr>
              ))}
          </tbody>
        </table>
        {state === 'error' && <div className="con-empty bad">{t('console.pkg.error')}</div>}
        {state === 'loading' && rows.length === 0 && <div className="con-empty">{t('console.pkg.loading')}</div>}
        {state === 'idle' && shown.length === 0 && <div className="con-empty">{t('console.pkg.none')}</div>}
      </div>

      {/* 설치일의 근거를 숨기지 않는다 — 정확한 척하지 않는 것이 이 화면의 신뢰다. */}
      <div className="con-note sm">{t('console.pkg.dateNote')}</div>
    </div>
  )
}
