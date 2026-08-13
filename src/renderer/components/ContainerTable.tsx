import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildCtrExec,
  ctrUnavailable,
  parseContainers,
  sortContainers,
  type CtrAction,
  type CtrRow
} from '@shared/remoteCatalog'
import type { DialogResult, DialogSpec } from './Dialog'
import { t } from '../i18n'

// F28 컨테이너 — 준영님 확인(2026-08-12): 사내에 **도커가 깔린 서버가 있고 SSH 도 된다.**
// 쿠버네티스는 아코디언(웹 콘솔)으로 쓰셔서 kubectl 직접 사용은 확실치 않다 → 이번 라운드는 도커다.
//
// R2(2026-08-13): 조작이 붙었다 — "도커 데스크톱처럼 종료·일시정지·제거·이미지 제거·컨테이너 접속".
// 뼈대는 ServiceTable 을 그대로 따른다: 행을 고르고 → 아래 툴바 → 확인 다이얼로그 → 실패하면
// 런타임이 준 문장 그대로. sudo 는 붙이지 않는다.
//
// **[접속]만 길이 다르다.** `docker exec -it` 는 대화형이라 일회성 exec 채널로는 못 쓴다 —
// F27 AI CLI 실행과 같은 `session.input` 으로 터미널에 보낸다.
//
// 폴링 주기가 프로세스(2.5초)보다 느린 이유: 컨테이너는 초 단위로 뜨고 지지 않는다.

const POLL_MS = 5000

export function filterCtrs(rows: readonly CtrRow[], q: string): CtrRow[] {
  const s = q.trim().toLowerCase()
  if (s === '') return rows.slice()
  return rows.filter(
    (r) => r.name.toLowerCase().includes(s) || r.image.toLowerCase().includes(s) || r.status.toLowerCase().includes(s)
  )
}

/**
 * 고른 행에서 **지금 할 수 있는 일**만 남긴다(순수 — tests/serverConsole.test.ts).
 * 눌러 봐야 런타임이 거절할 버튼은 애초에 내주지 않는다:
 *  · 돌고 있으면 시작할 수 없고, 멈춰 있으면 멈추거나 일시정지할 수 없다.
 *  · 일시정지된 컨테이너는 재개만 된다(그 상태에서 stop 은 도커도 거절한다).
 *  · **제거는 멈춘 것만.** `rm -f` 를 쓰지 않기로 했으니 돌고 있으면 먼저 멈추게 한다.
 */
export function ctrActions(row: CtrRow | null): CtrAction[] {
  if (!row) return []
  if (row.state === 'paused') return ['unpause', 'stop']
  if (row.state === 'running') return ['stop', 'pause', 'restart']
  return ['start', 'rm']
}

/** 되돌리기 어려운 일 — 확인 다이얼로그를 빨갛게 띄운다. */
const DESTRUCTIVE = new Set<CtrAction>(['stop', 'restart', 'rm'])

type Props = {
  sessionId: string | null
  active: boolean
  ask: (spec: DialogSpec) => Promise<DialogResult>
  /** 터미널로 한 줄 보내기(실행까지). [접속]만 이 길을 탄다 — 위 머리주석 참고. */
  onSendInput: (text: string) => void
}

export function ContainerTable({ sessionId, active, ask, onSendInput }: Props) {
  const [rows, setRows] = useState<CtrRow[]>([])
  const [q, setQ] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!sessionId) return
    void window.ev?.remote
      ?.run(sessionId, 'ctr.list')
      .then((r) => {
        if (!r?.ok) {
          setNote(t('console.ctr.error'))
          return
        }
        // 런타임이 없는 것과 "컨테이너가 하나도 없는 것"은 다른 이야기다 — 빈 표로 뭉뚱그리지 않는다.
        if (ctrUnavailable(r.out)) {
          setRows([])
          setNote(t('console.ctr.none.runtime'))
          return
        }
        setNote(null)
        setRows(sortContainers(parseContainers(r.out)))
      })
      .catch(() => setNote(t('console.ctr.error')))
  }, [sessionId])

  // 세션이 바뀌면 이전 서버 목록을 즉시 버린다(F26 CON-8c 규칙).
  useEffect(() => {
    setRows([])
    setNote(null)
    setSelected(null)
    if (!active || !sessionId) return
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId, active, load])

  const shown = useMemo(() => filterCtrs(rows, q), [rows, q])
  // 목록이 폴링으로 갈리므로 선택은 id 로만 들고 행은 매번 다시 찾는다(사라진 컨테이너는 null).
  const row = selected === null ? null : (rows.find((r) => r.id === selected) ?? null)

  const fail = async (title: string, name: string, why: string): Promise<void> => {
    await ask({
      title,
      message: t('console.ctr.act.failMsg'),
      detail: [
        { label: t('console.ctr.col.name'), value: name },
        { label: t('console.ctr.act.reason'), value: why || t('console.ctr.act.noReason') }
      ],
      tone: 'danger',
      confirmLabel: t('dlg.ok'),
      cancelLabel: null
    })
  }

  const act = async (action: CtrAction): Promise<void> => {
    if (!row || !sessionId) return
    const r = await ask({
      title: t('console.ctr.act.title.' + action),
      message: t('console.ctr.act.msg.' + action),
      detail: [
        { label: t('console.ctr.col.name'), value: row.name },
        { label: t('console.ctr.col.image'), value: row.image },
        { label: t('console.ctr.act.state'), value: row.status }
      ],
      ...(DESTRUCTIVE.has(action) ? { tone: 'danger' as const } : {}),
      confirmLabel: t('console.ctr.act.' + action),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    const res = await window.ev?.remote.run(sessionId, 'ctr.action', { id: row.id, action })
    load() // 누른 결과가 바로 표에 보여야 한다(새로고침을 시키지 않는다)
    if (res?.ok && res.code === 0) {
      if (action === 'rm') setSelected(null)
      return
    }
    await fail(t('console.ctr.act.failTitle'), row.name, res?.ok ? res.out.trim() : t('console.err.' + (res?.reason ?? 'exec')))
  }

  const removeImage = async (): Promise<void> => {
    if (!row || !sessionId) return
    const r = await ask({
      title: t('console.ctr.rmi.title'),
      message: t('console.ctr.rmi.msg'),
      detail: [{ label: t('console.ctr.col.image'), value: row.image }],
      tone: 'danger',
      confirmLabel: t('console.ctr.rmi.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    const res = await window.ev?.remote.run(sessionId, 'ctr.rmi', { image: row.image })
    load()
    if (res?.ok && res.code === 0) return
    // 흔한 실패가 "이 이미지를 쓰는 컨테이너가 남아 있다"이다 — 런타임 문장을 그대로 보여 준다.
    await fail(t('console.ctr.rmi.failTitle'), row.image, res?.ok ? res.out.trim() : t('console.err.' + (res?.reason ?? 'exec')))
  }

  const attach = (): void => {
    if (!row) return
    const cmd = buildCtrExec(row.id)
    if (!cmd) return
    // CR 로 끝낸다 — cdCommand·AI CLI 실행과 같은 규칙(LF 만 보내면 줄이 실행되지 않는 셸이 있다).
    onSendInput(cmd + '\r')
  }

  const can = ctrActions(row)

  return (
    <div className="pkg-wrap">
      <div className="con-bar">
        <input
          className="con-field"
          placeholder={t('console.ctr.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="con-btn" onClick={load}>
          {t('console.refresh')}
        </button>
      </div>

      {note && <div className="con-note">{note}</div>}

      <div className="pkg-list">
        {shown.map((r) => (
          <div
            className={
              'ctr-row' + (r.state === 'running' ? '' : ' down') + (r.id === selected ? ' sel' : '')
            }
            key={r.id}
            data-ctr={r.name}
            onClick={() => setSelected((cur) => (cur === r.id ? null : r.id))}
          >
            <span className={'ctr-dot' + (r.state === 'running' ? ' on' : '')} aria-hidden />
            <span className="ctr-name" title={r.id}>
              {r.name}
            </span>
            <span className="ctr-image" title={r.image}>
              {r.image}
            </span>
            <span className="ctr-status" title={r.status}>
              {r.status}
            </span>
            <span className="ctr-ports" title={r.ports}>
              {r.ports}
            </span>
          </div>
        ))}
        {shown.length === 0 && !note && <div className="con-note">{t('console.ctr.none')}</div>}
      </div>

      {/* 조작 줄. 고르기 전에는 전부 잠겨 있고, 고른 컨테이너 상태에 맞는 것만 열린다. */}
      <div className="con-toolbar ctr-acts">
        <span className="con-sect">{row ? row.name : t('console.ctr.pick')}</span>
        <span className="sb-tab-spacer" />
        {(['start', 'stop', 'pause', 'unpause', 'restart'] as const).map((a) => (
          <button
            key={a}
            type="button"
            className="con-btn"
            data-action={'ctr.' + a}
            disabled={!can.includes(a)}
            onClick={() => void act(a)}
          >
            {t('console.ctr.act.' + a)}
          </button>
        ))}
        <button
          type="button"
          className="con-btn"
          data-action="ctr.attach"
          disabled={row?.state !== 'running'}
          onClick={attach}
        >
          {t('console.ctr.attach')}
        </button>
        <button
          type="button"
          className="con-btn danger"
          data-action="ctr.rm"
          disabled={!can.includes('rm')}
          onClick={() => void act('rm')}
        >
          {t('console.ctr.act.rm')}
        </button>
        <button
          type="button"
          className="con-btn danger"
          data-action="ctr.rmi"
          disabled={!row}
          onClick={() => void removeImage()}
        >
          {t('console.ctr.rmi.btn')}
        </button>
      </div>
    </div>
  )
}
