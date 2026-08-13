import { useCallback, useEffect, useMemo, useState } from 'react'
import { parsePkgProbe, PROBE_BINS, type PkgRow } from '@shared/remoteCatalog'
import { t } from '../i18n'

// F26 R3 설치된 프로그램 — 준영님: "설치되어 있는 프로그램 및 버전, 설치 날짜 등. 예를 들어
// node, nginx, npm 등".
//
// 왜 dpkg -l / rpm -qa 가 아닌가: 준영님이 예로 드신 node 는 사내에서 nvm 으로 까는 일이 흔하고,
// nvm·asdf·직접 빌드로 깐 것은 **패키지 목록에 아예 없다.** 그것만 보면 "node 가 설치돼 있지
// 않습니다"라고 거짓말을 하게 된다. 그래서 PATH 에서 직접 찾아 실행해 버전을 받는다.
//
// 폴링하지 않는다 — 설치 목록은 초 단위로 변하지 않는다. 탭을 열 때와 [새로고침] 때만 읽는다.

/** 설치일은 **실행 파일 mtime** 이다(패키지 설치일과 정확히 같지 않다 — 화면이 그 사실을 밝힌다). */
function dateOf(ms: number | null): string {
  if (ms === null) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function filterPkgs(rows: readonly PkgRow[], q: string): PkgRow[] {
  const s = q.trim().toLowerCase()
  if (s === '') return rows.slice()
  return rows.filter((r) => r.bin.toLowerCase().includes(s) || r.version.toLowerCase().includes(s))
}

/** 없는 것도 보기: 조사했지만 안 나온 이름들 — "안 깔려 있다"도 답이다. */
export function missingBins(rows: readonly PkgRow[]): string[] {
  const found = new Set(rows.map((r) => r.bin))
  return PROBE_BINS.filter((b) => !found.has(b))
}

export function PkgTable({ sessionId, active }: { sessionId: string | null; active: boolean }) {
  const [rows, setRows] = useState<PkgRow[]>([])
  const [q, setQ] = useState('')
  const [showMissing, setShowMissing] = useState(false)
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

  const shown = useMemo(() => filterPkgs(rows, q), [rows, q])
  const missing = useMemo(() => missingBins(rows), [rows])

  return (
    <div className="pkg-wrap">
      <div className="con-bar">
        <input
          className="con-field"
          placeholder={t('console.pkg.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="con-check">
          <input type="checkbox" checked={showMissing} onChange={(e) => setShowMissing(e.target.checked)} />
          {t('console.pkg.showMissing')}
        </label>
        <button className="con-btn" onClick={load}>
          {t('console.refresh')}
        </button>
      </div>

      {state === 'error' && <div className="con-note">{t('console.pkg.error')}</div>}
      {state === 'loading' && rows.length === 0 && <div className="con-note">{t('console.pkg.loading')}</div>}

      <div className="pkg-list">
        {shown.map((r) => (
          <div className="pkg-row" key={r.bin}>
            <span className="pkg-bin">{r.bin}</span>
            <span className="pkg-ver">{r.version || '—'}</span>
            <span className="pkg-path" title={r.path}>
              {r.path}
            </span>
            <span className="pkg-date" title={t('console.pkg.dateNote')}>
              {dateOf(r.installedAt)}
            </span>
          </div>
        ))}
        {shown.length === 0 && state === 'idle' && <div className="con-note">{t('console.pkg.none')}</div>}

        {showMissing &&
          missing.map((b) => (
            <div className="pkg-row missing" key={`x-${b}`}>
              <span className="pkg-bin">{b}</span>
              <span className="pkg-ver">{t('console.pkg.absent')}</span>
              <span className="pkg-path" />
              <span className="pkg-date" />
            </div>
          ))}
      </div>

      {/* 설치일의 근거를 숨기지 않는다 — 정확한 척하지 않는 것이 이 화면의 신뢰다. */}
      <div className="con-note sm">{t('console.pkg.dateNote')}</div>
    </div>
  )
}
