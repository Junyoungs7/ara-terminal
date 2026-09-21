import { ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { buildCtrExec, sortContainers, type CtrAction, type CtrRow, type CtrRuntime } from '@shared/remoteCatalog'
import type { DialogResult, DialogSpec } from './Dialog'
import { IconClose, IconRefresh } from './icons'
import { BlockedBox, useCtrList } from './ctrShared'
import { t } from '../i18n'

// F28 컨테이너 — 준영님 확인(2026-08-12): 사내에 **도커가 깔린 서버가 있고 SSH 도 된다.**
//
// R2(2026-08-13): 조작이 붙었다 — "도커 데스크톱처럼 종료·일시정지·제거·이미지 제거·컨테이너 접속".
// 뼈대는 ServiceTable 을 그대로 따른다: 행을 고르고 → 아래 툴바 → 확인 다이얼로그 → 실패하면
// 런타임이 준 문장 그대로. 쓰기에는 sudo 를 붙이지 않는다(읽기 목록만 권한을 올린다).
//
// **[접속]만 길이 다르다.** `docker exec -it` 는 대화형이라 일회성 exec 채널로는 못 쓴다 —
// F27 AI CLI 실행과 같은 `session.input` 으로 터미널에 보낸다.
//
// 2026-08-24: **쿠버는 여기 없다.** 탭이 갈렸다(K8sPanel) — 한 서버에 도커와 쿠버가 같이 깔린
// 경우 "먼저 찾은 런타임 하나"를 고르는 구조가 나머지를 통째로 감췄다.
//
// #192(2026-09-21): **crictl 은 여기로 왔다.** 탭을 가르는 기준이 런타임 이름이 아니라 **보는
// 층**으로 바뀌었다 — crictl 은 이 노드의 containerd 를 보므로 docker·podman 과 한 탭이고,
// 클러스터가 아는 파드는 [쿠버네티스] 탭의 kubectl 이 본다. 이 표는 노드에 실제로 떠 있는 것만 본다.
// ⚠️ 조작은 여전히 **docker·podman 전용**이다 — 아래 `cri` 주석이 그 이유를 적어 뒀다.

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
 *  · 🔴 **crictl 이면 하나도 없다**(#192 — 아래 컴포넌트의 `cri` 주석이 이유를 적어 뒀다).
 */
export function ctrActions(row: CtrRow | null, runtime?: CtrRuntime): CtrAction[] {
  if (!row || runtime === 'crictl') return []
  if (row.state === 'paused') return ['unpause', 'stop']
  if (row.state === 'running') return ['stop', 'pause', 'restart']
  return ['start', 'rm']
}

/** 되돌리기 어려운 일 — 확인 다이얼로그를 빨갛게 띄운다. */
const DESTRUCTIVE = new Set<CtrAction>(['stop', 'restart', 'rm'])

// ── 정렬(순수 — tests/serverConsole.test.ts) ────────────────────────────────
// 다른 하단 탭과 같은 규격이라 열 머리를 눌러 정렬한다. 기본값만 이 표의 것이다:
// **멈춘 것부터**("왜 안 떠 있지"가 이 화면을 여는 이유).

export type CtrSortKey = 'state' | 'name' | 'image' | 'status'
export type CtrSort = { key: CtrSortKey; desc: boolean }
export const DEFAULT_CTR_SORT: CtrSort = { key: 'state', desc: false }

export function sortCtrs(rows: readonly CtrRow[], sort: CtrSort): CtrRow[] {
  if (sort.key === 'state') {
    const asc = sortContainers(rows)
    return sort.desc ? asc.reverse() : asc
  }
  const dir = sort.desc ? -1 : 1
  return [...rows].sort((a, b) => a[sort.key].localeCompare(b[sort.key]) * dir || a.name.localeCompare(b.name))
}

export function nextCtrSort(cur: CtrSort, key: CtrSortKey): CtrSort {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: false }
}

// ── 화면 ────────────────────────────────────────────────────────────────────

const COLS: { key: CtrSortKey | null; cls: string; label: string }[] = [
  { key: 'state', cls: 'crun', label: 'run' },
  { key: 'name', cls: 'cname', label: 'name' },
  { key: 'image', cls: 'cimg', label: 'image' },
  { key: 'status', cls: 'cstat', label: 'status' },
  { key: null, cls: 'cports', label: 'ports' }
]

type Props = {
  sessionId: string | null
  /** 확인창이 찍을 서버 이름(2026-08-16) — 두 서버를 동시에 볼 수 있는 구조라 대상을 밝혀야 한다. */
  server?: string
  active: boolean
  ask: (spec: DialogSpec) => Promise<DialogResult>
  /** 터미널로 한 줄 보내기(실행까지). [접속]만 이 길을 탄다 — 위 머리주석 참고. */
  onSendInput: (text: string) => void
}

export function ContainerTable({ sessionId, active, server, ask, onSendInput }: Props): JSX.Element {
  const feed = useCtrList('ctr.list', sessionId, active, server)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<CtrSort>(DEFAULT_CTR_SORT)
  const [selected, setSelected] = useState<string | null>(null)

  const shown = useMemo(() => sortCtrs(filterCtrs(feed.rows, q), sort), [feed.rows, q, sort])
  // 목록이 폴링으로 갈리므로 선택은 id 로만 들고 행은 매번 다시 찾는다(사라진 컨테이너는 null).
  const row = selected === null ? null : (feed.rows.find((r) => r.id === selected) ?? null)
  /**
   * 🔴 #192(2026-09-21) — **crictl 이 이 탭으로 왔다. 조작은 따라오지 않았다.**
   *
   * `ctrCmd`·`buildCtrExec` 는 docker·podman 만 찾는다. crictl 뿐인 노드에서 그 명령은
   * `if …; elif …; fi` 의 어느 갈래도 안 타고 **종료코드 0 · 빈 출력**으로 돌아온다 —
   * 아래 act() 가 그걸 성공으로 읽어 "눌렀는데 아무 일도 안 일어남"이 된다(가장 조용한 실패다).
   * CRI 에 없는 명령도 있다(`pause`). 애초에 쿠버는 조작할 물건이 아니다 — kubelet 이 되살린다.
   * 그래서 **버튼을 잠근다**: 눌러 봐야 거절당할 버튼은 내주지 않는다(이 파일의 원래 규칙).
   */
  const cri = feed.runtime === 'crictl'
  const can = ctrActions(row, feed.runtime)

  const fail = async (title: string, name: string, why: string): Promise<void> => {
    await ask({
      title,
      message: t('console.ctr.act.failMsg'),
      detail: [
        ...(server ? [{ label: t('conn.fail.server'), value: server }] : []),
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
        ...(server ? [{ label: t('conn.fail.server'), value: server }] : []),
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
    feed.reload() // 누른 결과가 바로 표에 보여야 한다(새로고침을 시키지 않는다)
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
    feed.reload()
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

  return (
    <div className="con-ctr" role="grid" aria-label={t('console.tool.ctr')}>
      <div className="con-toolbar">
        <div className="con-field">
          <input
            type="text"
            value={q}
            placeholder={t('console.ctr.search')}
            aria-label={t('console.ctr.search')}
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
        <button type="button" className="con-btn" data-action="ctr.refresh" title={t('sftp.refresh')} onClick={feed.reload}>
          <IconRefresh />
        </button>
      </div>

      {feed.note && <div className="con-note">{feed.note}</div>}

      <div className="con-tblwrap">
        <table className="con-tbl">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.label}
                  className={c.cls + (c.key === null ? ' fixed' : sort.key === c.key ? ' on' : '')}
                  data-col={c.key ?? c.label}
                  onClick={c.key === null ? undefined : () => setSort((p) => nextCtrSort(p, c.key!))}
                >
                  {t('console.ctr.col.' + c.label)}
                  {sort.key === c.key && (
                    <span className="con-caret">{sort.desc ? <ChevronDown /> : <ChevronUp />}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                className={'ctr-row' + (r.state === 'running' ? '' : ' down') + (r.id === selected ? ' sel' : '')}
                data-ctr={r.name}
                // 2026-08-28 감사 ④: 여기만 **토글**이었다(다시 누르면 선택 해제). 선택은 아래
                // [정지]·[제거]·[강제 종료]를 무장하는 값이라, [제거] 전에 행을 다시 눌러 확인한
                // 사용자가 모든 버튼이 조용히 꺼지는 것을 겪었다. 형제 표(프로세스·서비스)처럼
                // 누른 행을 그냥 고른다 — 같은 제스처가 탭마다 다른 뜻이면 안 된다.
                onClick={() => setSelected(r.id)}
              >
                <td className="crun">
                  <span className={'ctr-dot' + (r.state === 'running' ? ' on' : '')} aria-hidden />
                </td>
                <td className="cname">
                  <span className="ctr-name" title={r.id}>
                    {r.name}
                  </span>
                </td>
                <td className="cimg" title={r.image}>
                  {r.image}
                </td>
                <td className="cstat" title={r.status}>
                  {r.status}
                </td>
                <td className="cports" title={r.ports}>
                  {r.ports}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {feed.blocked && <BlockedBox blocked={feed.blocked} onElevate={feed.elevateNow} />}
        {!feed.blocked && shown.length === 0 && (
          <div className="con-empty">{t(feed.loading ? 'console.ctr.loading' : 'console.ctr.none')}</div>
        )}
      </div>

      {/* 조작 줄. 고르기 전에는 전부 잠겨 있고, 고른 컨테이너 상태에 맞는 것만 열린다. */}
      <div className="con-toolbar ctr-acts">
        <span className="con-sect">{cri ? t('console.ctr.pick.cri') : row ? row.name : t('console.ctr.pick')}</span>
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
          disabled={cri || row?.state !== 'running'}
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
          disabled={cri || !row}
          onClick={() => void removeImage()}
        >
          {t('console.ctr.rmi.btn')}
        </button>
      </div>
    </div>
  )
}
