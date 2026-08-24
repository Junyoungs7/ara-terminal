import { useCallback, useMemo, useState } from 'react'
import { type CtrPodInfo, type CtrRow } from '@shared/remoteCatalog'
import { IconClose, IconRefresh } from './icons'
import { humanSize } from './filePath'
import { BlockedBox, HelpTip, useCtrList } from './ctrShared'
import { t } from '../i18n'

// 2026-08-24 준영님 — **쿠버는 컨테이너 탭에서 떼어냈다.**
//
//   "만약 쿠버와 도커가 같이 있는 서버면 어떻게 할꺼야? 나였으면 차라리 컨테이너 말고 탭을 하나
//    더 만들어서 쿠버네티스를 포함해줘. 그리고 각각 보이게 하는게 더 좋아보여."
//
// 정확한 지적이었다. 한 표에서 런타임 하나를 고르는 구조는 **둘 다 깔린 서버에서 하나를 감춘다**
// (그 노드가 정확히 그랬다: podman 이 먼저 잡혀 crictl 을 아예 안 물어봤다).
//
// 그리고 이 탭에는 **조작 줄이 없다.** 쿠버는 모니터링이다 — 컨테이너를 멈춰도 kubelet 이 몇 초 뒤
// 되살린다. 있으나 마나 한 버튼을 놓느니 화면 한 줄을 목록에 준다.

// ── 파드 묶기(순수 — tests/serverConsole.test.ts) ───────────────────────────
// 컨테이너를 평평하게 늘어놓으면 `istio-proxy` 가 스무 줄 보인다. **파드로 묶어** 파드 한 줄에
// 요약(준비·재시작·나이·자원)을 얹고, 컨테이너는 그 아래로 접는다.

export type CtrPodGroup = {
  key: string
  ns: string
  name: string
  /** 준비된 컨테이너 수 / 전체. 쿠버에서 제일 먼저 보는 숫자다. */
  readyN: number
  total: number
  /** 파드 샌드박스가 준비됐는가(crictl pods). 목록을 못 받았으면 컨테이너 상태로 미룬다. */
  ready: boolean
  /** 이 파드 안 컨테이너들의 재시작 **합계**. */
  restarts: number
  createdAt: number | null
  /** 자원 합계. 아무도 자료가 없으면 null(0 이 아니다 — "안 쓴다"와 "모른다"는 다르다). */
  cpuNs: number | null
  memBytes: number | null
  rows: CtrRow[]
}

/**
 * 나이 한 칸 — `가동 735일 14시간`(ServerOverview 의 것)은 표의 한 칸에 두 줄로 접힌다.
 * 쿠버의 AGE 처럼 **가장 큰 단위 하나만** 쓴다.
 */
export function ageText(sec: number): string {
  const d = Math.floor(sec / 86400)
  if (d > 0) return t('console.ctr.age.d').replace('{d}', String(d))
  const h = Math.floor(sec / 3600)
  if (h > 0) return t('console.ctr.age.h').replace('{h}', String(h))
  return t('console.ctr.age.m').replace('{m}', String(Math.max(0, Math.floor(sec / 60))))
}

/** 아픈 것부터: ① 준비 안 됨 ② 재시작 있음 ③ 정상. 이 순위가 정렬과 "펼친 채로 시작"을 함께 정한다. */
export function podRank(g: CtrPodGroup): number {
  if (!g.ready || g.readyN < g.total) return 0
  return g.restarts > 0 ? 1 : 2
}

/**
 * 컨테이너 행 + 파드 목록 → 파드 묶음. 파드 목록이 없어도(권한·구버전) 컨테이너의 라벨만으로
 * 묶인다 — 묶음을 못 만들어 화면이 비는 일은 없어야 한다.
 */
export function groupPods(rows: readonly CtrRow[], pods: readonly CtrPodInfo[]): CtrPodGroup[] {
  const known = new Map(pods.map((p) => [p.key, p]))
  const groups = new Map<string, CtrPodGroup>()
  for (const r of rows) {
    const ns = r.ns ?? ''
    const name = r.pod ?? r.name
    const key = ns ? `${ns}/${name}` : name
    let g = groups.get(key)
    if (!g) {
      const info = known.get(key)
      g = {
        key,
        ns,
        name,
        readyN: 0,
        total: 0,
        // 파드 목록이 없으면 "준비됨"으로 두고 컨테이너 수로만 따진다(모르는 것을 고장으로 몰지 않는다).
        ready: info ? info.state === 'ready' : true,
        restarts: 0,
        createdAt: info?.createdAt ?? null,
        cpuNs: null,
        memBytes: null,
        rows: []
      }
      groups.set(key, g)
    }
    g.rows.push(r)
    g.total += 1
    if (r.state === 'running') g.readyN += 1
    g.restarts += r.restarts ?? 0
    if (r.cpuNs !== undefined) g.cpuNs = (g.cpuNs ?? 0) + r.cpuNs
    if (r.memBytes !== undefined) g.memBytes = (g.memBytes ?? 0) + r.memBytes
    // 파드 나이를 못 받았으면 가장 오래된 컨테이너로 대신한다.
    if (g.createdAt === null && r.createdAt !== undefined) g.createdAt = r.createdAt
    else if (g.createdAt !== null && r.createdAt !== undefined && !known.has(key)) {
      g.createdAt = Math.min(g.createdAt, r.createdAt)
    }
  }
  return [...groups.values()].sort(
    (a, b) => podRank(a) - podRank(b) || b.restarts - a.restarts || a.key.localeCompare(b.key)
  )
}

export type PodSortKey = 'health' | 'pod' | 'ready' | 'restarts' | 'age' | 'cpu' | 'mem'
export type PodSort = { key: PodSortKey; desc: boolean }
export const DEFAULT_POD_SORT: PodSort = { key: 'health', desc: false }

/**
 * 파드 정렬. CPU 는 누적 나노초라 그대로 비교하면 "오래 산 파드"가 이긴다 — 화면이 계산한
 * **사용률**을 받아서 쓴다(cpuOf). 값이 없는 파드는 어느 방향이든 아래로(모른다 ≠ 0).
 */
export function sortPodGroups(
  gs: readonly CtrPodGroup[],
  sort: PodSort,
  cpuOf: (g: CtrPodGroup) => number | null = () => null
): CtrPodGroup[] {
  if (sort.key === 'health') {
    const asc = [...gs].sort((a, b) => podRank(a) - podRank(b) || b.restarts - a.restarts || a.key.localeCompare(b.key))
    return sort.desc ? asc.reverse() : asc
  }
  const dir = sort.desc ? -1 : 1
  const num = (g: CtrPodGroup): number | null =>
    sort.key === 'ready'
      ? g.total === 0
        ? null
        : g.readyN / g.total
      : sort.key === 'restarts'
        ? g.restarts
        : sort.key === 'age'
          ? g.createdAt
          : sort.key === 'cpu'
            ? cpuOf(g)
            : g.memBytes
  return [...gs].sort((a, b) => {
    if (sort.key === 'pod') return a.key.localeCompare(b.key) * dir
    const x = num(a)
    const y = num(b)
    if (x === null && y === null) return a.key.localeCompare(b.key)
    if (x === null) return 1
    if (y === null) return -1
    return (x - y) * dir || a.key.localeCompare(b.key)
  })
}

/** 열 머리 클릭 — 숫자 열은 **큰 것부터**, 글자 열은 사전순으로 시작한다(프로세스 표와 같은 결). */
export function nextPodSort(cur: PodSort, key: PodSortKey): PodSort {
  if (cur.key === key) return { key, desc: !cur.desc }
  return { key, desc: key !== 'pod' && key !== 'health' }
}

/** 파드·컨테이너 이름과 이미지로 거른다(검색은 좁히기만 한다). */
export function filterPods(gs: readonly CtrPodGroup[], q: string): CtrPodGroup[] {
  const s = q.trim().toLowerCase()
  if (s === '') return [...gs]
  return gs.filter(
    (g) =>
      g.key.toLowerCase().includes(s) ||
      g.rows.some((r) => r.name.toLowerCase().includes(s) || r.image.toLowerCase().includes(s))
  )
}

// ── 화면 ────────────────────────────────────────────────────────────────────

const COLS: { key: PodSortKey | null; cls: string; label: string }[] = [
  { key: 'health', cls: 'crun', label: 'run' },
  { key: 'pod', cls: 'cpod', label: 'pod' },
  { key: 'ready', cls: 'cready', label: 'ready' },
  { key: 'restarts', cls: 'crst', label: 'restarts' },
  { key: 'age', cls: 'cage', label: 'age' },
  { key: 'cpu', cls: 'ccpu2', label: 'cpu' },
  { key: 'mem', cls: 'cmem2', label: 'mem' },
  { key: null, cls: 'cimg', label: 'image' }
]

export function K8sPanel({
  sessionId,
  active,
  server
}: {
  sessionId: string | null
  active: boolean
  server?: string
}): JSX.Element {
  const feed = useCtrList('k8s.list', sessionId, active, server)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<PodSort>(DEFAULT_POD_SORT)
  // **기본값은 상태가 정한다**(아픈 파드는 펼친 채로 시작). 여기 담기는 건 사람이 그 기본을
  // 뒤집은 파드뿐이다 — 새로고침마다 접은 게 도로 펼쳐지지 않게.
  const [flipped, setFlipped] = useState<Set<string>>(new Set())

  // 파드 한 줄의 CPU 는 자식 합인데, 자식이 하나도 값을 못 받았으면 0% 가 아니라 "모름"이다.
  const cpuOf = useCallback(
    (g: CtrPodGroup): number | null =>
      g.rows.some((r) => feed.cpu.has(r.id)) ? g.rows.reduce((s, r) => s + (feed.cpu.get(r.id) ?? 0), 0) : null,
    [feed.cpu]
  )
  const groups = useMemo(
    () => sortPodGroups(filterPods(groupPods(feed.rows, feed.pods), q), sort, cpuOf),
    [feed.rows, feed.pods, q, sort, cpuOf]
  )

  const toggle = (key: string): void =>
    setFlipped((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const pct = (v: number | null): string => (v === null ? '—' : v.toFixed(1) + '%')
  const mem = (b: number | null): string => (b === null ? '—' : humanSize(b))
  const age = (ms: number | null): string => (ms === null ? '—' : ageText(Math.floor((Date.now() - ms) / 1000)))

  return (
    <div className="con-ctr" role="grid" aria-label={t('console.tool.k8s')}>
      <div className="con-toolbar">
        <div className="con-field">
          <input
            type="text"
            value={q}
            placeholder={t('console.k8s.search')}
            aria-label={t('console.k8s.search')}
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
        <span className="con-count">{groups.length}</span>
        {/* 긴 설명은 물음표 뒤로 — 상주하면 목록 한 줄을 잡아먹는다(준영님). */}
        <HelpTip text={t('console.k8s.help')} />
        <button type="button" className="con-btn" data-action="k8s.refresh" title={t('sftp.refresh')} onClick={feed.reload}>
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
                  onClick={c.key === null ? undefined : () => setSort((p) => nextPodSort(p, c.key!))}
                >
                  {t('console.ctr.col.' + c.label)}
                  {sort.key === c.key && <span className="con-caret">{sort.desc ? '▾' : '▴'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.flatMap((g) => {
              const rank = podRank(g)
              const open = (rank < 2) !== flipped.has(g.key)
              const head = (
                <tr
                  key={g.key}
                  className={'pod-row' + (rank === 0 ? ' bad' : rank === 1 ? ' warn' : '')}
                  data-pod={g.key}
                  onClick={() => toggle(g.key)}
                >
                  <td className="crun">
                    <span className={'ctr-dot' + (rank === 0 ? '' : ' on')} aria-hidden />
                  </td>
                  <td className="cpod">
                    <span className="pod-caret" aria-hidden>
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="pod-name" title={g.key}>
                      <span className="pod-ns">{g.ns ? g.ns + '/' : ''}</span>
                      {g.name}
                    </span>
                  </td>
                  <td className="cready">
                    {t('console.ctr.pod.ready').replace('{n}', String(g.readyN)).replace('{t}', String(g.total))}
                  </td>
                  <td className="crst">{g.restarts}</td>
                  <td className="cage">{age(g.createdAt)}</td>
                  <td className="ccpu2">{pct(cpuOf(g))}</td>
                  <td className="cmem2">{mem(g.memBytes)}</td>
                  <td className="cimg" />
                </tr>
              )
              if (!open) return [head]
              return [
                head,
                ...g.rows.map((r) => (
                  <tr key={r.id} className={'ctr-row k8s' + (r.state === 'running' ? '' : ' down')} data-ctr={r.name}>
                    <td className="crun">
                      <span className={'ctr-dot' + (r.state === 'running' ? ' on' : '')} aria-hidden />
                    </td>
                    <td className="cpod child">
                      <span className="ctr-name" title={r.id}>
                        {r.name}
                      </span>
                    </td>
                    <td className="cready" />
                    <td className={'crst' + ((r.restarts ?? 0) > 0 ? ' warn' : '')}>{r.restarts ?? 0}</td>
                    <td className="cage">{age(r.createdAt ?? null)}</td>
                    <td className="ccpu2">{pct(feed.cpu.has(r.id) ? feed.cpu.get(r.id)! : null)}</td>
                    <td className="cmem2">{mem(r.memBytes ?? null)}</td>
                    <td className="cimg" title={r.image}>
                      {r.image}
                    </td>
                  </tr>
                ))
              ]
            })}
          </tbody>
        </table>

        {feed.blocked && <BlockedBox blocked={feed.blocked} onElevate={feed.elevateNow} />}
        {!feed.blocked && groups.length === 0 && <div className="con-empty">{t('console.k8s.none')}</div>}
      </div>
    </div>
  )
}
