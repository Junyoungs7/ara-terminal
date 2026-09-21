import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cpuPercent,
  ctrNeedsRoot,
  ctrSudoFailed,
  parseCtrList,
  sortContainers,
  type CmdId,
  type CtrPodInfo,
  type CtrRow,
  type CtrRuntime
} from '@shared/remoteCatalog'
import { t } from '../i18n'
import { remoteError } from '../store/remoteState'

// 컨테이너 탭과 쿠버네티스 탭이 **함께 쓰는 것**만 여기 둔다(2026-08-24 탭 분리).
// 두 탭은 보여 주는 것이 다르지만 가져오는 방식은 같다: 5초 폴링 · 막히면 이유 한 줄 ·
// 권한 벽이면 [관리자 권한으로 보기] · CPU 는 두 표본을 빼서 낸다.
// 이 파일을 나누지 않으면 그 규칙이 두 벌이 되고, 다음 제보 때 한쪽만 고쳐진다.

/** 컨테이너는 초 단위로 뜨고 지지 않는다 — 프로세스(2.5초)보다 느리게 본다. */
export const POLL_MS = 5000

/**
 * 권한을 올린 서버(준영님 요청 — "모니터링 버튼만 누르면 바로").
 * **앱이 켜져 있는 동안** 기억한다: 한 번 누르면 그 서버의 다른 탭·다시 연 탭도 바로 목록을 받는다.
 * 비밀번호는 여기 없다 — main 이 vault 에서 꺼내 stdin 으로 넣는다. 담기는 건 서버 이름뿐이다.
 * (앱을 껐다 켜면 한 번 더 눌러야 한다. 영속이 필요하면 설정에 한 줄 얹으면 된다.)
 */
export const ELEVATED = new Set<string>()

/**
 * 런타임 오류 한 줄에서 **알맹이만** 남긴다(준영님: "불필요한 로그 제거").
 *
 * crictl 은 이렇게 뱉는다 —
 *   `time="…" level=fatal msg="validate service connection: … rpc error: … connect: permission denied"`
 * 앞의 `time=/level=/msg=` 는 사람에게 아무 정보가 아니고, 가운데 중첩된 설명은 같은 말의 반복이다.
 * Go 오류는 **원인이 맨 끝**에 오므로 길면 마지막 두 마디만 남긴다. 통째로는 title 에 남아 있다.
 */
export function tidyReason(raw: string): string {
  let s = raw
    .replace(/^time="[^"]*"\s*/i, '')
    .replace(/^level=\w+\s*/i, '')
    .replace(/^msg=/i, '')
    .trim()
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  s = s.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim()
  if (s.length <= 90) return s
  const parts = s.split(/:\s+/).filter((x) => x !== '')
  return parts.length > 2 ? '… ' + parts.slice(-2).join(': ') : s.slice(-90)
}

/** 서버가 남긴 첫 줄 — 왜 거절했는지는 그 문장에만 있다(빈 줄은 건너뛴다). */
export function firstLineOf(out: string): string {
  return (
    out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  )
}

/**
 * 막힌 상태 — 표 대신 가운데에 그린다.
 * `raw` 는 서버 원문이고 **언제나 title 로만** 남는다(진단은 필요하고, 화면은 깨끗해야 한다).
 * `detail` 은 그 원문의 알맹이를 한 줄로 보여 줄지 — 권한 벽처럼 **사람 말로 끝나는 경우엔 끈다**
 * (준영님: "해당 계정은 권한이 없습니다. 관리자 권한으로 보기 버튼 이렇게 해줘").
 */
export type CtrBlocked = { why: string; raw: string; detail: boolean; canElevate: boolean }

export type CtrFeed = {
  rows: CtrRow[]
  pods: CtrPodInfo[]
  runtime: CtrRuntime
  /** 컨테이너 id → CPU 사용률(%). 첫 바퀴에는 비어 있다(0% 라고 말하지 않는다). */
  cpu: Map<string, number>
  blocked: CtrBlocked | null
  /** 목록 자체를 못 받은 경우(세션 끊김 등) — 막힘과 다르다. */
  note: string | null
  /**
   * 첫 한 바퀴가 아직 안 왔다. 이걸 안 보면 두 탭이 마운트 즉시 "컨테이너가 없습니다"를 그린다 —
   * 폴링이 5초라 **탭을 열 때마다 5초간 거짓말**이었다(2026-08-28 감사 ②).
   * 형제 표 넷(프로세스·서비스·디스크·패키지)은 이미 로딩 문구를 먼저 낸다.
   */
  loading: boolean
  elevateNow: () => void
  reload: () => void
}

/**
 * 목록 가져오기 한 벌. cmd 만 다르다 — 컨테이너 탭은 `ctr.list`(docker·podman·crictl + 파드 + 자원),
 * 쿠버네티스 탭은 `k8s.list`(kubectl).
 *
 * `ns` 는 **k8s.list 전용**이다(#192). 객체가 아니라 문자열 하나로 받는 이유: 이 값은 load 의
 * 의존성이라, 객체로 받으면 부모가 memo 를 빠뜨린 순간 렌더마다 새 함수가 되어 폴링이 재설정된다.
 */
export function useCtrList(
  cmd: CmdId,
  sessionId: string | null,
  active: boolean,
  server?: string,
  ns?: string
): CtrFeed {
  const [rows, setRows] = useState<CtrRow[]>([])
  const [pods, setPods] = useState<CtrPodInfo[]>([])
  const [runtime, setRuntime] = useState<CtrRuntime>('docker')
  const [note, setNote] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<CtrBlocked | null>(null)
  // sudo 가 거절한 이유는 **붙잡아 둔다.** 안 그러면 5초 뒤 평범한 폴링이 그 자리를 덮어써서
  // "눌렀는데 잠깐 뭐가 스쳤다"로 끝난다 — 다음에 버튼을 누를 때까지 남긴다.
  const [sudoErr, setSudoErr] = useState<CtrBlocked | null>(null)
  // 한 바퀴가 **어떻게든 끝났는가**(성공·막힘·실패 전부 포함). 결과가 무엇이든 그때부터는
  // 화면이 사실을 말할 수 있다 — 그 전까지만 로딩이다.
  const [loaded, setLoaded] = useState(false)
  const srvKey = `${cmd}:${server ?? sessionId ?? ''}`
  const [elevate, setElevate] = useState(() => ELEVATED.has(srvKey))
  const prevCpu = useRef<{ at: number; ns: Map<string, number> } | null>(null)
  const [cpu, setCpu] = useState<Map<string, number>>(new Map())

  const load = useCallback(() => {
    if (!sessionId) return
    const args = { ...(ns !== undefined ? { ns } : {}), ...(elevate ? { sudo: true } : {}) }
    void window.ev?.remote
      ?.run(sessionId, cmd, Object.keys(args).length > 0 ? args : undefined)
      .then((r) => {
        setLoaded(true)
        if (!r?.ok) {
          // 2026-08-28 감사 ⑥: 전에는 실패 전부를 `console.ctr.error`("컨테이너 목록을 읽지
          // 못했습니다")로 떨어뜨렸다 — 터널이 끊겨도 도커를 탓했다. 형제 다섯이 쓰는 그 판정
          // 함수로 사유를 그대로 옮긴다(noSession → "SSH 세션이 끊어졌습니다").
          setNote(remoteError({ out: '', err: r?.reason ?? 'exec' }, 0))
          return
        }
        // sudo 가 거절했다 — **여기서 즉시 끈다.** 폴링이 5초마다 틀린 비밀번호를 다시 보내면
        // 서버의 실패 카운터가 쌓여 계정이 잠긴다(pam_faillock).
        if (elevate && ctrSudoFailed(r.out)) {
          ELEVATED.delete(srvKey)
          setElevate(false)
          setRows([])
          setNote(null)
          // 버튼은 **남겨 둔다.** sudoers 를 고치거나 비밀번호를 바꾼 뒤 다시 눌러야 하는데,
          // 여기서 버튼을 치우면 탭을 껐다 켜는 수밖에 없다. 자동 재시도가 없을 뿐이다.
          setSudoErr({ why: t('console.ctr.sudo.failed'), raw: firstLineOf(r.out), detail: true, canElevate: true })
          return
        }
        const list = parseCtrList(r.out)
        setRuntime(list.runtime)
        // 런타임이 없는 것과 "컨테이너가 하나도 없는 것"은 다른 이야기다 — 빈 표로 뭉뚱그리지 않는다.
        // 왜 안 되는지는 서버만 안다: 권한인지, 소켓이 없는지, 데몬이 죽었는지가 여기서 갈린다.
        if (list.unavailable) {
          const root = ctrNeedsRoot(list.reason)
          setRows([])
          setNote(null)
          // 화면에는 **사람 말 한 줄**만 둔다(2026-08-24 준영님: `cannot clone: Invalid argument`
          // 같은 런타임 속사정은 읽을 사람이 없다). 어느 런타임이 골라졌는지도 말하지 않는다 —
          // 사용자가 고른 적 없는 이름이고, 못 읽은 건 그 탭의 런타임 전부다.
          // 원문은 raw 로 남아 title(마우스 올림)에만 보인다.
          setBlocked({
            why: root
              ? t('console.ctr.noPerm')
              : list.reason
                ? t(cmd === 'k8s.list' ? 'console.k8s.fail' : 'console.ctr.fail')
                : // 런타임을 아예 못 찾은 것과 찾았는데 실패한 것은 다음 수가 다르다(깔거나 · 고치거나).
                  t(cmd === 'k8s.list' ? 'console.k8s.none.runtime' : 'console.ctr.none.runtime'),
            raw: list.reason ?? '',
            // 2026-08-24 규칙은 "런타임 속사정은 화면에 안 쓴다"(`cannot clone: Invalid argument`
            // 같은 것). 그런데 #192 의 kubectl 은 **사람 말로 답한다** —
            // `Error from server (NotFound): namespaces "vgt-erp" not found` 는 고를 값이
            // 틀렸다는 뜻이고, 그 문장이 안 보이면 셀렉트를 어떻게 고쳐야 할지 알 수 없다.
            // 권한 벽은 예외다(그쪽은 이미 사람 말로 끝난다 — 준영님 문구).
            detail: cmd === 'k8s.list' && !root && list.reason !== null,
            canElevate: !elevate && root
          })
          return
        }
        setNote(null)
        setBlocked(null)
        setRows(sortContainers(list.rows))
        setPods(list.pods)
        // 표본 두 개로 CPU 사용률을 낸다. 첫 바퀴에는 아무 값도 만들지 않는다(0% 는 거짓말이다).
        const now = Date.now()
        const ns = new Map(list.rows.filter((r) => r.cpuNs !== undefined).map((r) => [r.id, r.cpuNs!]))
        const prev = prevCpu.current
        if (prev) {
          const next = new Map<string, number>()
          for (const [id, v] of ns) {
            const p = cpuPercent(prev.ns.get(id), v, now - prev.at)
            if (p !== null) next.set(id, p)
          }
          setCpu(next)
        }
        prevCpu.current = { at: now, ns }
      })
      // IPC 자체가 거절당한 길(하네스·창 파괴 레이스). 사유가 없으니 실행 실패로 본다.
      .catch(() => {
        setLoaded(true)
        setNote(remoteError({ out: '', err: 'exec' }, 0))
      })
  }, [cmd, sessionId, elevate, srvKey, ns])

  // 세션이 바뀌면 이전 서버 목록을 즉시 버린다(F26 CON-8c 규칙).
  //
  // **초기화와 폴링을 한 effect 에 두면 안 된다.** load 는 elevate 가 바뀔 때마다 새 함수가 되는데,
  // 그러면 "권한 실패 → elevate 끔"이 이 초기화를 한 번 더 돌려 **방금 담은 실패 이유를 지운다**
  // (그 자리에 평범한 권한 안내가 돌아와, 눌러도 아무 일 없었던 것처럼 보였다 — 2026-08-24 실측).
  useEffect(() => {
    setRows([])
    setPods([])
    setNote(null)
    setBlocked(null)
    setSudoErr(null)
    setRuntime('docker')
    setCpu(new Map())
    setLoaded(false)
    prevCpu.current = null
    // ns 도 여기 있다(#192): 네임스페이스를 바꾸면 **이전 네임스페이스의 파드를 즉시 버린다.**
    // 안 버리면 다음 한 바퀴(5초)까지 남의 파드가 남아 있고, 그 사이에 [터미널에서 열기]를
    // 누르면 지금 고른 네임스페이스로 없는 파드에 붙는다.
  }, [sessionId, active, ns])

  useEffect(() => {
    if (!active || !sessionId) return
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId, active, load])

  return {
    rows,
    pods,
    runtime,
    cpu,
    // 거절 이유가 있으면 그것이 이긴다 — 다음에 버튼을 누를 때까지.
    blocked: sudoErr ?? blocked,
    note,
    loading: !loaded,
    elevateNow: () => {
      setSudoErr(null)
      ELEVATED.add(srvKey)
      setElevate(true)
    },
    reload: load
  }
}

/**
 * 막혔을 때 표 대신 그리는 가운데 상자 — **한 줄과 버튼 하나**(준영님 요청).
 * 서버가 준 원문은 title 로만 남긴다: 화면을 로그로 덮지 않는다.
 */
export function BlockedBox({ blocked, onElevate }: { blocked: CtrBlocked; onElevate: () => void }): JSX.Element {
  return (
    <div className="con-empty ctr-block">
      <div className="cb-why" title={blocked.raw || undefined}>
        {blocked.why}
        {blocked.detail && blocked.raw !== '' && <span className="cb-detail">{tidyReason(blocked.raw)}</span>}
      </div>
      {/* 설명은 버튼의 툴팁으로 — 화면에 글을 한 줄 더 쌓지 않는다. */}
      {blocked.canElevate && (
        <button
          type="button"
          className="con-btn"
          data-action="ctr.elevate"
          title={t('console.ctr.sudo.hint')}
          onClick={onElevate}
        >
          {t('console.ctr.sudo.btn')}
        </button>
      )}
    </div>
  )
}

/**
 * 툴바 끝의 물음표 — 설명을 **한 줄 차지하지 않고** 준다(준영님: "이게 한 줄을 잡아먹는다").
 * 긴 안내는 화면에 상주할 가치가 없다: 한 번 읽으면 그만인 글이다.
 */
export function HelpTip({ text }: { text: string }): JSX.Element {
  return (
    <span className="con-help" title={text} aria-label={text} role="note">
      ?
    </span>
  )
}
