import { ChevronDown, ChevronUp, Terminal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  K8S_DEFAULT_NS,
  K8S_NS_PREFIX,
  buildK8sExec,
  parseNamespaces,
  type CtrPodInfo,
  type CtrRow
} from '@shared/remoteCatalog'
import type { DialogResult, DialogSpec } from './Dialog'
import { Dropdown } from './Dropdown'
import { IconClose, IconCopy, IconRefresh } from './icons'
import { humanSize } from './filePath'
import { writeClipboard } from '../store/clipboardWrite'
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
// #192(2026-09-21) — **이 탭은 이제 kubectl 이다**(다른 개발자 피드백). crictl 은 노드의
// containerd 를 보므로 컨테이너 탭으로 옮겼고, 여기는 클러스터가 아는 파드를 본다.
// 조작 줄은 여전히 없다: 컨테이너를 멈춰도 kubelet 이 몇 초 뒤 되살린다.
//
// 🔴 **파드 안으로 들어가는 것만 예외다**(UI-4 아래). 그 길은 카탈로그를 안 지나고 터미널로 가므로
// 아라가 쓸 수 없다 — 준영님 확정(2026-09-16: "아라에게 exec 를 주지 않는다")이 노린 결과다.

// ── 파드 묶기(순수 — tests/serverConsole.test.ts · tests/k8sParse.test.ts) ──
// 컨테이너를 평평하게 늘어놓으면 `istio-proxy` 가 스무 줄 보인다. **파드로 묶어** 파드 한 줄에
// 요약(준비·재시작·나이·자원)을 얹고, 컨테이너는 그 아래로 접는다.

export type CtrPodGroup = {
  key: string
  ns: string
  name: string
  /** 준비된 컨테이너 수 / 전체. 쿠버에서 제일 먼저 보는 숫자다. */
  readyN: number
  total: number
  /** 파드가 준비됐는가(kubectl 의 phase+ready, 예전 crictl 의 샌드박스). 모르면 컨테이너 상태로 미룬다. */
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

/**
 * [전체]의 값 — 카탈로그가 `-A` 로 바꾼다. RFC1123 은 소문자 ASCII 뿐이라 진짜 네임스페이스
 * 이름과 겹칠 수 없다(셀렉트가 이름 목록과 한 줄에 섞여도 안전한 이유).
 */
const NS_ALL = '*'

/**
 * 서버별로 고른 네임스페이스 — **앱이 켜져 있는 동안** 기억한다(ELEVATED 와 같은 방식·같은 열쇠).
 * 탭을 닫았다 열거나 다른 탭에 갔다 와도 방금 보던 네임스페이스가 그대로다.
 */
const K8S_NS = new Map<string, string>()

/** 세부 보기 한 칸 — 파드 하나에 대해 한 번에 하나만 연다(둘을 동시에 열 이유가 없다). */
type PodDetail = {
  key: string
  tab: 'describe' | 'yaml'
  text: string
  /** 서버가 거절했다 — 본문 대신 이 문장을 보여 준다. */
  err: string | null
  loading: boolean
}

export function K8sPanel({
  sessionId,
  active,
  server,
  ask,
  onSendInput
}: {
  sessionId: string | null
  active: boolean
  server?: string
  /** 파드 안으로 들어가기 전 확인창(대상을 이름으로 적는다). */
  ask: (spec: DialogSpec) => Promise<DialogResult>
  /** 터미널로 한 줄 보내기(실행까지). exec 만 이 길을 탄다 — 머리주석 UI-4. */
  onSendInput: (text: string) => void
}): JSX.Element {
  const srvKey = server ?? sessionId ?? ''
  const [ns, setNs] = useState(() => K8S_NS.get(srvKey) ?? K8S_DEFAULT_NS)
  // 목록을 못 받았으면 null — 그때는 셀렉트를 **감춘다**(빈 셀렉트는 고를 것이 없는데 자리만 먹는다).
  const [nsList, setNsList] = useState<string[] | null>(null)
  const feed = useCtrList('k8s.list', sessionId, active, server, ns)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<PodSort>(DEFAULT_POD_SORT)
  const [detail, setDetail] = useState<PodDetail | null>(null)

  // 서버가 바뀌면 그 서버가 마지막에 보던 네임스페이스로 돌아간다.
  useEffect(() => setNs(K8S_NS.get(srvKey) ?? K8S_DEFAULT_NS), [srvKey])

  // 네임스페이스 목록은 **탭을 열 때 한 번**만 묻는다 — 폴링에 태울 자료가 아니다(거의 안 바뀐다).
  // 실패는 조용히 넘긴다: 목록 권한이 없는 계정이 흔하고(클러스터 전역 권한이다), 그게 탭
  // 전체를 막을 이유는 없다 — 셀렉트만 사라지고 기본 네임스페이스 조회는 그대로 돈다.
  useEffect(() => {
    // 세션이 바뀌면 이전 서버의 목록·세부를 **즉시 버린다**(useCtrList 의 초기화와 같은 규칙).
    setNsList(null)
    setDetail(null)
    if (!active || !sessionId) return
    let alive = true
    void window.ev?.remote
      ?.run(sessionId, 'k8s.ns')
      .then((r) => {
        if (!alive) return
        const all = r?.ok ? parseNamespaces(r.out) : []
        // 준영님 확정: 셀렉트에는 `vgt-` 로 시작하는 것만. 나머지는 [전체]로 본다.
        const mine = all.filter((n) => n.startsWith(K8S_NS_PREFIX))
        setNsList(mine.length > 0 ? mine : null)
      })
      .catch(() => {
        if (alive) setNsList(null)
      })
    return () => {
      alive = false
    }
  }, [sessionId, active])

  const pickNs = (v: string): void => {
    K8S_NS.set(srvKey, v)
    setNs(v)
    setDetail(null) // 남의 네임스페이스에서 받아 둔 yaml 이 남아 있으면 안 된다
  }
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

  /**
   * [describe]·[YAML] — **누를 때 한 번** 부른다. 폴링에 태우지 않는 이유: 5초마다 yaml 을 다시
   * 받으면 사람이 읽던 자리에서 스크롤이 튄다. 다시 누르면 새로고침이다.
   */
  const openDetail = async (g: CtrPodGroup, tab: 'describe' | 'yaml'): Promise<void> => {
    if (!sessionId) return
    setDetail({ key: g.key, tab, text: '', err: null, loading: true })
    const res = await window.ev?.remote.run(sessionId, tab === 'yaml' ? 'k8s.yaml' : 'k8s.describe', {
      ns: g.ns,
      pod: g.name
    })
    const out = res?.ok ? res.out : ''
    setDetail({
      key: g.key,
      tab,
      text: out,
      // 종료코드가 0 이 아니면 kubectl 이 거절한 것이다 — 그 문장이 본문이자 이유다.
      err: res?.ok ? (res.code === 0 ? null : out.trim() || t('console.k8s.detail.fail')) : t('console.err.' + (res?.reason ?? 'exec')),
      loading: false
    })
  }

  /**
   * 🔴 UI-4 — 파드 안으로 들어가기. **사람만 쓰는 길이다.**
   *
   * 명령줄을 조립해 터미널(`session.input`)에 보낸다 — 이 경로는 명령 표(COMMANDS)를 지나지
   * 않으므로 `server_run` 으로 부를 수 없다. 그것이 준영님 확정(2026-09-16: "아라에게 exec 를
   * 주지 않는다")을 코드로 지키는 방식이다: 도구를 만들어 놓고 설명에서 빼는 게 아니라, 애초에
   * 도구가 아니다.
   *
   * 확인창에 **namespace·pod·container 를 이름으로** 적는다(준영님 확정) — 하단 패널과 터미널이
   * 서로 다른 서버를 볼 수 있는 구조라, 어디로 들어가는지는 화면이 말해 줘야 한다.
   */
  const attach = async (g: CtrPodGroup, container: string): Promise<void> => {
    const cmd = buildK8sExec(g.ns, g.name, container)
    if (cmd === null) return
    const r = await ask({
      title: t('console.k8s.exec.title'),
      message: t('console.k8s.exec.msg'),
      detail: [
        ...(server ? [{ label: t('conn.fail.server'), value: server }] : []),
        { label: t('console.k8s.f.ns'), value: g.ns },
        { label: t('console.k8s.f.pod'), value: g.name },
        { label: t('console.ctr.col.name'), value: container }
      ],
      confirmLabel: t('console.k8s.exec.btn'),
      cancelLabel: t('dlg.cancel')
    })
    if (r !== 'confirm') return
    // CR 을 붙여 **바로 실행한다.** 준영님 확정이 "열 때 확인"이므로 위 다이얼로그가 이미 그
    // 확인이다 — 여기서 한 번 더 사람이 Enter 를 쳐야 하면 확인을 두 번 받는 셈이다.
    // (컨테이너 탭의 [접속]·AI CLI 실행과 같은 규칙: LF 만 보내면 실행 안 되는 셸이 있다.)
    onSendInput(cmd + '\r')
  }

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
        {/* 네임스페이스 고르기(#192). 목록을 못 받았으면 **감춘다** — 고를 것이 없는 셀렉트는
            자리만 먹고, 그래도 조회는 기본 네임스페이스로 계속 돈다. */}
        {nsList !== null && (
          <div className="k8s-ns">
            <Dropdown
              value={ns === NS_ALL ? t('console.k8s.ns.all') : ns}
              options={[t('console.k8s.ns.all'), ...(nsList.includes(ns) || ns === NS_ALL ? nsList : [ns, ...nsList])]}
              ariaLabel={t('console.k8s.ns.label')}
              onChange={(v) => pickNs(v === t('console.k8s.ns.all') ? NS_ALL : v)}
            />
          </div>
        )}
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
                  {sort.key === c.key && (
                    <span className="con-caret">{sort.desc ? <ChevronDown /> : <ChevronUp />}</span>
                  )}
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
                    <span className={'pod-caret' + (open ? '' : ' closed')} aria-hidden>
                      <ChevronDown />
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
              // 이 파드의 세부를 보고 있나 — 아니면 [개요](컨테이너 목록)다.
              const d = detail?.key === g.key ? detail : null
              const tabs = (
                <tr key={g.key + ':tabs'} className="pod-detail">
                  <td className="crun" />
                  <td colSpan={COLS.length - 1}>
                    <div className="pd-tabs" role="tablist" aria-label={t('console.k8s.detail.label')}>
                      {(['overview', 'describe', 'yaml'] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          role="tab"
                          aria-selected={(d?.tab ?? 'overview') === tab}
                          className={'pd-tab' + ((d?.tab ?? 'overview') === tab ? ' on' : '')}
                          data-action={'k8s.' + tab}
                          onClick={() => (tab === 'overview' ? setDetail(null) : void openDetail(g, tab))}
                        >
                          {t('console.k8s.tab.' + tab)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )
              if (d)
                return [
                  head,
                  tabs,
                  <tr key={g.key + ':text'} className="pod-detail">
                    <td className="crun" />
                    <td colSpan={COLS.length - 1}>
                      {d.loading ? (
                        <div className="pd-note">{t('console.k8s.detail.loading')}</div>
                      ) : d.err ? (
                        <div className="pd-note bad">{d.err}</div>
                      ) : (
                        <pre className="pd-text">{d.text}</pre>
                      )}
                      <div className="pd-acts">
                        <button
                          type="button"
                          className="con-btn"
                          data-action="k8s.copy"
                          disabled={d.loading || d.text === ''}
                          onClick={() => void writeClipboard(d.text, true)}
                        >
                          <IconCopy />
                          {t('console.k8s.copy')}
                        </button>
                        {/* 긴 yaml 은 터미널에서 less·grep 으로 보는 편이 낫다 — 같은 명령을 그대로 보낸다. */}
                        <button
                          type="button"
                          className="con-btn"
                          data-action="k8s.send"
                          onClick={() =>
                            onSendInput(
                              (d.tab === 'yaml'
                                ? `kubectl get pod ${g.name} -n ${g.ns} -o yaml`
                                : `kubectl describe pod ${g.name} -n ${g.ns}`) + '\r'
                            )
                          }
                        >
                          {t('console.k8s.send')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ]
              return [
                head,
                tabs,
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
                    <td className="cready">
                      {/* 🔴 파드 안으로 들어가기 — 사람만 쓰는 길(머리주석 UI-4). 확인창이 대상을 이름으로 적는다. */}
                      <button
                        type="button"
                        className="pd-exec"
                        data-action="k8s.exec"
                        title={t('console.k8s.exec.btn')}
                        aria-label={t('console.k8s.exec.btn')}
                        onClick={() => void attach(g, r.name)}
                      >
                        <Terminal />
                      </button>
                    </td>
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
        {!feed.blocked && groups.length === 0 && (
          <div className="con-empty">{t(feed.loading ? 'console.k8s.loading' : 'console.k8s.none')}</div>
        )}
      </div>
    </div>
  )
}
