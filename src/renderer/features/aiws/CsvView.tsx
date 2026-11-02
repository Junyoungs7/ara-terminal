// 3차 R1-B CSV/TSV 표 보기 — 정렬되는 열·빠른 검색(Orca viewers.mdx "sortable columns and quick search"). DocSurface 가 lazy 로 부른다.
// 출처: stablyai/orca @ec112c6b01 (MIT) components/editor/csv/CsvViewer.tsx·CsvTableToolbar.tsx(검색·줄 수)·csv-parse.ts·csv-delimiter-detection.ts.
// 표는 읽기 전용 — 칸을 고치려면 [원문](Orca 도 "flip back to the raw text view if you need to edit cells").
// 뺀 것: 칸 편집·칸 선택/복사·열 폭 끌기·구분자 고르기·쪽 나눔 미리 보기(1MB 넘으면 원문만)·가상 스크롤(CSV_RENDER_ROWS 줄까지 그림).
import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowDown, ArrowUp, Search } from 'lucide-react'
import { CSV_RENDER_ROWS, CSV_TABLE_MAX_BYTES, csvBodyView, detectCsvDelimiter, exceedsUtf8ByteLimit, nextCsvSort, parseCsv, type CsvSort } from '@shared/docView'
import { t } from '../../i18n'
import type { DocProps } from './DocSurface'

export default function CsvView({ file, model }: DocProps): JSX.Element {
  const [text, setText] = useState(() => model.get())
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<CsvSort>(null)
  useEffect(() => model.onChange(() => setText(model.get())), [model])
  const tooBig = exceedsUtf8ByteLimit(text, CSV_TABLE_MAX_BYTES)
  const delim = useMemo(() => detectCsvDelimiter(file.path, text), [file.path, text])
  const rows = useMemo(() => (tooBig ? [] : parseCsv(text, delim)), [text, delim, tooBig])
  const body = useMemo(() => csvBodyView(rows, q, sort), [rows, q, sort])
  if (tooBig) return <p className="doc-fallback">{t('doc.csv.tooBig')}</p>
  const head = rows[0] ?? []
  const cols = Math.max(head.length, ...rows.slice(1, 200).map((r) => r.length))
  const shown = body.slice(0, CSV_RENDER_ROWS)
  return (
    <div className="csv-view" data-doc="csv" data-delim={delim === '\t' ? 'tab' : delim}>
      <div className="csv-bar">
        <label className="csv-search">
          <Search aria-hidden />
          <input type="search" data-field="csv-search" placeholder={t('doc.csv.search')} aria-label={t('doc.csv.search')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </label>
        <span className="csv-count" data-doc="csv-count">
          {t('doc.csv.rows').replace('{n}', String(body.length)).replace('{total}', String(Math.max(0, rows.length - 1)))}
        </span>
      </div>
      <div className="doc-scroll">
        <table className="csv-table">
          <thead>
            <tr>
              <th className="csv-num" aria-hidden />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} aria-sort={sort?.col === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" data-csv-col={c} onClick={() => setSort((s) => nextCsvSort(s, c))}>
                    <span>{head[c] ?? ''}</span>
                    {sort?.col === c && (sort.dir === 'asc' ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ row, index }) => (
              <tr key={index} data-csv-row={index}>
                <td className="csv-num">{index}</td>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {body.length > shown.length && <p className="csv-more">{t('doc.csv.more').replace('{n}', String(body.length - shown.length))}</p>}
        {body.length === 0 && rows.length > 1 && <p className="csv-more">{t('doc.csv.none')}</p>}
      </div>
    </div>
  )
}
