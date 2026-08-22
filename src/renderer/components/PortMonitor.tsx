import { useEffect, useState } from 'react'
import type { PortForward, RemotePort } from '@shared/types'
import type { DialogResult, DialogSpec } from './Dialog'
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


// 포워딩 상태 필터. 'free' = 아직 내 PC 로 안 연결한 포트(= 지금 쓰고 있지 않은 것)만 — 서버에
// 뭐가 떠 있는지가 아니라 "내가 아직 안 쓴 게 뭐지"를 찾을 때 쓴다.
export type PortUse = 'any' | 'fwd' | 'free'

/** 브라우저로 열어 볼 만한 포트. 힌트일 뿐이라 목록을 늘리지 않는다(넓히면 힌트가 아니게 된다). */
const WEB_PORTS = new Set([80, 443, 3000, 3001, 4200, 5000, 5173, 8000, 8080, 8081, 8443, 9000])

/** 사용자가 입력한 범위(비워 두면 제한 없음). */
export type PortSpan = { min: number | null; max: number | null }

export type PortFilterResult = { visible: RemotePort[] }

/** 표에 그릴 한 줄. protos 가 둘이면 tcp·tcp6 를 합친 줄이다. */
export type PortRow = { port: number; protos: RemotePort['proto'][]; pid?: number; process?: string }

/**
 * tcp/tcp6 병합(순수 함수 · 단위 테스트 대상).
 *
 * **같은 프로세스일 때만 합친다.** 포트가 같아도 pid·프로세스가 다르면 서로 다른 둘이고,
 * 합치면 표가 거짓말을 한다. 입력 순서(포트 오름차순)는 그대로 유지한다.
 */
export function mergeProtos(ports: readonly RemotePort[]): PortRow[] {
  const out: PortRow[] = []
  const at = new Map<string, PortRow>()
  for (const p of ports) {
    const k = `${p.port} ${p.pid ?? ''} ${p.process ?? ''}`
    const hit = at.get(k)
    if (hit) {
      if (!hit.protos.includes(p.proto)) hit.protos.push(p.proto)
      continue
    }
    const row: PortRow = {
      port: p.port,
      protos: [p.proto],
      ...(p.pid !== undefined ? { pid: p.pid } : {}),
      ...(p.process !== undefined ? { process: p.process } : {})
    }
    at.set(k, row)
    out.push(row)
  }
  return out
}

// 순수 함수(단위 테스트 대상). 정렬은 이미 parsePorts(main)가 포트 번호 오름차순으로 끝냈다 — 여기선 거르기만.
// 조건은 전부 AND — 좁히는 도구지 넓히는 도구가 아니다.
/**
 * 2026-08-18(제보 ②): **범위 세그([사용자 포트|전체])를 걷었다.**
 * 1024 라는 경계를 앱이 정해 놓고 그 아래를 기본으로 감췄는데, 정작 사람이 자주 찾는 포트
 * (22·443)가 거기 있었다. 감출지 말지는 사용자가 **범위 입력**으로 직접 정한다 — 같은 일을
 * 더 정확히 하는 컨트롤이 이미 옆에 있었다.
 */
export function filterPorts(
  ports: readonly RemotePort[],
  query: string,
  span: PortSpan = { min: null, max: null },
  use: PortUse = 'any',
  forwardedPorts: readonly number[] = []
): PortFilterResult {
  const q = query.trim().toLowerCase()
  const fwd = new Set(forwardedPorts)
  const visible = ports.filter((p) => {
    if (q && !(String(p.port).includes(q) || (p.process ?? '').toLowerCase().includes(q))) return false
    if (span.min !== null && p.port < span.min) return false
    if (span.max !== null && p.port > span.max) return false
    if (use === 'fwd' && !fwd.has(p.port)) return false
    if (use === 'free' && fwd.has(p.port)) return false
    return true
  })
  return { visible: [...visible] }
}

/** 입력칸 문자열 → 포트 번호(빈 값·숫자 아님·범위 밖이면 null = 제한 없음). */
export function parsePortInput(v: string): number | null {
  const n = Number(v.trim())
  return Number.isInteger(n) && n >= 0 && n <= 65535 && v.trim() !== '' ? n : null
}

/**
 * 이 표의 행에 붙일 포워딩 — **이 세션 것만**(2026-08-22 준영님 제보 17번 "포트 충돌").
 *
 * `forward.list()` 는 **모든 세션**의 포워딩을 준다(main 이 하나의 목록으로 갖고 있다). 그걸
 * 세션으로 안 거르고 remotePort 로만 맞추고 있었다 — A 서버의 8000 을 포워딩해 두면 **B 서버의
 * 8000 행에도** "→ localhost:8000" 배지가 뜨고, [열기]를 누르면 A 서버 화면이 열렸다.
 * 포트 번호는 서버마다 겹치는 게 정상이라(3000·8080…) 흔히 걸린다.
 */
export function ownForward(
  forwards: readonly PortForward[],
  sessionId: string | null,
  remotePort: number
): PortForward | undefined {
  return forwards.find((f) => f.sessionId === sessionId && f.remotePort === remotePort)
}

/**
 * 그 **로컬** 포트를 이미 차지하고 있는 남의 포워딩(없으면 undefined).
 * 내 PC 의 포트는 하나뿐이라 A 서버가 8000 을 쓰고 있으면 B 서버의 8000 은 그 번호로 못 연다.
 * 이걸 미리 찾아 **누가 쓰는지 이름과 함께** 묻는다 — 조용히 임의 포트로 넘어가면 사용자는
 * "왜 주소가 54321 이지"만 보게 된다.
 */
export function portConflict(
  forwards: readonly PortForward[],
  sessionId: string | null,
  localPort: number
): PortForward | undefined {
  return forwards.find((f) => f.sessionId !== sessionId && f.localPort === localPort)
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
  /** 독립 창 안에서 그리는 중인가 — [창으로 빼기] 를 그 창에 또 두지 않는다. */
  inWindow?: boolean
  /** 포트 충돌을 물을 때 쓴다(제보 17). 없으면 묻지 않고 예전처럼 임의 포트로 넘어간다. */
  ask?: (spec: DialogSpec) => Promise<DialogResult>
}

export function PortMonitor({
  ports,
  forwards,
  sessionId,
  isSsh,
  onRefresh,
  onForwardsChanged,
  inWindow,
  ask
}: PortMonitorProps) {
  // FB-0003: 세션을 바꿔도 사용자가 고른 필터는 유지한다 — 서버마다 매번 다시 고르게 하지 않는다.
  const [query, setQuery] = useState('')
  const [minStr, setMinStr] = useState('')
  const [maxStr, setMaxStr] = useState('')
  const [use, setUse] = useState<PortUse>('any')
  // 지금 내장 브라우저에 떠 있는 오리진들. **버튼 라벨의 진실은 브라우저 쪽에 있다**
  // (2026-08-22 준영님 제보 1번: "브라우저창 또는 탭 닫으면 열기가 닫기로 변경").
  // 포워딩 유무로 라벨을 정하던 예전 방식은 브라우저를 닫아도 그대로였다 — 포워딩은 살아 있으니까.
  const [openOrigins, setOpenOrigins] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const off = window.ev?.browserTabs.onTabs((e) => setOpenOrigins(new Set(e.tabs.map((x) => x.origin))))
    return () => off?.()
  }, [])

  if (!isSsh) return <span className="sb-placeholder">{t('mon.needSsh')}</span>

  const span = { min: parsePortInput(minStr), max: parsePortInput(maxStr) }
  // 필터도 **이 세션의** 포워딩만 센다 — 남의 포워딩 때문에 이 서버의 포트가 "이미 쓴 것"으로 접히면 안 된다.
  const mine = forwards.filter((f) => f.sessionId === sessionId)
  const { visible } = filterPorts(ports, query, span, use, mine.map((f) => f.remotePort))
  const fwdOf = (port: number): PortForward | undefined => ownForward(forwards, sessionId, port)

  /** 그 포워딩을 브라우저에서 여는 주소. 오리진 비교에도 이 값을 쓴다(같은 규칙 한 곳). */
  const urlOf = (f: PortForward): string => `http://localhost:${f.localPort}`
  /** 이 행이 지금 브라우저에 떠 있는가 — 포워딩이 있고 그 주소의 탭이 살아 있을 때만. */
  const isOpen = (fwd: PortForward | undefined): boolean => Boolean(fwd && openOrigins.has(urlOf(fwd)))

  // [열기] 한 번으로 끝낸다. 포워딩이 없으면 만들고 나서 그 로컬 포트를 연다 —
  // 예전엔 ↗(만들기)를 누른 **다음** [열기]를 눌러야 해서 두 번 클릭이었다(준영님 제보).
  const openPort = async (port: number): Promise<void> => {
    const existing = fwdOf(port)
    if (existing) {
      void window.ev?.browser.open(urlOf(existing))
      return
    }
    if (!sessionId) return
    /**
     * 2026-08-22 준영님 제보 17번 — **포트 충돌은 물어본다.**
     * 내 PC 의 8000 은 하나뿐이라 다른 서버가 이미 쓰고 있으면 그 번호로 못 연다. 예전엔 조용히
     * 임의 포트(54321 같은)로 넘어가서, 사용자는 왜 주소가 이상한지 알 수 없었다. 누가 쓰는지
     * 이름을 대고 세 갈래를 준다: 뺏기 / 다른 포트로 / 그만두기.
     */
    const clash = portConflict(forwards, sessionId, port)
    let exact = false
    if (clash) {
      const who = clash.sessionTitle || t('mon.clash.other')
      const r = await ask?.({
        title: t('mon.clash.title'),
        message: t('mon.clash.msg'),
        detail: [
          { label: t('mon.clash.port'), value: String(port) },
          { label: t('mon.clash.owner'), value: `${who} (${clash.remotePort})` }
        ],
        confirmLabel: t('mon.clash.take'),
        altLabel: t('mon.clash.other.port')
      })
      if (!r || r === 'cancel') return
      if (r === 'confirm') {
        await window.ev?.forward.stop(clash.id).catch(() => null)
        exact = true // 뺏기로 했으면 그 번호여야 한다 — 또 임의 포트로 새면 뺏은 뜻이 없다
      }
    }
    const res = await window.ev?.forward.create(sessionId, port, exact).catch(() => null)
    onForwardsChanged()
    if (res && res.ok) void window.ev?.browser.open(urlOf(res.forward))
    // 실패는 말한다 — 예전엔 아무 일도 안 일어나 "눌렀는데 안 되네"로 끝났다.
    // res 가 null 인 경우(호출 자체가 거절)까지 덮는다: 사유를 모를 때도 침묵하지 않는다.
    else await ask?.({ title: t('fwd.fail.title'), message: res?.message ?? t('fwd.fail.generic'), cancelLabel: null })
  }

  // [닫기] — **브라우저만** 닫는다. 포워딩은 남겨 둔다: 다시 [열기]를 누르면 바로 열리고,
  // 터널을 끊는 것은 별개 동작이다(행 왼쪽 초록 표시가 터널이 살아 있음을 말한다).
  // 탭이 하나뿐이면 창까지 닫히는 것은 브라우저 쪽 기존 규칙이다(closeTabByOrigin 주석).
  const closePort = (fwd: PortForward): void => {
    void window.ev?.browserTabs.closeOrigin(urlOf(fwd)).catch(() => null)
  }
  const stopForward = (id: string): void => {
    void window.ev?.forward
      .stop(id)
      .catch(() => null)
      .then(onForwardsChanged)
  }

  return (
    // **2026-08-17 제보 ⑥ — 컨트롤을 한 줄로.**
    // 이 화면은 우측 레일(폭 264px) 시절 모양을 그대로 갖고 있었다: 제목줄·검색줄·필터줄·필터줄
    // 넷이 각각 한 층씩 쌓여, 세로 260px 짜리 하단 패널에서 **목록에 남는 높이가 70px**(행 두 개)
    // 이었다. 아래는 세로가 귀하고 가로가 남는다 — 쌓여 있던 것을 옆으로 편다.
    <div className="pmon">
      <div className="pmon-bar">
        <span className="pmon-title">{t('mon.title')}</span>
        <span className="pmon-count">{visible.length}</span>
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
        {/* 번호 구간 + 포워딩 상태. 둘 다 비워 두면 아무 것도 안 거른다(기본값 = 지금까지와 같은 화면). */}
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
        <div className="sb-tab-spacer" />
        {/* 독립 창으로 빼기(2026-08-21). **그 창 안에서는 안 보인다** — 이미 거기다.
            창은 하나뿐이라 두 번 눌러도 새 창이 생기지 않고 있는 창이 앞으로 온다. */}
        {!inWindow && (
          <button
            type="button"
            className="tw-tool"
            data-action="portwin.open"
            title={t('portwin.open.title')}
            onClick={() => void window.ev?.portwin.open().catch(() => {})}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M14 4h6v6M20 4l-8 8" />
              <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
            </svg>
          </button>
        )}
        <button type="button" className="tw-tool" data-action="mon.refresh" title={t('sftp.refresh')} onClick={onRefresh}>
          <IconRefresh />
        </button>
      </div>
      {/* 2026-08-21: 목록 → **표**. 다른 하단 도구(프로세스·서비스·디스크)는 전부 표라
          가로를 쓰는데 여기만 좁은 판 절충안이 남아 있었다. 열이 생기면서 그동안 숨겨 뒀던
          셋이 도로 나온다: 포워딩 중 접히던 PID · ⇄ 툴팁에만 있던 목적지 · 글리프였던 해제. */}
      <div className="pmon-list">
        {ports.length === 0 && <div className="sftp-empty">{t('mon.empty')}</div>}
        {ports.length > 0 && visible.length === 0 && <div className="sftp-empty">{t('mon.noMatch')}</div>}
        {visible.length > 0 && (
          <table className="ptbl">
            <thead>
              <tr>
                <th className="pt-st">{t('mon.col.state')}</th>
                <th className="pt-port r">{t('mon.col.port')}</th>
                <th className="pt-proto">{t('mon.col.proto')}</th>
                <th className="pt-proc">{t('mon.col.proc')}</th>
                <th className="pt-pid r">PID</th>
                <th className="pt-dest">{t('mon.col.dest')}</th>
                <th className="pt-act" />
              </tr>
            </thead>
            <tbody>
              {mergeProtos(visible).map((p) => {
                const fwd = fwdOf(p.port)
                return (
                  <tr key={`${p.port}:${p.pid ?? ''}:${p.process ?? ''}`} className={fwd ? 'fwd' : ''}>
                    {/* 준영님 요청: 세션 트리와 **같은 문법**의 초록 점 — 열려 있다는 것을
                        행 맨 왼쪽에서 훑어 잡을 수 있게. */}
                    <td className="pt-st">
                      <span className={'pstate' + (fwd ? ' on' : '')}>
                        <i />
                        {t(fwd ? 'mon.state.open' : 'mon.state.closed')}
                      </span>
                    </td>
                    <td className="pt-port r">
                      {p.port}
                      {WEB_PORTS.has(p.port) && <span className="pweb">web</span>}
                    </td>
                    {/* 합쳐진 줄은 `tcp · tcp6`. 어느 스택으로 뜬 것인지가 사라지면 안 된다 —
                        방화벽·바인드 주소를 볼 때 그게 답인 경우가 있다. */}
                    <td className="pt-proto">{p.protos.join(' · ')}</td>
                    <td className={'pt-proc' + (p.process ? '' : ' unk')}>{p.process ?? t('mon.unknownProc')}</td>
                    <td className="pt-pid r">{p.pid ?? '—'}</td>
                    <td className="pt-dest">
                      {fwd ? (
                        <span className="pdest">
                          localhost:{fwd.localPort}
                          {!fwd.exact && <span className="pwarn"> {t('mon.dest.inexact')}</span>}
                        </span>
                      ) : (
                        <span className="pdest none">—</span>
                      )}
                    </td>
                    <td className="pt-act">
                      {/* 2026-08-22 준영님 제보 1번: 버튼은 **하나**이고 브라우저 상태를 따라 뒤집힌다.
                          [열기] → 필요하면 터널을 만들고 내장 브라우저로. 떠 있으면 [닫기].
                          예전엔 라벨이 포워딩 유무로 갈려서, 브라우저를 닫아도 [브라우저]인 채였다
                          (터널은 살아 있으니까) — 사용자가 보는 것은 창이지 터널이 아니다. */}
                      {isOpen(fwd) && fwd ? (
                        <button
                          type="button"
                          className="pbtn pri"
                          data-action="browser.close"
                          data-local-port={fwd.localPort}
                          title={t('fwd.close.title')}
                          onClick={() => closePort(fwd)}
                        >
                          {t('fwd.close')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="pbtn"
                          data-action={fwd ? 'forward.open' : 'forward.create'}
                          title={t(fwd ? 'fwd.open.title' : 'fwd.create.title')}
                          onClick={() => void openPort(p.port)}
                        >
                          {t('fwd.open')}
                        </button>
                      )}
                      {/* 터널 해제는 남겨 둔다 — [닫기]는 창을 닫을 뿐이라 터널을 끊을 자리가 따로
                          있어야 한다. 주된 동작이 아니므로 톤만 낮춘다. */}
                      {fwd && (
                        <button
                          type="button"
                          className="pbtn dgr"
                          data-action="forward.stop"
                          data-local-port={fwd.localPort}
                          title={t('fwd.stop.title')}
                          onClick={() => stopForward(fwd.id)}
                        >
                          {t('fwd.stop')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
