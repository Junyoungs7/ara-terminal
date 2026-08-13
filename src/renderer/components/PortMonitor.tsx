import { useState } from 'react'
import type { PortForward, RemotePort } from '@shared/types'
import { IconRefresh, IconClose } from './icons'
import { t } from '../i18n'

// [모니터] 탭 — 활성 SSH 세션의 리슨 포트↔프로세스 (W1 F9 / design-system 5.2 파일 행과 같은 행 규격).
// W2 F8: 행에서 바로 포워딩을 만들고(↗) 내장 브라우저로 연다(열기).
//
//   8765  tcp   node    41231                      [↗]     ← 호버 시 포워딩 버튼
//   3000  tcp   vite    41288   → localhost:3000   [열기]  ← 포워딩 활성: 액센트 배지 + 열기 버튼
//
// 포워딩은 **이 클릭에서만** 만들어진다. 폴링이 포트를 발견했다는 이유로 자동 생성하지 않는다 —
// "자동 포트포워딩"은 포트 번호를 사람이 찾아 옮겨 적지 않아도 된다는 뜻이지 몰래 여는 뜻이 아니다.
// 목록은 2.5초 폴링으로 저절로 갱신되고, 새로고침 버튼은 그 사이를 못 기다릴 때 즉시 한 바퀴 돌린다.
//
// FB-monitor(FB-0003): tmux 버튼 줄은 트리 우클릭 서브메뉴로 옮겼다(interactions/actions.tsx
// tmuxMenuItem) — 이 탭은 다시 포트 목록 전용이다.
//
// FB-monitor(FB-0003): "전체 다 보여줘서 불편하다 · 검색이 안 된다" — 검색어(포트·프로세스명)와
// 범위(시스템 포트 <1024 숨김/전체) 필터를 추가한다. 기본값은 사용자 포트만(개발 서버 위주) —
// 실사용 서버는 sshd·nginx 등 시스템 포트가 늘 켜져 있어 그게 먼저 보이면 원하는 포트를 못 찾는다.

export type PortRange = 'user' | 'all'
const USER_PORT_MIN = 1024

// 포워딩 상태 필터. 'free' = 아직 내 PC 로 안 연결한 포트(= 지금 쓰고 있지 않은 것)만 — 서버에
// 뭐가 떠 있는지가 아니라 "내가 아직 안 쓴 게 뭐지"를 찾을 때 쓴다.
export type PortUse = 'any' | 'fwd' | 'free'

/** 사용자가 입력한 범위(비워 두면 제한 없음). */
export type PortSpan = { min: number | null; max: number | null }

export type PortFilterResult = {
  visible: RemotePort[]
  // range='user' 필터로 감춘 개수(검색어 적용 전 기준 — 검색과 무관하게 "감춘 게 있다"를 알려준다).
  hiddenByRange: number
}

// 순수 함수(단위 테스트 대상). 정렬은 이미 parsePorts(main)가 포트 번호 오름차순으로 끝냈다 — 여기선 거르기만.
// 조건은 전부 AND — 좁히는 도구지 넓히는 도구가 아니다.
export function filterPorts(
  ports: readonly RemotePort[],
  range: PortRange,
  query: string,
  span: PortSpan = { min: null, max: null },
  use: PortUse = 'any',
  forwardedPorts: readonly number[] = []
): PortFilterResult {
  const inRange = range === 'user' ? ports.filter((p) => p.port >= USER_PORT_MIN) : ports
  const hiddenByRange = ports.length - inRange.length
  const q = query.trim().toLowerCase()
  const fwd = new Set(forwardedPorts)
  const visible = inRange.filter((p) => {
    if (q && !(String(p.port).includes(q) || (p.process ?? '').toLowerCase().includes(q))) return false
    if (span.min !== null && p.port < span.min) return false
    if (span.max !== null && p.port > span.max) return false
    if (use === 'fwd' && !fwd.has(p.port)) return false
    if (use === 'free' && fwd.has(p.port)) return false
    return true
  })
  return { visible: [...visible], hiddenByRange }
}

/**
 * 구간 안에서 **아무도 리슨하지 않는** 포트(= 지금 쓸 수 있는 번호). 순수 함수.
 * "8000~9000 만 방화벽에 열려 있는데 어디가 비었는지 모르겠다"에 대한 답이다 — 목록은 이미 폴링해
 * 갖고 있으니 원격에 뭘 더 묻지 않는다. 표시용이라 앞에서 limit 개만 돌려주고 총 개수를 함께 준다.
 *
 * 한계: 판단 근거는 `ss -tln`(TCP 리슨)이다. UDP 로만 잡힌 포트, 또는 지금 이 순간 다른 프로세스가
 * 집어 가는 경우까지는 알 수 없다 — "확실히 비어 있다"가 아니라 "리슨 중이 아니다"로 읽어야 한다.
 */
export function freePorts(
  ports: readonly RemotePort[],
  span: PortSpan,
  limit = 12
): { list: number[]; total: number } {
  if (span.min === null || span.max === null || span.max < span.min) return { list: [], total: 0 }
  const used = new Set(ports.map((p) => p.port))
  const list: number[] = []
  let total = 0
  for (let p = span.min; p <= span.max; p++) {
    if (used.has(p)) continue
    total++
    if (list.length < limit) list.push(p)
  }
  return { list, total }
}

/** 입력칸 문자열 → 포트 번호(빈 값·숫자 아님·범위 밖이면 null = 제한 없음). */
export function parsePortInput(v: string): number | null {
  const n = Number(v.trim())
  return Number.isInteger(n) && n >= 0 && n <= 65535 && v.trim() !== '' ? n : null
}

type PortMonitorProps = {
  ports: RemotePort[]
  // 이 세션의 활성 포워딩(main 이 진실). 행과는 remotePort 로 맞춘다.
  forwards: PortForward[]
  sessionId: string | null
  isSsh: boolean
  onRefresh: () => void
  // 생성·해제 직후 목록을 즉시 다시 읽게 한다(폴링 한 바퀴를 기다리지 않는다).
  onForwardsChanged: () => void
}

export function PortMonitor({ ports, forwards, sessionId, isSsh, onRefresh, onForwardsChanged }: PortMonitorProps) {
  // FB-0003: 세션을 바꿔도 사용자가 고른 필터는 유지한다 — 서버마다 매번 다시 고르게 하지 않는다.
  const [range, setRange] = useState<PortRange>('user')
  const [query, setQuery] = useState('')
  const [minStr, setMinStr] = useState('')
  const [maxStr, setMaxStr] = useState('')
  const [use, setUse] = useState<PortUse>('any')

  if (!isSsh) return <span className="sb-placeholder">{t('mon.needSsh')}</span>

  const span = { min: parsePortInput(minStr), max: parsePortInput(maxStr) }
  const { visible, hiddenByRange } = filterPorts(ports, range, query, span, use, forwards.map((f) => f.remotePort))
  // 구간을 양쪽 다 적었을 때만 빈 포트를 센다 — 한쪽만 적으면 6만 개를 세게 된다.
  // range='user' 로 1024 미만이 가려져 있어도 계산은 **전체 목록**으로 한다(가려진 포트도 쓰이는 중이다).
  const free = freePorts(ports, span)
  const fwdOf = (port: number): PortForward | undefined => forwards.find((f) => f.remotePort === port)

  // [열기] 한 번으로 끝낸다. 포워딩이 없으면 만들고 나서 그 로컬 포트를 연다 —
  // 예전엔 ↗(만들기)를 누른 **다음** [열기]를 눌러야 해서 두 번 클릭이었다(준영님 제보).
  const openPort = async (port: number): Promise<void> => {
    const existing = fwdOf(port)
    if (existing) {
      void window.ev?.browser.open(`http://localhost:${existing.localPort}`)
      return
    }
    if (!sessionId) return
    const res = await window.ev?.forward.create(sessionId, port).catch(() => null)
    onForwardsChanged()
    if (res && res.ok) void window.ev?.browser.open(`http://localhost:${res.forward.localPort}`)
  }
  const stopForward = (id: string): void => {
    void window.ev?.forward
      .stop(id)
      .catch(() => null)
      .then(onForwardsChanged)
  }

  return (
    <div className="pmon">
      <div className="sftp-path-bar">
        <span className="pmon-title">{t('mon.title')}</span>
        <span className="pmon-count">{visible.length}</span>
        <div className="sb-tab-spacer" />
        <div className="sb-act" title={t('sftp.refresh')} onClick={onRefresh}>
          <IconRefresh />
        </div>
      </div>
      {/* FB-0003: 사이드바 [연결] 탭 검색 필드와 같은 패턴(.sb-search .field) 재사용 — 새 컴포넌트 없음. */}
      <div className="sb-search">
        <div className="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder={t('mon.search.placeholder')}
            aria-label={t('mon.search.placeholder')}
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
      </div>
      <div className="pmon-filter-row">
        <div className="seg-ctl pmon-range">
          <button type="button" className={range === 'user' ? 'on' : ''} data-value="user" onClick={() => setRange('user')}>
            {t('mon.range.user')}
          </button>
          <button type="button" className={range === 'all' ? 'on' : ''} data-value="all" onClick={() => setRange('all')}>
            {t('mon.range.all')}
          </button>
        </div>
        {range === 'user' && hiddenByRange > 0 && (
          <span className="pmon-hidden">
            {hiddenByRange}
            {t('mon.range.hiddenSuffix')}
          </span>
        )}
      </div>
      {/* 번호 구간 + 포워딩 상태. 둘 다 비워 두면 아무 것도 안 거른다(기본값 = 지금까지와 같은 화면). */}
      <div className="pmon-filter-row">
        <span className="pmon-span">
          <input
            type="text"
            inputMode="numeric"
            className="pspan"
            value={minStr}
            placeholder={t('mon.span.min')}
            aria-label={t('mon.span.min')}
            onChange={(e) => setMinStr(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="pspan-dash">–</span>
          <input
            type="text"
            inputMode="numeric"
            className="pspan"
            value={maxStr}
            placeholder={t('mon.span.max')}
            aria-label={t('mon.span.max')}
            onChange={(e) => setMaxStr(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </span>
        <div className="seg-ctl pmon-use">
          {(['any', 'fwd', 'free'] as PortUse[]).map((v) => (
            <button
              key={v}
              type="button"
              className={use === v ? 'on' : ''}
              data-value={v}
              title={t('mon.use.' + v + '.title')}
              onClick={() => setUse(v)}
            >
              {t('mon.use.' + v)}
            </button>
          ))}
        </div>
      </div>
      {/* 빈 포트 — 방화벽이 특정 구간만 열어 준 서버에서 "어디를 쓸 수 있지"를 바로 답한다.
          클릭하면 번호가 클립보드로 간다(그대로 명령에 붙여 쓰라고). */}
      {span.min !== null && span.max !== null && (
        <div className="pmon-free">
          <span className="pfree-sum">
            {t('mon.free.count').replace('{n}', String(free.total))}
          </span>
          {free.list.map((p) => (
            <span
              key={p}
              className="pfree-chip"
              title={t('mon.free.copy')}
              onClick={() => void navigator.clipboard?.writeText(String(p)).catch(() => {})}
            >
              {p}
            </span>
          ))}
          {free.total > free.list.length && <span className="pfree-more">…</span>}
        </div>
      )}
      <div className="pmon-list">
        {ports.length === 0 && <div className="sftp-empty">{t('mon.empty')}</div>}
        {ports.length > 0 && visible.length === 0 && <div className="sftp-empty">{t('mon.noMatch')}</div>}
        {visible.map((p) => {
          const fwd = fwdOf(p.port)
          // 사이드바는 좁다(기본 264px). 포워딩이 붙으면 pid 는 접고 배지도 짧게 쓴다 —
          // 대신 행 툴팁이 프로세스·pid·목적지를 전부 들고 있다.
          const rowTitle =
            `${p.proto} ${p.port}` +
            (p.process ? ` · ${p.process}` : ` · ${t('mon.unknownProc.title')}`) +
            (p.pid ? ` · pid ${p.pid}` : '') +
            (fwd ? ` · → localhost:${fwd.localPort}` : '')
          return (
            <div key={`${p.proto}:${p.port}`} className="prow" title={rowTitle}>
              <span className="pport">{p.port}</span>
              <span className={'pproto' + (p.proto === 'tcp6' ? ' v6' : '')}>{p.proto}</span>
              <span className="pproc">{p.process ?? t('mon.unknownProc')}</span>
              {!fwd && <span className="ppid">{p.pid ?? ''}</span>}
              {fwd && (
                // 배지 클릭 = 해제. 확인 다이얼로그는 없다 — 되돌리기가 1클릭이다.
                // 요청한 번호 그대로면 글리프만 띄운다(포트는 행 왼쪽에 이미 있고, 사이드바가 좁아
                // 배지가 길면 프로세스 이름이 통째로 잘린다). 번호가 달라졌을 때만 그 번호를 적는다.
                <span
                  className={'pfwd' + (fwd.exact ? '' : ' warn')}
                  data-local-port={fwd.localPort}
                  title={`localhost:${fwd.localPort} — ${fwd.exact ? t('fwd.badge.title') : t('fwd.badge.inexact')}`}
                  onClick={() => stopForward(fwd.id)}
                >
                  {fwd.exact ? '⇄' : `⇄ :${fwd.localPort}`}
                </span>
              )}
              {/* 포워딩 유무와 무관하게 [열기] 하나 — 없으면 만들고 곧바로 연다. */}
              <button
                type="button"
                className={'pact' + (fwd ? '' : ' ghost')}
                data-action={fwd ? 'forward.open' : 'forward.create'}
                title={t(fwd ? 'fwd.open.title' : 'fwd.create.title')}
                onClick={() => void openPort(p.port)}
              >
                {t('fwd.open')}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
